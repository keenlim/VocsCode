/**
 * Project-level subagent definitions: the set a repo's sessions actually run with.
 *
 * Definitions are files in `<projectRoot>/.pi/agents`, ignored by git the moment the first one is
 * written and shareable one at a time. The shipped templates are offered as starting points; a
 * project file replaces a template outright, so copying one is how you customize it.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { SessionMeta } from '../../../shared/types';
import type { AgentTemplate, ProjectAgent, ProjectAgentInfo } from '../../../shared/agent-info';
import { AGENT_TOOL_NAMES, type AgentFileFields } from '../../../shared/agent-files';
import { invoke } from '../api';
import { Badge, Button, Field, Icon, Spinner, Toggle } from './ui';

interface Draft extends AgentFileFields {
  prompt: string;
  /** True while editing an existing definition (its name is the key, so it cannot change). */
  existing: boolean;
}

const emptyDraft = (): Draft => ({ name: '', description: '', tools: ['read', 'grep', 'find', 'ls'], promptMode: 'append', mcp: true, prompt: '', existing: false });

const draftFrom = (agent: { name: string; description: string; tools: string[]; model?: string; promptMode: 'append' | 'replace'; mcp: boolean }, prompt: string): Draft => ({
  name: agent.name,
  description: agent.description,
  tools: agent.tools,
  ...(agent.model ? { model: agent.model } : {}),
  promptMode: agent.promptMode,
  mcp: agent.mcp,
  prompt,
  existing: true,
});

