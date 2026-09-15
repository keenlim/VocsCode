/**
 * Session-scoped analytics derived from the live transcript. The session's `usage` totals only
 * carry tokens and cost, so everything about tools, files, approvals and failures is folded out of
 * the transcript items here — pure functions, so the Usage panel stays a rendering concern.
 */
import type { SessionMeta, ToolKindHint, TranscriptItem } from '../../shared/types';

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

/** Categories in a fixed order, so a tool mix keeps the same colour when a category disappears. */
export const HINT_ORDER: ToolKindHint[] = ['read', 'edit', 'execute', 'search', 'fetch', 'agent', 'mcp', 'think', 'other'];

export const HINT_LABEL: Record<ToolKindHint, string> = {
  read: 'Read',
  edit: 'Edit',
  execute: 'Run',
  search: 'Search',
  fetch: 'Fetch',
  agent: 'Subagent',
  mcp: 'MCP',
  think: 'Think',
  other: 'Other'
};

export interface ToolStat {
  name: string;
  hint: ToolKindHint;
  calls: number;
  errors: number;
  declined: number;
  /** Wall time over the calls that reported one, and how many did. */
  totalMs: number;
  timed: number;
  files: number;
}

export interface HintStat {
  hint: ToolKindHint;
  calls: number;
  errors: number;
  totalMs: number;
}

export interface ErrorEntry {
  id: string;
  ts: number;
  source: 'tool' | 'turn' | 'session';
  label: string;
  detail: string;
}

export interface TurnPoint {
  id: string;
  ts: number;
  status: 'completed' | 'interrupted' | 'failed';
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Tool calls recorded between the previous turn boundary and this one. */
  tools: number;
}

export interface SessionUsageStats {
  turns: {
    total: number;
    completed: number;
    interrupted: number;
    failed: number;
    /** Turns that reported a duration, their total wall time and the longest of them. */
    timed: number;
    totalMs: number;
    longestMs: number;
    costUsd: number;
  };
  /**
   * What the transcript holds from the session this one was forked from. Reported, never counted:
   * those turns, tool calls and dollars belong to the source's own record.
   */
  carried: { turns: number };
  tools: {
    total: number;
    done: number;
    errors: number;
    declined: number;
    running: number;
    totalMs: number;
    timed: number;
    byName: ToolStat[];
    byHint: HintStat[];
  };
  files: { touched: number; add: number; update: number; delete: number; rename: number };
  approvals: { total: number; allowed: number; denied: number };
  messages: { user: number; assistant: number };
  errors: ErrorEntry[];
  warnings: number;
  /** Oldest → newest, one entry per recorded turn. */
  series: TurnPoint[];
}

