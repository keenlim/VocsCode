import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, SessionEvent, SessionMeta, UsageTotals } from '../src/shared/types';
import { defaultSettings } from '../src/main/settings';
import { SessionManager } from '../src/main/session-manager';
import type { HarnessAdapter } from '../src/main/harness/types';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import type { SettingsStore } from '../src/main/settings';
import type { SessionStore } from '../src/main/store';

const usage = (contextTokens: number): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  turns: 1,
  contextTokens,
});

/** The delay the first continuation waits for, and the one every retry after it waits for. */
const FIRST_DELAY_MS = 1_500;
const RETRY_MS = 5_000;

describe('goal auto-continuation delivery', () => {
  afterEach(() => vi.useRealTimers());

  it('waits out a session held by compaction instead of dropping the continuation', async () => {
    vi.useFakeTimers();
    const fixture = goalFixture();
    // A compaction started by the turn that just ended owns the session; the turn item below has
    // already been emitted, so this is the state the continuation actually wakes up into.
    fixture.session.status = 'running';
    fixture.finishTurn();
    await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS);
    expect(fixture.send).not.toHaveBeenCalled();

    // Still compacting two retries later.
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(fixture.send).not.toHaveBeenCalled();

    // Compaction finished: the continuation lands on the next attempt rather than being lost.
    fixture.session.status = 'idle';
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Goal check-in 1/5') }));
    expect(fixture.active.goalContinuationTimer).toBeNull();
  });

  it('replaces a pending continuation with a newer turn instead of racing it', async () => {
    vi.useFakeTimers();
    const fixture = goalFixture();
    fixture.finishTurn();
    fixture.finishTurn();
    await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS);
    await vi.advanceTimersByTimeAsync(RETRY_MS);

    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.session.goal?.iterations).toBe(2);
    expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Goal check-in 2/5') }));
  });

  it('gives up after the attempt bound rather than retrying forever', async () => {
    vi.useFakeTimers();
    const fixture = goalFixture();
    fixture.session.status = 'running';
    fixture.finishTurn();

    await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS + RETRY_MS * 61);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.active.goalContinuationTimer).toBeNull();
    expect(fixture.log).toHaveBeenCalledWith('warn', expect.stringContaining('goal continuation gave up'));
  });

  it('leaves an awaiting session to the turn behind its approval', async () => {
    vi.useFakeTimers();
    const fixture = goalFixture();
    fixture.session.status = 'awaiting';
    fixture.finishTurn();

    await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS + RETRY_MS * 2);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.active.goalContinuationTimer).toBeNull();
  });

  it('drops a continuation whose goal was paused or cleared while it waited', async () => {
    vi.useFakeTimers();
    const fixture = goalFixture();
    fixture.session.status = 'running';
    fixture.finishTurn();
    await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS);

    if (fixture.session.goal) fixture.session.goal.status = 'paused';
    fixture.session.status = 'idle';
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    expect(fixture.send).not.toHaveBeenCalled();
  });
});

function goalFixture() {
  const settings: AppSettings = { ...defaultSettings(), autoCompactionThreshold: undefined };
  const session: SessionMeta = {
    id: 'goal-session',
    title: 'Goal session',
    createdAt: 1,
    updatedAt: 1,
    config: { harness: 'native', projectRoot: 'G:/project', permissionMode: 'ask' },
    cwd: 'G:/project',
    status: 'idle',
    harnessRef: {},
    usage: usage(0),
    queued: 0,
    goal: { objective: 'Ship the fix', status: 'active', createdAt: 1, updatedAt: 1, iterations: 0, maxIterations: 5, autoContinue: true },
  };
  const send = vi.fn(async () => undefined);
  const adapter: HarnessAdapter = {
    id: 'native',
    busy: false,
    start: vi.fn(async () => undefined),
    send,
    interrupt: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setEffort: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  const store = {
    list: () => [session],
    get: (id: string) => (id === session.id ? session : undefined),
    upsert: vi.fn(async () => undefined),
    appendTranscript: vi.fn(async () => undefined),
    readBlob: vi.fn(async () => null),
  } as unknown as SessionStore;
  const log = vi.fn();
  const manager = new SessionManager({
    store,
    settings: { get: () => settings } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log,
  });
  const active = {
    adapter,
    approvals: new Map(),
    liveItems: new Map(),
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
    goalContinuationTimer: null,
  };
  (manager as unknown as { active: Map<string, typeof active> }).active.set(session.id, active);
  const emit = (event: SessionEvent) => (manager as unknown as { emit: (id: string, value: SessionEvent) => void }).emit(session.id, event);

  return {
    active,
    emit,
    log,
    manager,
    send,
    session,
    /** A completed turn is what arms the continuation loop; the body must not carry the completion token. */
    finishTurn: () => {
      emit({ type: 'item.upsert', item: { id: `i_${Math.random()}`, kind: 'assistant', ts: Date.now(), text: 'Still working.' } });
      emit({ type: 'item.upsert', item: { id: `t_${Math.random()}`, kind: 'turn', ts: Date.now(), status: 'completed' } });
    },
  };
}
