// The sidebar's recency key (SessionMeta.lastUserMessageAt): a prompt the user sends stamps it,
// while the prompts the goal loop writes for itself must not — counting those would float a
// background session over the one the user is working in.
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { SessionManager } from '../src/main/session-manager';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import type { SessionStore } from '../src/main/store';
import type { SessionMeta, UserInput } from '../src/shared/types';

const sent = vi.hoisted((): UserInput[] => []);

vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (_id: string, ctx: { emit: (event: { type: 'status'; status: 'idle' }) => void }) => ({
    id: 'native',
    busy: false,
    start: async () => ctx.emit({ type: 'status', status: 'idle' }),
    send: async (input: UserInput) => void sent.push(input),
    interrupt: async () => undefined,
    setModel: async () => undefined,
    setEffort: async () => undefined,
    setPermissionMode: async () => undefined,
    dispose: async () => undefined
  })
}));

function setup() {
  sent.length = 0;
  const session: SessionMeta = {
    id: 's_recency',
    title: 'Session',
    createdAt: 1,
    updatedAt: 1,
    cwd: 'G:/project',
    config: { harness: 'native', projectRoot: 'G:/project', permissionMode: 'ask' },
    harnessRef: { nativeHistory: true },
    status: 'idle',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  };
  const store = {
    list: () => [session],
    get: (id: string) => (id === session.id ? session : undefined),
    upsert: vi.fn(async () => undefined),
    appendTranscript: vi.fn(async () => undefined),
    sessionDir: (id: string) => path.join('G:/tmp', id)
  } as unknown as SessionStore;
  const pushSessions = vi.fn();
  const manager = new SessionManager({
    store,
    settings: { get: () => defaultSettings() } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions,
    notify: vi.fn(),
    log: vi.fn()
  });
  return { manager, session, pushSessions };
}

describe('user-message recency', () => {
  it('stamps the send time and republishes the sidebar before the turn runs', async () => {
    const { manager, session, pushSessions } = setup();
    const before = Date.now();

    await manager.send(session.id, { text: 'hello' });

    expect(session.lastUserMessageAt).toBeGreaterThanOrEqual(before);
    expect(session.lastUserMessageAt).toBeLessThanOrEqual(Date.now());
    expect(sent.map((i) => i.text)).toEqual(['hello']);
    expect(pushSessions).toHaveBeenCalled();
  });

  it('leaves the stamp alone for a goal kickoff the user did not write', async () => {
    const { manager, session } = setup();

    await manager.goal(session.id, 'set', { objective: 'Ship the thing' });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].text).toContain('Ship the thing');
    expect(session.lastUserMessageAt).toBeUndefined();
  });
});
