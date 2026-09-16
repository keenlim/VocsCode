/**
 * Archiving a session parks it: the harness stops, so no process outlives the row that left the
 * sidebar — with or without a worktree removal. The terminal half of that contract lives in
 * tests/handler-registry.test.ts (the archive handler closes the session's shells) and in
 * tests/e2e.terminal.test.ts against a real PTY.
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionManager, type SessionManagerDeps } from '../src/main/session-manager';
import type { AnalyticsStore } from '../src/main/analytics';
import type { HarnessAdapter } from '../src/main/harness/types';
import type { RuntimeResolver } from '../src/main/runtime';
import type { SettingsStore } from '../src/main/settings';
import { defaultSettings } from '../src/main/settings';
import type { SessionStore } from '../src/main/store';
import { emptyUsage } from '../src/main/models/static-models';
import type { SessionMeta } from '../src/shared/types';

const gitMocks = vi.hoisted(() => ({
  removeWorktree: vi.fn(async (_root: string, _cwd: string, _opts?: { force?: boolean }) => undefined),
  restoreWorktree: vi.fn(async (_root: string, _cwd: string, _branch: string) => undefined)
}));

vi.mock('../src/main/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/git')>();
  return { ...actual, removeWorktree: gitMocks.removeWorktree, restoreWorktree: gitMocks.restoreWorktree };
});

function fixture(overrides: Partial<SessionMeta> = {}) {
  const session: SessionMeta = {
    id: 's_archive',
    title: 'Archive me',
    createdAt: 1,
    updatedAt: 1,
    config: { harness: 'native', projectRoot: 'G:/project', permissionMode: 'ask' },
    cwd: 'G:/project',
    status: 'running',
    harnessRef: {},
    usage: emptyUsage(),
    queued: 2,
    ...overrides
  };
  const dispose = vi.fn(async () => undefined);
  const adapter = {
    id: 'native',
    busy: true,
    start: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setEffort: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    dispose
  } as unknown as HarnessAdapter;
  const store = {
    list: () => [session],
    get: (id: string) => (id === session.id ? session : undefined),
    upsert: vi.fn(async () => undefined),
    appendTranscript: vi.fn(async () => undefined)
  } as unknown as SessionStore;
  const settings = { ...defaultSettings() };
  const manager = new SessionManager({
    store,
    settings: { get: () => settings } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: {} as unknown as AnalyticsStore,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log: vi.fn()
  } satisfies SessionManagerDeps);
  const active = {
    adapter,
    approvals: new Map(),
    liveItems: new Map(),
    toolModels: new Map(),
    dirty: new Set<string>(),
    lastAssistantText: '',
    starting: null,
    models: null,
    autoCompactionThreshold: undefined,
    autoCompactionLatched: false,
    autoCompactionRetryAt: 0,
    autoCompactionRetryTimer: null,
    compactionInFlight: null,
    autoCompactionWindow: undefined,
    goalContinuationTimer: null
  };
  (manager as unknown as { active: Map<string, typeof active> }).active.set(session.id, active);
  return { manager, session, dispose };
}

describe('SessionManager.setArchived', () => {
  it('stops a running session when it is archived without a worktree removal', async () => {
    const { manager, session, dispose } = fixture();

    await manager.setArchived(session.id, true);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect((manager as unknown as { active: Map<string, unknown> }).active.has(session.id)).toBe(false);
    expect(session.archived).toBe(true);
    expect(session.status).toBe('idle');
    expect(session.queued).toBe(0);
  });

  it('stops the harness before the worktree it may be holding is removed', async () => {
    const order: string[] = [];
    const { manager, session, dispose } = fixture({ worktreeBranch: 'vocscode/archive-me' });
    dispose.mockImplementation(async () => void order.push('dispose'));
    gitMocks.removeWorktree.mockImplementation(async () => void order.push('removeWorktree'));

    await manager.setArchived(session.id, true, true);

    expect(order).toEqual(['dispose', 'removeWorktree']);
    expect(session.archived).toBe(true);
  });

  it('leaves a stopped session alone when it is unarchived', async () => {
    const { manager, session, dispose } = fixture({ status: 'idle', archived: true });
    (manager as unknown as { active: Map<string, unknown> }).active.clear();

    const meta = await manager.setArchived(session.id, false);

    expect(dispose).not.toHaveBeenCalled();
    expect(meta.archived).toBe(false);
  });
});
