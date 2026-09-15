/**
 * Layer 2 push: how the knowledge digest reaches a session. Three adapters take an appended system
 * prompt; the other four have no such hook in their SDK, so for those the digest rides the session's
 * first dispatched message instead — once, and without entering the transcript.
 */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { SessionManager } from '../src/main/session-manager';
import { HARNESSES } from '../src/shared/harness-meta';
import { appendedSystemPrompt } from '../src/shared/knowledge';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import type { SessionStore } from '../src/main/store';
import type { HarnessId, SessionMeta, TranscriptItem, UserInput } from '../src/shared/types';

const sent = vi.hoisted((): UserInput[] => []);

vi.mock('../src/main/harness/registry', () => ({
  createAdapter: () => ({
    id: 'native',
    busy: false,
    start: async () => undefined,
    send: async (input: UserInput) => void sent.push(input),
    interrupt: async () => undefined,
    setModel: async () => undefined,
    setEffort: async () => undefined,
    setPermissionMode: async () => undefined,
    dispose: async () => undefined
  })
}));

const DIGEST = '# Project knowledge — proj\n\n- [convention] Harness lifecycle — One harness per session. (conventions/harness-lifecycle.md)';

function makeManager(digest: string | null = DIGEST) {
  const sessions: SessionMeta[] = [];
  const transcripts = new Map<string, TranscriptItem[]>();
  const store = {
    list: () => sessions,
    get: (id: string) => sessions.find((s) => s.id === id),
    upsert: vi.fn(async (m: SessionMeta) => {
      const i = sessions.findIndex((s) => s.id === m.id);
      if (i >= 0) sessions[i] = m;
      else sessions.push(m);
    }),
    readTranscript: async (id: string) => transcripts.get(id) ?? [],
    rewriteTranscript: vi.fn(async (id: string, next: TranscriptItem[]) => void transcripts.set(id, next)),
    appendTranscript: vi.fn(async (id: string, item: TranscriptItem) => void transcripts.set(id, [...(transcripts.get(id) ?? []), item])),
    readBlob: async () => null,
    writeBlob: vi.fn(async () => 'G:/tmp/blob'),
    sessionDir: (id: string) => path.join('G:/tmp', id)
  } as unknown as SessionStore;
  const settings = defaultSettings();
  const manager = new SessionManager({
    store,
    settings: { get: () => settings, update: async () => settings } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log: vi.fn(),
    knowledgeDigest: async () => digest
  });
  return { manager, store, transcripts };
}

const create = (manager: SessionManager, harness: HarnessId, over: Partial<SessionMeta['config']> = {}) =>
  manager.create({ config: { harness, projectRoot: 'G:/proj', permissionMode: 'auto', ...over } });

describe('knowledge digest priming', () => {
  it('keeps the digest off the session config so a reused config cannot carry a stale copy', async () => {
    const { manager } = makeManager();
    const session = await create(manager, 'claude', { appendSystemPrompt: 'Keep my own instructions.' });

    // The digest travels beside the config, never inside it: BranchesTab's "New session on branch"
    // and "Review PR" both spread `session.config` into a new session.
    expect(session.config.appendSystemPrompt).toBe('Keep my own instructions.');
    expect(session.knowledgeDigest).toBe(DIGEST);

    const reused = await manager.create({ config: { ...session.config, useWorktree: false } });
    const composed = appendedSystemPrompt(reused)!;
    expect(composed).toBe(`Keep my own instructions.\n\n${DIGEST}`);
    expect(composed.indexOf(DIGEST)).toBe(composed.lastIndexOf(DIGEST));
  });

  it('composes the user addition and the digest, in that order, for harnesses that take one', async () => {
    const { manager } = makeManager();
    const withBoth = await create(manager, 'native', { appendSystemPrompt: 'Mine.' });
    expect(appendedSystemPrompt(withBoth)).toBe(`Mine.\n\n${DIGEST}`);

    const digestOnly = await create(manager, 'pi');
    expect(appendedSystemPrompt(digestOnly)).toBe(DIGEST);

    const { manager: noDigest } = makeManager(null);
    const bare = await create(noDigest, 'pi');
    expect(bare.knowledgeDigest).toBeUndefined();
    expect(appendedSystemPrompt(bare)).toBeUndefined();
  });

  it('delivers the digest on the first turn for a harness with no system-prompt hook', async () => {
    sent.length = 0;
    const { manager, transcripts } = makeManager();
    const session = await create(manager, 'codex');
    expect(session.knowledgeDigest).toBe(DIGEST);

    await manager.send(session.id, { text: 'add a regression test' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Harness lifecycle');
    expect(sent[0].text).toContain('<project-knowledge>');
    expect(sent[0].text.endsWith('add a regression test')).toBe(true);
    // What the user typed is what the transcript records.
    expect(transcripts.get(session.id)!.filter((i) => i.kind === 'user')).toMatchObject([{ text: 'add a regression test' }]);

    // Once per session, not once per turn.
    expect(manager.get(session.id)!.knowledgePrimed).toBe(true);
    await manager.send(session.id, { text: 'and run it' });
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toBe('and run it');
  });

  it('does not preamble a harness that already received the digest as a system prompt', async () => {
    sent.length = 0;
    const { manager } = makeManager();
    const session = await create(manager, 'claude');
    await manager.send(session.id, { text: 'hello' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('hello');
    expect(manager.get(session.id)!.knowledgePrimed).toBeUndefined();
  });

  it('gives every harness exactly one push surface', () => {
    // A harness with neither an appended system prompt nor the first-turn preamble would silently
    // get no digest at all, which is how four of the seven were missed.
    for (const harness of HARNESSES) {
      expect(typeof harness.capabilities.systemPrompt, harness.id).toBe('boolean');
    }
    expect(HARNESSES.filter((h) => h.capabilities.systemPrompt).map((h) => h.id).sort()).toEqual(['claude', 'native', 'pi']);
  });
});