/** First non-empty line, trimmed and clamped, so an error list never inherits a tool's full output. */
function firstLine(text: string | undefined, max = 240): string {
  if (!text) return '';
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toolDetail(item: ToolItem): string {
  const exit = item.exitCode !== undefined && item.exitCode !== null && item.exitCode !== 0 ? `exit ${item.exitCode}` : '';
  const body = firstLine(item.output) || item.summary?.trim() || '';
  return [exit, body].filter(Boolean).join(' · ') || 'Tool call failed.';
}

/** Recent errors first; the panel only ever shows a window of them. */
const MAX_ERRORS = 40;

/**
 * Whether a transcript row came from the session this one was forked from. `fork` copies the
 * source's rows into the new session, so a row older than the session's own creation is the
 * source's history — already counted by the session that produced it. Counting it here as well is
 * what made a fork report its parent's turns, tool calls and spend a second time; the copied row is
 * still shown in the transcript, it just does not belong to this session's numbers.
 */
function inherited(item: TranscriptItem, session: SessionMeta): boolean {
  return item.ts < session.createdAt;
}

export function sessionUsageStats(session: SessionMeta, items: readonly TranscriptItem[]): SessionUsageStats {
  const stats: SessionUsageStats = {
    turns: { total: 0, completed: 0, interrupted: 0, failed: 0, timed: 0, totalMs: 0, longestMs: 0, costUsd: 0 },
    carried: { turns: 0 },
    tools: { total: 0, done: 0, errors: 0, declined: 0, running: 0, totalMs: 0, timed: 0, byName: [], byHint: [] },
    files: { touched: 0, add: 0, update: 0, delete: 0, rename: 0 },
    approvals: { total: 0, allowed: 0, denied: 0 },
    messages: { user: 0, assistant: 0 },
    errors: [],
    warnings: 0,
    series: []
  };
  const byName = new Map<string, ToolStat>();
  const byHint = new Map<ToolKindHint, HintStat>();
  const seenFiles = new Set<string>();
  let toolsThisTurn = 0;

  for (const item of items) {
    if (inherited(item, session)) {
      if (item.kind === 'turn') stats.carried.turns++;
      continue;
    }
    switch (item.kind) {
      case 'user':
        stats.messages.user++;
        break;
      case 'assistant':
        if (!item.streaming) stats.messages.assistant++;
        break;
      case 'tool': {
        const hint = item.hint ?? 'other';
        toolsThisTurn++;
        stats.tools.total++;
        if (item.status === 'error') stats.tools.errors++;
        else if (item.status === 'declined') stats.tools.declined++;
        else if (item.status === 'running') stats.tools.running++;
        else stats.tools.done++;
        const ms = item.durationMs ?? 0;
        if (ms > 0) {
          stats.tools.totalMs += ms;
          stats.tools.timed++;
        }
        const name = item.title?.trim() || item.name;
        const stat = byName.get(name) ?? { name, hint, calls: 0, errors: 0, declined: 0, totalMs: 0, timed: 0, files: 0 };
        stat.calls++;
        if (item.status === 'error') stat.errors++;
        if (item.status === 'declined') stat.declined++;
        if (ms > 0) {
          stat.totalMs += ms;
          stat.timed++;
        }
        const hs = byHint.get(hint) ?? { hint, calls: 0, errors: 0, totalMs: 0 };
        hs.calls++;
        if (item.status === 'error') hs.errors++;
        hs.totalMs += ms;
        byHint.set(hint, hs);
        for (const change of item.changes ?? []) {
          stat.files++;
          stats.files[change.kind]++;
          seenFiles.add(change.path);
        }
        byName.set(name, stat);
        if (item.status === 'error') stats.errors.push({ id: item.id, ts: item.ts, source: 'tool', label: name, detail: toolDetail(item) });
        break;
      }
      case 'approval': {
        stats.approvals.total++;
        // The decision only carries the chosen option id; the ladder ('allow', 'deny', …) lives on
        // the option itself, and falls back to the id for adapters that name options after it.
        const decided = item.decision?.optionId;
        const kind = decided ? (item.request.options.find((o) => o.id === decided)?.kind ?? decided) : undefined;
        if (kind?.startsWith('allow')) stats.approvals.allowed++;
        else if (kind?.startsWith('deny')) stats.approvals.denied++;
        break;
      }
      case 'info':
        if (item.level === 'warn') stats.warnings++;
        break;
      case 'turn': {
        stats.turns.total++;
        stats.turns[item.status]++;
        const ms = item.durationMs ?? 0;
        if (ms > 0) {
          stats.turns.timed++;
          stats.turns.totalMs += ms;
          stats.turns.longestMs = Math.max(stats.turns.longestMs, ms);
        }
        stats.turns.costUsd += item.costUsd ?? 0;
        stats.series.push({
          id: item.id,
          ts: item.ts,
          status: item.status,
          costUsd: item.costUsd ?? 0,
          durationMs: ms,
          inputTokens: item.usage?.inputTokens ?? 0,
          outputTokens: item.usage?.outputTokens ?? 0,
          tools: toolsThisTurn
        });
        toolsThisTurn = 0;
        if (item.status === 'failed') stats.errors.push({ id: item.id, ts: item.ts, source: 'turn', label: 'Turn failed', detail: firstLine(item.error) || 'The harness ended the turn with an error.' });
        break;
      }
      default:
        break;
    }
  }

  // The session's last error survives a restart even when the transcript item that produced it was
  // trimmed, so surface it when nothing in the transcript already says the same thing.
  if (session.lastError && !stats.errors.some((e) => e.detail === firstLine(session.lastError))) {
    stats.errors.push({ id: `${session.id}:last`, ts: session.updatedAt, source: 'session', label: 'Last session error', detail: firstLine(session.lastError) });
  }

  stats.files.touched = seenFiles.size;
  stats.tools.byName = [...byName.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  stats.tools.byHint = HINT_ORDER.map((hint) => byHint.get(hint)).filter((h): h is HintStat => h !== undefined);
  stats.errors.sort((a, b) => b.ts - a.ts);
  stats.errors = stats.errors.slice(0, MAX_ERRORS);
  return stats;
}

/** Errors + declines + failed turns: the one number the panel leads its reliability block with. */
export function failureCount(stats: SessionUsageStats): number {
  return stats.tools.errors + stats.tools.declined + stats.turns.failed;
}

/** Share of tool calls that finished cleanly; null until a call has settled. */
export function toolSuccessRate(stats: SessionUsageStats): number | null {
  const settled = stats.tools.done + stats.tools.errors + stats.tools.declined;
  return settled > 0 ? stats.tools.done / settled : null;
}

/** Share of recorded turns that completed; null before the first turn ends. */
export function turnSuccessRate(stats: SessionUsageStats): number | null {
  return stats.turns.total > 0 ? stats.turns.completed / stats.turns.total : null;
}

/** Cache reads as a share of everything the model read, which is what makes a long session cheap. */
export function cacheHitRate(usage: SessionMeta['usage']): number | null {
  const read = usage.inputTokens + usage.cacheReadTokens;
  return read > 0 ? usage.cacheReadTokens / read : null;
}
