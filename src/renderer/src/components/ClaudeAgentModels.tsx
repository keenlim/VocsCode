/**
 * The model each Claude subagent type runs on, and the project definitions behind them.
 *
 * Claude's default here is the session's own model, applied for the whole session by the adapter, so
 * this list is mostly an account of what already happens. The exception is a definition the project
 * supplies in `.claude/agents`: Claude Code lets it pin a model, and a pinned definition also stops
 * the adapter forcing the session model on everything else — which is worth saying out loud, because
 * on a provider that is not Anthropic the unforced built-ins ask for Anthropic ids and are refused.
 *
 * The panel creates a definition, but only a genuinely new one: writing a name a built-in or an
 * existing file already has would *replace* it, instructions and all, not adjust it. Everything else
 * about an existing definition stays its author's — the panel rewrites the `model:` line alone.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionMeta } from '../../../shared/types';
import type { ClaudeAgentTypesInfo } from '../../../shared/ipc';
import { isClaudeBuiltinAgentType } from '../../../shared/claude-agent-files';
import { useSessionModels } from '../models';
import { invoke } from '../api';
import { Badge, Button, Field, Icon, Spinner } from './ui';

interface Row {
  name: string;
  description: string;
  file?: ClaudeAgentTypesInfo['files'][number];
}

interface Draft {
  name: string;
  description: string;
  prompt: string;
}

const emptyDraft = (): Draft => ({ name: '', description: '', prompt: '' });

export function ClaudeAgentModels({ session }: { session: SessionMeta }) {
  const [info, setInfo] = useState<ClaudeAgentTypesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const { models } = useSessionModels(session);

  const load = useCallback(() => {
    void invoke('claude-agents:list', { id: session.id })
      .then((result) => setInfo(result && Array.isArray(result.files) ? result : { types: [], files: [], sessionModel: null, forced: true }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [session.id]);
  useEffect(load, [load]);

  // A project definition can name a type the engine also lists; one row per name, file first.
  const rows = useMemo<Row[]>(() => {
    const byName = new Map<string, Row>();
    for (const type of info?.types ?? []) byName.set(type.name, { name: type.name, description: type.description });
    for (const file of info?.files ?? []) {
      const seen = byName.get(file.name);
      byName.set(file.name, { name: file.name, description: seen?.description ?? file.description, file });
    }
    return [...byName.values()];
  }, [info]);

  const save = (name: string, model: string) => {
    setBusy(name);
    void invoke('claude-agents:setModel', { id: session.id, name, model: model || null })
      .then((result) => {
        setBusy(null);
        if (!result.ok) setError(result.error ?? 'Could not save the model.');
        else {
          setError(null);
          load();
        }
      })
      .catch((e: unknown) => {
        setBusy(null);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  const create = () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    void invoke('claude-agents:create', { id: session.id, name: draft.name.trim(), description: draft.description.trim(), prompt: draft.prompt })
      .then((result) => {
        setSaving(false);
        if (!result.ok) setError(result.error ?? 'Could not create the definition.');
        else {
          setDraft(null);
          load();
        }
      })
      .catch((e: unknown) => {
        setSaving(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  if (!info) {
    return (
      <div className="subagents">
        <div className="panel-empty">
          <Spinner size={16} /> Loading agent types…
        </div>
      </div>
    );
  }

  // The session's provider is the endpoint these types are served by, so it is the only honest set
  // of choices; a model from elsewhere would be sent to an endpoint that does not host it.
  const provider = session.config.model?.provider ?? session.activeModel?.provider;
  const offered = models.filter((m) => m.provider === provider);
  // A session that has named no model yet has no provider to narrow by, and an empty select would
  // be worse than a wide one: "Same as session" is still the default and the honest answer.
  const choices = offered.length ? offered : models;
  const taken = new Set((info.files ?? []).map((file) => file.name.toLowerCase()));
  const draftName = draft?.name.trim().toLowerCase() ?? '';
  const draftBuiltin = draft ? isClaudeBuiltinAgentType(draft.name) || (info.types ?? []).some((type) => type.name.toLowerCase() === draftName) : false;

  return (
    <div className="subagents">
      {error && <div className="callout warn small">{error}</div>}
      <div className="agent-guidance muted small">
        Delegated agents run on <strong>{info.sessionModel ?? 'the session model'}</strong> — the model this session uses — unless a definition below pins another.
      </div>
      {!info.forced && (
        <div className="callout warn small">
          A definition in <code>.claude/agents</code> pins a model, so Claude Code is no longer held to the session model for the rest of its built-in
          types. Those will ask this endpoint for Anthropic models and be refused; pin them here too, or clear the pin.
        </div>
      )}
      {draft ? (
        <ClaudeAgentEditor
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={create}
          busy={saving}
          taken={taken.has(draftName)}
          builtin={draftBuiltin}
        />
      ) : (
        <>
          <div className="agent-section-head">
            <span>Definitions in this project</span>
            <span className="spacer" />
            <Button size="sm" variant="ghost" icon="plus" data-testid="claude-agent-new" onClick={() => setDraft(emptyDraft())}>
              New
            </Button>
          </div>
          {rows.length === 0 ? (
            <div className="panel-empty">
              <Icon name="fork" size={20} />
              <p>This project defines no Claude agents.</p>
              <p className="muted small">
                Create one above, or add <code>.claude/agents/&lt;Name&gt;.md</code> by hand. A definition adds a type the session can delegate to, and
                its model can be set here.
              </p>
            </div>
          ) : (
            <ul className="agent-grid" data-testid="claude-agent-types">
              {rows.map((row) => (
                <li key={row.name}>
                  <div className="agent-tile" data-testid={`claude-agent-${row.name}`}>
                    <span className="agent-tile-head">
                      <Icon name="fork" size={12} />
                      <span className="subagent-agent">{row.name}</span>
                      <span className="spacer" />
                      {busy === row.name ? <Spinner size={11} /> : <Badge tone={row.file ? 'blue' : 'neutral'}>{row.file ? 'project' : 'built-in'}</Badge>}
                    </span>
                    <span className="subagent-desc">{row.description || 'No description'}</span>
                    {row.file ? (
                      <select
                        className="agent-model-select"
                        value={row.file.model ?? ''}
                        disabled={busy === row.name}
                        data-testid={`claude-agent-model-${row.name}`}
                        aria-label={`Model for ${row.name}`}
                        onChange={(e) => save(row.name, e.target.value)}
                      >
                        <option value="">Same as session</option>
                        {choices.map((m) => (
                          <option key={`${m.provider}/${m.id}`} value={m.id}>
                            {m.displayName || m.id}
                          </option>
                        ))}
                        {/* A pin the catalog no longer offers still has to be visible, or saving would drop it. */}
                        {row.file.model && !choices.some((m) => m.id === row.file?.model) && <option value={row.file.model}>{row.file.model}</option>}
                      </select>
                    ) : (
                      <span className="subagent-meta muted small">Runs on the session model · define it in the project to pin a model</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** The name, description and instructions of a definition the panel is about to write. */
function ClaudeAgentEditor({
  draft,
  onChange,
  onCancel,
  onSave,
  busy,
  taken,
  builtin
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
  /** The project already has a definition with this name; saving would overwrite it. */
  taken: boolean;
  /** The name belongs to a built-in, which the definition would replace rather than extend. */
  builtin: boolean;
}) {
  const patch = (next: Partial<Draft>) => onChange({ ...draft, ...next });
  const blocked = taken || builtin;
  return (
    <div className="agent-editor">
      <Field label="Name" hint="The type the subagent tool uses, e.g. reviewer">
        <input value={draft.name} placeholder="reviewer" data-testid="claude-agent-new-name" onChange={(e) => patch({ name: e.target.value })} />
      </Field>
      {builtin && (
        <div className="callout warn small" data-testid="claude-agent-new-builtin">
          {draft.name.trim()} is one of Claude Code&rsquo;s built-in types: a definition named after it replaces it. Pick another name, or write that file by hand.
        </div>
      )}
      {taken && !builtin && (
        <div className="callout warn small" data-testid="claude-agent-new-taken">
          This project already defines {draft.name.trim()}. Edit it in the list instead.
        </div>
      )}
      <Field label="Description" hint="Claude Code picks a subagent from this line, so say when to use it.">
        <input value={draft.description} placeholder="Reviews a diff against the repo rules" data-testid="claude-agent-new-description" onChange={(e) => patch({ description: e.target.value })} />
      </Field>
      <Field label="Instructions">
        <textarea
          rows={8}
          value={draft.prompt}
          placeholder="You review diffs and report findings…"
          data-testid="claude-agent-new-prompt"
          onChange={(e) => patch({ prompt: e.target.value })}
        />
      </Field>
      <div className="agent-editor-actions">
        <Button size="sm" disabled={busy || blocked || !draft.name.trim() || !draft.description.trim()} onClick={onSave} data-testid="claude-agent-new-save">
          Create
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