export function SubagentAgents({ session }: { session: SessionMeta }) {
  const [info, setInfo] = useState<ProjectAgentInfo | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void invoke('agents:list', { id: session.id })
      .then((result) => setInfo(result && Array.isArray(result.agents) ? result : { agents: [], templates: [], git: false, ignored: false }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [session.id]);
  useEffect(load, [load]);

  const openAgent = (agent: ProjectAgent) => {
    void invoke('agents:get', { id: session.id, name: agent.name }).then((parsed) => {
      setDraft(parsed ? draftFrom(parsed.fields, parsed.prompt) : draftFrom(agent, ''));
    });
  };

  const openTemplate = (template: AgentTemplate) => setDraft({ ...draftFrom(template, template.prompt), name: '', existing: false });

  const save = () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const fields: AgentFileFields = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      tools: draft.tools,
      ...(draft.model?.trim() ? { model: draft.model.trim() } : {}),
      promptMode: draft.promptMode,
      mcp: draft.mcp,
    };
    void invoke('agents:save', { id: session.id, fields, prompt: draft.prompt })
      .then((result) => {
        setBusy(false);
        if (!result.ok) setError(result.error ?? 'Could not save the definition.');
        else {
          setDraft(null);
          load();
        }
      })
      .catch((e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  const remove = (name: string) => {
    setBusy(true);
    void invoke('agents:delete', { id: session.id, name })
      .then(() => {
        setBusy(false);
        setDraft(null);
        load();
      })
      .catch((e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  const setTracked = (name: string, tracked: boolean) => {
    setBusy(true);
    void invoke('agents:track', { id: session.id, name, tracked })
      .then((result) => {
        setBusy(false);
        if (!result.ok) setError(result.error ?? 'Could not change the git state.');
        else load();
      })
      .catch((e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  if (!info) {
    return (
      <div className="subagents">
        <div className="panel-empty">
          <Spinner size={16} /> Loading definitions…
        </div>
      </div>
    );
  }

  return (
    <div className="subagents">
      {error && <div className="callout warn small">{error}</div>}
      <div className="agent-guidance muted small">
        Definitions live in <code>{`.pi/agents`}</code> in this project. New ones stay local: Vocs Code adds{' '}
        <code>.pi/agents/*</code> to the repo&rsquo;s <code>.gitignore</code>, and <em>Track</em> shares a single one with the team.
      </div>
      {draft ? (
        <AgentEditor
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={save}
          onDelete={draft.existing ? () => remove(draft.name) : undefined}
          busy={busy}
        />
      ) : (
        <>
          <div className="agent-section-head">
            <span>In this project</span>
            <span className="spacer" />
            <Button size="sm" variant="ghost" icon="plus" onClick={() => setDraft(emptyDraft())}>
              New
            </Button>
          </div>
          {info.agents.length === 0 ? (
            <div className="panel-empty">
              <Icon name="fork" size={20} />
              <p>No project definitions yet.</p>
              <p className="muted small">The shipped templates below are what sessions use until you customize one.</p>
            </div>
          ) : (
            <ul className="agent-grid" data-testid="project-agents">
              {info.agents.map((agent) => (
                <li key={agent.name}>
                  <div className={`agent-tile ${agent.tracked ? 'tracked' : ''}`} data-testid={`agent-${agent.name}`}>
                    <button type="button" className="agent-tile-main" onClick={() => openAgent(agent)}>
                      <span className="agent-tile-head">
                        <Icon name="fork" size={12} />
                        <span className="subagent-agent">{agent.name}</span>
                        <span className="spacer" />
                        <Badge tone={agent.tracked ? 'green' : 'neutral'}>{agent.tracked ? 'shared' : 'local'}</Badge>
                      </span>
                      <span className="subagent-desc">{agent.description || 'No description'}</span>
                      <span className="subagent-meta muted small">
                        {agent.tools.length} tool{agent.tools.length === 1 ? '' : 's'} · {agent.model ?? 'session model'} · {agent.promptMode === 'replace' ? 'own prompt' : 'extends parent'}
                      </span>
                    </button>
                    {info.git && (
                      <button type="button" className="agent-tile-track" title={agent.tracked ? 'Keep this definition local' : 'Commit this definition for the team'} onClick={() => setTracked(agent.name, !agent.tracked)}>
                        {agent.tracked ? 'Untrack' : 'Track'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="agent-section-head">
            <span>Templates</span>
            <span className="spacer" />
          </div>
          <ul className="agent-grid" data-testid="agent-templates">
            {info.templates.map((template) => (
              <li key={template.name}>
                <button type="button" className="agent-tile agent-tile-main" onClick={() => openTemplate(template)} title="Copy this template into the project">
                  <span className="agent-tile-head">
                    <Icon name="fork" size={12} />
                    <span className="subagent-agent">{template.name}</span>
                    <span className="spacer" />
                    <Badge tone="blue">template</Badge>
                  </span>
                  <span className="subagent-desc">{template.description}</span>
                  <span className="subagent-meta muted small">Copy to customize</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function AgentEditor({
  draft,
  onChange,
  onCancel,
  onSave,
  onDelete,
  busy,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete?: () => void;
  busy: boolean;
}) {
  const patch = (next: Partial<Draft>) => onChange({ ...draft, ...next });
  const toggleTool = (tool: string) => patch({ tools: draft.tools.includes(tool) ? draft.tools.filter((t) => t !== tool) : [...draft.tools, tool] });
  return (
    <div className="agent-editor">
      <Field label="Name" hint={draft.existing ? 'The file name; rename by creating a new one.' : 'Used as the type in the subagent tool, e.g. reviewer'}>
        <input value={draft.name} disabled={draft.existing} placeholder="reviewer" onChange={(e) => patch({ name: e.target.value })} />
      </Field>
      <Field label="Description" hint="The model picks a subagent from this line, so say when to use it.">
        <input value={draft.description} placeholder="Reviews a diff against the repo rules" onChange={(e) => patch({ description: e.target.value })} />
      </Field>
      <Field label="Tools">
        <div className="agent-tools">
          {AGENT_TOOL_NAMES.map((tool) => (
            <Toggle key={tool} checked={draft.tools.includes(tool)} onChange={() => toggleTool(tool)} label={tool} />
          ))}
        </div>
      </Field>
      <Field label="Model" hint="Empty inherits the session model; a pin makes the repo depend on that provider.">
        <input value={draft.model ?? ''} placeholder="provider/model-id" onChange={(e) => patch(e.target.value ? { model: e.target.value } : { model: undefined })} />
      </Field>
      <Field label="Prompt">
        <select value={draft.promptMode} onChange={(e) => patch({ promptMode: e.target.value === 'replace' ? 'replace' : 'append' })}>
          <option value="append">Extend the parent's system prompt</option>
          <option value="replace">Replace the system prompt</option>
        </select>
      </Field>
      <Field label="MCP servers">
        <Toggle checked={draft.mcp} onChange={(v) => patch({ mcp: v })} label="Inherit this session's MCP servers" />
      </Field>
      <Field label="Instructions">
        <textarea rows={10} value={draft.prompt} placeholder="You review diffs and report findings…" onChange={(e) => patch({ prompt: e.target.value })} />
      </Field>
      <div className="agent-editor-actions">
        <Button size="sm" onClick={onSave} disabled={busy || !draft.name.trim() || !draft.description.trim()}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <span className="spacer" />
        {onDelete && (
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy}>
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}
