/**
 * The Usage page's stats model: everything the panel shows beyond the session's token totals is
 * folded out of the transcript here, so this is where tool, file, approval and failure counting is
 * pinned down.
 */
import { describe, expect, it } from 'vitest';
import { cacheHitRate, failureCount, sessionUsageStats, toolSuccessRate, turnSuccessRate } from '../src/renderer/src/session-usage';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const T = Date.UTC(2026, 0, 2, 12);

function session(extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    title: 'Session',
    createdAt: T,
    updatedAt: T,
    cwd: 'G:/repo',
    config: { projectRoot: 'G:/repo', harness: 'native', permissionMode: 'ask' },
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 3000, cacheWriteTokens: 200, reasoningTokens: 0, costUsd: 1.5, turns: 2 },
    ...extra
  } as SessionMeta;
}

/** A transcript covering every shape the panel counts. */
const items: TranscriptItem[] = [
  { id: 'u1', kind: 'user', ts: T, text: 'go' },
  { id: 't1', kind: 'tool', ts: T + 1, name: 'read', hint: 'read', status: 'done', durationMs: 100 },
  { id: 't2', kind: 'tool', ts: T + 2, name: 'bash', hint: 'execute', status: 'error', durationMs: 300, exitCode: 2, output: '\nfatal: not a git repository\nmore noise' },
  { id: 't3', kind: 'tool', ts: T + 3, name: 'edit', hint: 'edit', status: 'done', durationMs: 50, changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }] },
  { id: 'a1', kind: 'assistant', ts: T + 4, text: 'done' },
  { id: 'turn1', kind: 'turn', ts: T + 5, status: 'completed', durationMs: 4000, costUsd: 1, usage: { inputTokens: 700, outputTokens: 300 } },
  { id: 'u2', kind: 'user', ts: T + 6, text: 'again' },
  { id: 't4', kind: 'tool', ts: T + 7, name: 'bash', hint: 'execute', status: 'error', durationMs: 20, output: 'boom' },
  { id: 't5', kind: 'tool', ts: T + 8, name: 'edit', hint: 'edit', status: 'declined' },
  { id: 't6', kind: 'tool', ts: T + 9, name: 'grep', hint: 'search', status: 'running' },
  { id: 'i1', kind: 'info', ts: T + 10, level: 'warn', text: 'context is getting full' },
  {
    id: 'ap1',
    kind: 'approval',
    ts: T + 11,
    request: { id: 'r1', sessionId: 's1', harness: 'native', kind: 'command', title: 'rm', createdAt: T + 11, options: [{ id: 'o-yes', label: 'Allow', kind: 'allow' }, { id: 'o-no', label: 'Deny', kind: 'deny' }] },
    decision: { optionId: 'o-no' }
  },
  { id: 'turn2', kind: 'turn', ts: T + 12, status: 'failed', durationMs: 9000, costUsd: 0.5, error: 'rate limited\nretry later' }
];

describe('session usage stats', () => {
  it('counts turns, tool outcomes, file changes and approvals from the transcript', () => {
    const s = sessionUsageStats(session(), items);

    expect(s.turns).toMatchObject({ total: 2, completed: 1, failed: 1, interrupted: 0, timed: 2, totalMs: 13_000, longestMs: 9000 });
    expect(s.tools).toMatchObject({ total: 6, done: 2, errors: 2, declined: 1, running: 1, timed: 4, totalMs: 470 });
    expect(s.files).toEqual({ touched: 2, add: 1, update: 1, delete: 0, rename: 0 });
    expect(s.approvals).toEqual({ total: 1, allowed: 0, denied: 1 });
    expect(s.messages).toEqual({ user: 2, assistant: 1 });
    expect(s.warnings).toBe(1);
  });

  it('groups tools by name and by category, keeping error counts per tool', () => {
    const s = sessionUsageStats(session(), items);

    expect(s.tools.byName.map((t) => [t.name, t.calls, t.errors])).toEqual([
      ['bash', 2, 2],
      ['edit', 2, 0],
      ['grep', 1, 0],
      ['read', 1, 0]
    ]);
    // Categories keep the fixed slot order so a mix does not repaint when one disappears.
    expect(s.tools.byHint.map((h) => h.hint)).toEqual(['read', 'edit', 'execute', 'search']);
    expect(s.tools.byHint.find((h) => h.hint === 'execute')).toMatchObject({ calls: 2, errors: 2, totalMs: 320 });
  });

  it('builds a per-turn series and attributes the tool calls that preceded each turn', () => {
    const s = sessionUsageStats(session(), items);

    expect(s.series.map((p) => [p.id, p.status, p.costUsd, p.tools, p.outputTokens])).toEqual([
      ['turn1', 'completed', 1, 3, 300],
      ['turn2', 'failed', 0.5, 3, 0]
    ]);
  });

  it('logs failures newest first, with the first meaningful line of the failure', () => {
    const s = sessionUsageStats(session(), items);

    expect(s.errors.map((e) => [e.source, e.label])).toEqual([
      ['turn', 'Turn failed'],
      ['tool', 'bash'],
      ['tool', 'bash']
    ]);
    expect(s.errors[0].detail).toBe('rate limited');
    // Leading blank lines are skipped and a non-zero exit code is kept alongside the message.
    expect(s.errors[2].detail).toBe('exit 2 · fatal: not a git repository');
  });

  it("adds the session's persisted last error only when the transcript does not already carry it", () => {
    const withNew = sessionUsageStats(session({ lastError: 'harness exited unexpectedly' }), items);
    expect(withNew.errors.map((e) => e.source)).toContain('session');

    const duplicate = sessionUsageStats(session({ lastError: 'rate limited\nretry later' }), items);
    expect(duplicate.errors.filter((e) => e.source === 'session')).toHaveLength(0);
  });

  it('derives the rates the panel meters read', () => {
    const s = sessionUsageStats(session(), items);

    expect(failureCount(s)).toBe(4); // 2 failed tools + 1 declined + 1 failed turn
    expect(toolSuccessRate(s)).toBeCloseTo(2 / 5); // the running call has not settled
    expect(turnSuccessRate(s)).toBe(0.5);
    expect(cacheHitRate(session().usage)).toBeCloseTo(3000 / 4000);
  });

  it('is empty, not broken, for a session that has not run yet', () => {
    const s = sessionUsageStats(session({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 } }), []);

    expect(s.turns.total).toBe(0);
    expect(s.tools.byName).toEqual([]);
    expect(s.errors).toEqual([]);
    expect(toolSuccessRate(s)).toBeNull();
    expect(turnSuccessRate(s)).toBeNull();
    expect(cacheHitRate({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 })).toBeNull();
  });

  it('caps the error log so a long failing session cannot grow the panel without bound', () => {
    const many: TranscriptItem[] = Array.from({ length: 80 }, (_, i) => ({ id: `e${i}`, kind: 'tool', ts: T + i, name: 'bash', hint: 'execute', status: 'error', output: `boom ${i}` }));
    const s = sessionUsageStats(session(), many);

    expect(s.tools.errors).toBe(80);
    expect(s.errors).toHaveLength(40);
    expect(s.errors[0].detail).toBe('boom 79');
  });
});
