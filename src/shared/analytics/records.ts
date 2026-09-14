/**
 * Stored shapes of the execution log: one record per finished tool call and one per agent turn.
 * Raw facts and derived classification sit side by side but never mix, so a rule change can rewrite
 * `derived` from `facts` without touching what was observed.
 */
import type { ExecutionDerived, ExecutionFacts } from './classify';

export type IngestKind = 'live' | 'backfill';

/** How much of the execution log is kept: newest records first, never older than the day limit. */
export const EXECUTION_RETENTION = { maxRecords: 50_000, maxDays: 90 };

export interface ExecutionRecord {
  /** ANALYTICS_SCHEMA_VERSION at write time. */
  v: number;
  /** `${sessionId}:${toolItemId}`, unique per call across restarts. */
  id: string;
  sessionId: string;
  /** Start of the call (the transcript item's timestamp). */
  ts: number;
  /** When the terminal state was recorded. */
  endTs: number;
  harness: string;
  harnessVersion?: string;
  /** `provider/model` that generated the call, when known. */
  model?: string;
  /** The session's active model when the generating model differs (a subagent's call). */
  parentModel?: string;
  role: 'parent' | 'subagent';
  projectRoot: string;
  /** `platform-release`, e.g. `win32-10.0.26200`. */
  os: string;
  arch?: string;
  /** Turn index within the session, counting user messages; 0 before the first known one. */
  turn: number;
  ingest: IngestKind;
  facts: ExecutionFacts;
  derived: ExecutionDerived;
  /**
   * For a pi subagent completion, the number of internal tool calls it reported. Such records are
   * summaries, not executions: excluded from execution rates and shown as delegated volume.
   */
  weight?: number;
}

export interface TurnRecord {
  v: number;
  /** `${sessionId}:turn:${n}` */
  id: string;
  sessionId: string;
  turn: number;
  harness: string;
  model?: string;
  projectRoot: string;
  startTs: number;
  endTs?: number;
  /** `open` while no terminal turn item has been seen (including a session that died mid-turn). */
  status: 'completed' | 'failed' | 'interrupted' | 'open';
  ingest: IngestKind;
}

/** Whether a record is a real tool execution rather than a delegated-run summary. */
export function isExecution(r: ExecutionRecord): boolean {
  return r.weight === undefined;
}

/** `provider/model` key of a model reference, matching the usage slices. */
export function modelKeyOf(ref: { provider?: string; model?: string } | undefined): string | undefined {
  if (!ref?.model) return undefined;
  return `${ref.provider ?? ''}/${ref.model}`;
}
