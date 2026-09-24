/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, SessionMeta } from '../src/shared/types';
import { mergeClaudeCatalog } from '../src/main/models/claude-catalog';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({
  invoke,
  on: vi.fn(),
  isMac: false,
  modKey: 'Ctrl',
}));

import { NewSessionDialog } from '../src/renderer/src/components/NewSessionDialog';
import { useStore } from '../src/renderer/src/store';

const settings = {
  defaultHarness: 'claude',
  defaultPermissionMode: 'ask',
  defaultEffort: undefined,
  defaultModelByHarness: {},
  folderSessionDefaults: {},
  favoriteModels: [],
  acpAgents: [],
} as unknown as AppSettings;

const createdSession = {
  id: 'new-session',
  title: 'New session',
  config: { harness: 'claude', projectRoot: 'G:/project', permissionMode: 'ask' },
} as SessionMeta;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'harness:models') return { models: [] };
    if (channel === 'sessions:create') return createdSession;
    if (channel === 'git:folderIsRepo') return { isRepo: true };
    return {};
  });
  useStore.setState({
    settings,
    sessions: [],
    activeId: null,
    availability: {},
    newSessionRoot: 'G:/project',
    openNewSession: vi.fn(),
    setActive: vi.fn().mockResolvedValue(undefined),
    toast: vi.fn(),
  } as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NewSessionDialog', () => {
  it('starts from the first prompt on Enter and keeps Shift+Enter for newlines', async () => {
    render(<NewSessionDialog />);
    // Starting waits for the model list and the folder's git probe; Enter is inert until then.
    const start = screen.getByTitle('Start from the prompt area with Enter') as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    expect(invoke).toHaveBeenCalledWith('harness:models', expect.anything());

    const prompt = screen.getByPlaceholderText('What should the agent do?');
    fireEvent.change(prompt, { target: { value: 'Fix the flaky test' } });
    fireEvent.keyDown(prompt, { key: 'Enter', shiftKey: true });
    expect(invoke).not.toHaveBeenCalledWith('sessions:create', expect.anything());

    fireEvent.keyDown(prompt, { key: 'Enter' });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'sessions:create',
        expect.objectContaining({ initialPrompt: 'Fix the flaky test' }),
      ),
    );
  });

  it('shows Enter as the start shortcut', () => {
    render(<NewSessionDialog />);
    const start = screen.getByTitle('Start from the prompt area with Enter');
    expect(start.textContent).toContain('↵');
    expect(start.textContent).not.toContain('Ctrl');
  });

  it('shows and selects a newly discovered Claude login model explicitly', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'harness:models') {
        return {
          models: [
            { id: 'default', provider: 'anthropic', displayName: 'Default (recommended) — Opus 5.5 with 1M context', isDefault: true },
            { id: 'claude-opus-5-5[1m]', provider: 'anthropic', displayName: 'Opus 5.5 with 1M context' }
          ]
        };
      }
      if (channel === 'sessions:create') return createdSession;
      if (channel === 'git:folderIsRepo') return { isRepo: true };
      return {};
    });
    render(<NewSessionDialog />);

    const opus = await screen.findByRole('button', { name: /anthropic\/claude-opus-5-5\[1m\].*Opus 5\.5 with 1M context/ });
    fireEvent.click(opus);
    fireEvent.click(screen.getByTitle('Start from the prompt area with Enter'));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:create', expect.anything()));
    const createCall = invoke.mock.calls.find(([channel]) => channel === 'sessions:create');
    expect((createCall?.[1] as { config: { model?: unknown } }).config.model).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5[1m]' });
  });

  it.each([
    { provider: 'anthropic', model: 'claude-opus-5-5' },
    { provider: 'anthropic', model: 'claude-opus-5-5[1m]' },
    { provider: 'custom-anthropic', model: 'claude-opus-5-5' },
  ])('deduplicates normalized Claude rows and remembers the explicit $provider/$model selection', async (selected) => {
    const catalogSettings: AppSettings = {
      ...settings,
      providers: [{
        id: 'custom-anthropic',
        kind: 'anthropic',
        name: 'Custom Anthropic gateway',
        baseUrl: 'https://gateway.example.test',
        enabled: true,
        hasApiKey: true,
        models: [{ id: 'claude-opus-5-5', provider: 'custom-anthropic', displayName: 'Gateway Opus 5.5' }],
      }],
    };
    // Alias and explicit SDK entries have already normalized to the same canonical id.
    // Exercise the real catalog boundary rather than supplying a pre-deduplicated IPC fixture.
    const models = mergeClaudeCatalog([
      { id: 'default', provider: 'anthropic', displayName: 'Default (recommended) — Opus 5.5', isDefault: true },
      { id: 'claude-opus-5-5', provider: 'anthropic', displayName: 'Opus 5.5' },
      { id: 'claude-opus-5-5', provider: 'anthropic', displayName: 'Claude Opus 5.5' },
      { id: 'claude-opus-5-5[1m]', provider: 'anthropic', displayName: 'Opus 5.5 with 1M context' },
    ], catalogSettings);
    useStore.setState({ settings: catalogSettings });
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'harness:models') return { models };
      if (channel === 'sessions:create') return createdSession;
      if (channel === 'git:folderIsRepo') return { isRepo: true };
      return {};
    });
    render(<NewSessionDialog />);
    const start = screen.getByTitle('Start from the prompt area with Enter') as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));

    const expectUniqueRows = () => {
      expect(screen.getAllByRole('button', { name: /^(anthropic|custom-anthropic)\// })).toHaveLength(4);
      for (const title of [
        'anthropic/default',
        'anthropic/claude-opus-5-5',
        'anthropic/claude-opus-5-5[1m]',
        'custom-anthropic/claude-opus-5-5',
      ]) {
        expect(screen.getAllByTitle(title)).toHaveLength(1);
      }
    };
    const buttonFor = (title: string) => screen.getByTitle(title).closest('button')!;
    expectUniqueRows();
    expect(buttonFor('anthropic/default').getAttribute('aria-pressed')).toBe('true');

    const selectedTitle = `${selected.provider}/${selected.model}`;
    fireEvent.click(buttonFor(selectedTitle));
    expectUniqueRows();
    expect(buttonFor(selectedTitle).getAttribute('aria-pressed')).toBe('true');
    expect(buttonFor('anthropic/default').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(start);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'sessions:create',
      expect.objectContaining({ config: expect.objectContaining({ model: selected }) }),
    ));
    expect(invoke.mock.calls.filter(([channel]) => channel === 'sessions:create')).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('settings:update', expect.objectContaining({
      defaultModelByHarness: { claude: selected },
      folderSessionDefaults: {
        'G:/project': expect.objectContaining({ modelByHarness: { claude: selected } }),
      },
    }));
  });

  it('does not offer an unlisted model id typed into the model search', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'harness:models') return { models: [{ id: 'claude-sonnet-5', provider: 'anthropic', displayName: 'Claude Sonnet 5' }] };
      if (channel === 'sessions:create') return createdSession;
      if (channel === 'git:folderIsRepo') return { isRepo: true };
      return {};
    });
    render(<NewSessionDialog />);
    // The catalog's first model becomes the selection; typing must not add a custom row alongside it.
    await screen.findByRole('button', { name: /Claude Sonnet 5/ });

    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'glm-4.6' } });
    expect(screen.queryByRole('button', { name: 'Use “glm-4.6”' })).toBeNull();

    // Starting submits the listed selection, never the typed id.
    fireEvent.click(screen.getByTitle('Start from the prompt area with Enter'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:create', expect.anything()));
    const createCall = invoke.mock.calls.find(([channel]) => channel === 'sessions:create');
    expect((createCall?.[1] as { config: { model?: unknown } }).config.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
  });

  it('offers worktree isolation for a folder that is a git repository', async () => {
    render(<NewSessionDialog />);
    const toggle = screen.getByLabelText(/Isolate in a git worktree/) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(screen.getByText('(new branch under .vocs-code/worktrees)')).toBeTruthy();

    fireEvent.click(toggle);
    fireEvent.click(screen.getByTitle('Start from the prompt area with Enter'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:create', expect.anything()));
    const call = invoke.mock.calls.find(([channel]) => channel === 'sessions:create');
    expect((call?.[1] as { config: { useWorktree?: boolean } }).config.useWorktree).toBe(true);
  });

  // A plain folder cannot host a worktree: `git worktree add` fails there, so creation died with
  // "Worktrees require a git repository." — including when only the remembered default asked for it.
  it('disables worktree isolation for a folder with no git repository and never asks for it', async () => {
    useStore.setState({ settings: { ...settings, folderSessionDefaults: { 'G:/project': { useWorktree: true } } } } as never);
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'harness:models') return { models: [] };
      if (channel === 'sessions:create') return createdSession;
      if (channel === 'git:folderIsRepo') return { isRepo: false };
      return {};
    });
    render(<NewSessionDialog />);

    const toggle = screen.getByLabelText(/Isolate in a git worktree/) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(true));
    // The remembered default must not survive as a checked-but-unusable toggle.
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('(unavailable — this folder is not a git repository)')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Start from the prompt area with Enter'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:create', expect.anything()));
    const call = invoke.mock.calls.find(([channel]) => channel === 'sessions:create');
    expect((call?.[1] as { config: { useWorktree?: boolean } }).config.useWorktree).toBe(false);
  });
});
