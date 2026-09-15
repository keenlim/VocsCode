/**
 * @vitest-environment jsdom
 *
 * Offline tests for the Claude agent-model rows: what the panel offers, what a change sends, and the
 * one thing it must not do — pin a model on a built-in, which would need a definition file and would
 * take that built-in's instructions with it. So a row without a project definition has no control,
 * and the warning about a project's own pins is shown when they exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ClaudeAgentModels } from '../src/renderer/src/components/ClaudeAgentModels';
import { SubagentsTab } from '../src/renderer/src/components/SubagentsTab';
import { useStore } from '../src/renderer/src/store';
import type { ClaudeAgentTypesInfo } from '../src/shared/ipc';
import type { ModelInfo, SessionMeta } from '../src/shared/types';

const { invoke, on } = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(() => () => {}) }));
vi.mock('../src/renderer/src/api', () => ({ invoke, on, isMac: false, modKey: 'Ctrl', platform: 'win32', isWeb: false, webShim: vi.fn() }));

const session = (harness: SessionMeta['config']['harness'] = 'claude'): SessionMeta =>
  ({
    id: 's1',
    title: 'Session',
    cwd: 'G:/repo',
    config: { projectRoot: 'G:/repo', harness, permissionMode: 'ask', model: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
    status: 'idle',
    harnessRef: {},
    usage: { costUsd: 0 }
  }) as unknown as SessionMeta;

const models = (): ModelInfo[] => [
  { id: 'deepseek-v4.1-flash', provider: 'opencode-go', displayName: 'DeepSeek V4.1 Flash', contextWindow: 200_000, supportsImages: false, supportsReasoning: true },
  { id: 'deepseek-v4.1', provider: 'opencode-go', displayName: 'DeepSeek V4.1', contextWindow: 200_000, supportsImages: false, supportsReasoning: true },
  { id: 'claude-sonnet-5', provider: 'anthropic', displayName: 'Sonnet 5', contextWindow: 200_000, supportsImages: true, supportsReasoning: true }
];

const info = (overrides: Partial<ClaudeAgentTypesInfo> = {}): ClaudeAgentTypesInfo => ({
  types: [
    { name: 'Explore', description: 'Searches the repo', model: 'inherit' },
    { name: 'Plan', description: 'Plans a change', model: 'inherit' }
  ],
  files: [{ name: 'Explore', description: 'Searches the repo', model: 'deepseek-v4.1', path: 'G:/repo/.claude/agents/Explore.md' }],
  sessionModel: 'deepseek-v4.1-flash',
  forced: false,
  ...overrides
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  invoke.mockReset();
  on.mockClear();
  useStore.setState({ settings: null, models: { s1: models() }, modelCatalog: {}, subagentReveal: null, panelBottomTab: 'subagents' } as never);
});
afterEach(cleanup);

describe('Claude agent model rows', () => {
  it('offers a control only where the project has a definition, and shows the pin it carries', async () => {
    invoke.mockResolvedValue(info());
    await act(async () => {
      render(<ClaudeAgentModels session={session()} />);
    });
    await settle();

    expect(invoke).toHaveBeenCalledWith('claude-agents:list', { id: 's1' });
    const explore = document.querySelector('[data-testid="claude-agent-model-Explore"]') as HTMLSelectElement;
    expect(explore.value).toBe('deepseek-v4.1');
    expect(explore.textContent).toContain('Same as session');

    // Plan is a built-in with no definition: it runs on the session model and has nothing to edit.
    const plan = document.querySelector('[data-testid="claude-agent-Plan"]')!;
    expect(plan.querySelector('select')).toBeNull();
    expect(plan.textContent).toContain('Runs on the session model');
    expect(document.querySelector('[data-testid="claude-agent-models"]')).toBeNull();
  });

  it('saves a pin and a cleared pin as the definition’s model', async () => {
    invoke.mockImplementation((channel: string) => (channel === 'claude-agents:list' ? Promise.resolve(info()) : Promise.resolve({ ok: true })));
    await act(async () => {
      render(<ClaudeAgentModels session={session()} />);
    });
    await settle();

    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="claude-agent-model-Explore"]')!, { target: { value: 'deepseek-v4.1-flash' } });
    });
    expect(invoke).toHaveBeenCalledWith('claude-agents:setModel', { id: 's1', name: 'Explore', model: 'deepseek-v4.1-flash' });

    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="claude-agent-model-Explore"]')!, { target: { value: '' } });
    });
    expect(invoke).toHaveBeenCalledWith('claude-agents:setModel', { id: 's1', name: 'Explore', model: null });
  });

  it('keeps a pin the catalog no longer lists, so saving cannot drop it by accident', async () => {
    invoke.mockResolvedValue(
      info({
        types: [{ name: 'Explore', description: 'Searches the repo', model: 'inherit' }],
        files: [{ name: 'Explore', description: 'Searches the repo', model: 'retired-model-9', path: 'G:/repo/.claude/agents/Explore.md' }],
        forced: true
      })
    );
    await act(async () => {
      render(<ClaudeAgentModels session={session()} />);
    });
    await settle();
    const explore = document.querySelector('[data-testid="claude-agent-model-Explore"]') as HTMLSelectElement;
    expect(explore.value).toBe('retired-model-9');
    expect([...explore.options].map((o) => o.value)).toEqual(['', 'deepseek-v4.1-flash', 'deepseek-v4.1', 'retired-model-9']);
  });

  it('warns that a project pin releases Claude Code from the session model', async () => {
    invoke.mockResolvedValue(info({ forced: false }));
    await act(async () => {
      render(<ClaudeAgentModels session={session()} />);
    });
    await settle();
    expect(document.querySelector('.callout')!.textContent).toContain('no longer held to the session model');

    cleanup();
    invoke.mockResolvedValue(info({ forced: true, types: [], files: [] }));
    await act(async () => {
      render(<ClaudeAgentModels session={session()} />);
    });
    await settle();
    expect(document.querySelector('.callout')).toBeNull();
    expect(document.body.textContent).toContain('This project defines no Claude agents');
  });
});

describe('the panel’s views', () => {
  it('offers Models to Claude and Agents to pi, and neither to a harness with no such files', async () => {
    invoke.mockImplementation((channel: string) => (channel === 'subagents:list' ? Promise.resolve([]) : Promise.resolve(null)));

    await act(async () => {
      render(<SubagentsTab session={session('claude')} />);
    });
    await settle();
    expect(document.querySelector('[data-testid="subagent-view-models"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="subagent-view-agents"]')).toBeNull();

    cleanup();
    await act(async () => {
      render(<SubagentsTab session={session('pi')} />);
    });
    await settle();
    expect(document.querySelector('[data-testid="subagent-view-agents"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="subagent-view-models"]')).toBeNull();
  });
});
