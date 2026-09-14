/**
 * Streamed Codex items must reach the transcript exactly once.
 *
 * The adapter keeps a live item per streamed id and the session manager mutates the item it is
 * handed as deltas arrive. Emitting the adapter's own object makes both sides append the same
 * delta, double-printing reasoning text and command output — visible on Codex sessions that run
 * third-party OpenAI-wire models (DeepSeek, OpenRouter, …), whose reasoning streams as deltas.
 * These tests drive the real adapter through the real SessionManager and assert the flushed
 * transcript, the boundary the duplication escaped through.
 */
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import type { HarnessContext } from '../src/main/harness/types';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import type { SettingsStore } from '../src/main/settings';
import { defaultSettings } from '../src/main/settings';
import { SessionManager } from '../src/main/session-manager';
import type { SessionStore } from '../src/main/store';
import { emptyUsage } from '../src/main/models/static-models';
import type { SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture() {
  const session: SessionMeta = {
    id: 's_codex_stream',
    title: 'Codex stream',
    createdAt: 1,
    updatedAt: 1,
    config: { harness: 'codex', projectRoot: process.cwd(), permissionMode: 'auto', model: { provider: 'deepseek', model: 'deepseek-flash' } },
    cwd: process.cwd(),
    status: 'running',
    harnessRef: {},
    usage: emptyUsage()
  };
  const appended: TranscriptItem[] = [];
  const store = {
    list: () => [session],
    get: (id: string) => (id === session.id ? session : undefined),
    upsert: vi.fn(async () => undefined),
    appendTranscript: vi.fn(async (_id: string, item: TranscriptItem) => {
      appended.push(item);
    })
  } as unknown as SessionStore;
  const manager = new SessionManager({
    store,
    settings: { get: () => defaultSettings() } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log: vi.fn()
  });

  const ctx = {
    sessionId: session.id,
    session: () => session,
    settings: () => defaultSettings(),
    permissionMode: () => session.config.permissionMode,
    effort: () => undefined,
    emit: (event: SessionEvent) => (manager as unknown as { emit: (id: string, value: SessionEvent) => void }).emit(session.id, event),
    requestApproval: async () => ({ optionId: 'deny' as const }),
    updateRef: (patch: Record<string, unknown>) => Object.assign(session.harnessRef, patch),
    updateMeta: (patch: Partial<SessionMeta>) => Object.assign(session, patch),
    log: vi.fn(),
    readJson: async () => null,
    writeJson: async () => undefined,
    mcpServers: async () => [],
    ownedMcpIds: () => []
  } as unknown as HarnessContext;

  const adapter = new CodexAppServerAdapter(ctx);
  const notifications = new Map<string, (params: unknown) => void>();
  const rpc = {
    request: vi.fn(async () => ({ turn: { id: 'turn-1' } })),
    onNotification: (method: string, handler: (params: unknown) => void) => notifications.set(method, handler),
    onServerRequest: vi.fn()
  };
  (adapter as unknown as { rpc: unknown; threadId: string }).rpc = rpc;
  (adapter as unknown as { threadId: string }).threadId = 'thread-1';
  (adapter as unknown as { wireNotifications: (client: unknown) => void }).wireNotifications(rpc);
  (manager as unknown as { active: Map<string, unknown> }).active.set(session.id, {
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
    compactionInFlight: null
  });
  const notify = (method: string, params: unknown) => notifications.get(method)!(params);
  return { appended, notify };
}

describe('codex streamed items reach the transcript once', () => {
  it('holds reasoning text to one copy when it streams as deltas', async () => {
    const { appended, notify } = fixture();
    notify('turn/started', { turn: { id: 'turn-1' } });
    notify('item/reasoning/textDelta', { itemId: 'r1', delta: 'The' });
    notify('item/reasoning/textDelta', { itemId: 'r1', delta: ' user' });
    notify('item/completed', { item: { id: 'r1', type: 'reasoning', summary: [], content: ['The user'] } });
    notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null, durationMs: 5 } });
    await settle();

    const versions = appended.filter((item) => item.id === 'r1');
    const texts = versions.map((item) => (item.kind === 'assistant' ? item.thinking ?? '' : ''));
    expect(texts).toContain('The user');
    expect(texts.some((text) => text.includes('TheThe'))).toBe(false);
  });

  it('holds reasoning text to one copy when the item is opened by its first delta', async () => {
    const { appended, notify } = fixture();
    notify('turn/started', { turn: { id: 'turn-1' } });
    notify('item/started', { item: { id: 'r2', type: 'reasoning', summary: [], content: [] } });
    notify('item/reasoning/summaryTextDelta', { itemId: 'r2', delta: 'Thinking' });
    notify('item/reasoning/summaryTextDelta', { itemId: 'r2', delta: ' hard' });
    notify('item/completed', { item: { id: 'r2', type: 'reasoning', summary: ['Thinking hard'], content: [] } });
    notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null, durationMs: 5 } });
    await settle();

    const versions = appended.filter((item) => item.id === 'r2');
    const texts = versions.map((item) => (item.kind === 'assistant' ? item.thinking ?? '' : ''));
    expect(texts).toContain('Thinking hard');
    expect(texts.some((text) => text.includes('ThinkingThinking'))).toBe(false);
  });

  it('holds streamed command output to one copy', async () => {
    const { appended, notify } = fixture();
    notify('turn/started', { turn: { id: 'turn-1' } });
    notify('item/started', { item: { id: 'c1', type: 'commandExecution', command: 'echo hi', cwd: process.cwd(), status: 'inProgress' } });
    notify('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'hi\n' });
    notify('item/completed', { item: { id: 'c1', type: 'commandExecution', command: 'echo hi', cwd: process.cwd(), status: 'completed', aggregatedOutput: 'hi\n', exitCode: 0, durationMs: 5 } });
    notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null, durationMs: 5 } });
    await settle();

    const versions = appended.filter((item) => item.id === 'c1');
    const outputs = versions.map((item) => (item.kind === 'tool' ? item.output ?? '' : ''));
    expect(outputs).toContain('hi\n');
    expect(outputs.some((output) => output.includes('hi\nhi\n'))).toBe(false);
  });
});
