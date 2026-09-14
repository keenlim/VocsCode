/**
 * Failure incidents: one agent mistake usually shows up as several tool calls (the failure, retries,
 * a probe, the fix). Grouping them answers "did the agent recover, and what did it cost" instead of
 * counting the same mistake three times.
 *
 * Deterministic rules, applied per session in timestamp order:
 *  - an unexpected failure (outcome `failure`) opens an incident keyed by logical operation and
 *    the executable or tool it used;
 *  - a later failure with the same key in the same turn extends it (one more attempt);
 *  - a later success, informational or diagnostic result with the same key closes it as recovered;
 *  - any other call in between counts as an intervening call;
 *  - a turn boundary, the end of the session's records, or WINDOW calls without resolution close
 *    it as unrecovered.
 */
import type { ErrorCategory, ErrorSource } from './taxonomy';
import type { ExecutionRecord } from './records';
import { isExecution } from './records';

/** Calls after the first failure before an unresolved incident is closed as unrecovered. */
export const INCIDENT_WINDOW = 12;
/** Recovered within this many calls counts as immediate. */
export const IMMEDIATE_RECOVERY_CALLS = 2;

export interface Incident {
  id: string;
  sessionId: string;
  turn: number;
  harness: string;
  harnessVersion?: string;
  model?: string;
  projectRoot: string;
  /** Shell the failing call ran in, for shell executions. */
  shell?: string;
  /** `operation|subject`, the identity a retry is matched on. */
  key: string;
  category: ErrorCategory;
  source: ErrorSource;
  signature: string;
  firstTs: number;
  lastTs: number;
  /** Ids of the failed executions in the incident. */
  executionIds: string[];
  /** Failed attempts, the first included. */
  attempts: number;
  /** Calls with another key between the first failure and the resolution. */
  intervening: number;
  recovered: boolean;
  /** Calls from the first failure (exclusive) to the recovering call (inclusive). */
  recoveryCalls?: number;
  recoveryMs?: number;
  immediate: boolean;
  /** Calls the failure cost beyond the one that finally worked: retries plus intervening calls. */
  extraCalls: number;
  extraMs: number;
  closedBy: 'success' | 'turn_end' | 'window' | 'session_end';
}

/** Identity a retry is matched on: what the agent was doing and with what. */
export function incidentKey(r: ExecutionRecord): string {
  const subject = r.facts.physical === 'shell' ? r.facts.cmd?.last ?? r.facts.cmd?.exe ?? 'shell' : r.facts.toolKey;
  return `${r.facts.operation}|${subject}`;
}

interface Open {
  incident: Incident;
  callsSinceFirst: number;
}

function close(open: Open, by: Incident['closedBy'], lastTs: number): Incident {
  const inc = open.incident;
  inc.closedBy = by;
  inc.lastTs = Math.max(inc.lastTs, lastTs);
  inc.extraCalls = inc.attempts - 1 + inc.intervening;
  inc.extraMs = Math.max(0, inc.lastTs - inc.firstTs);
  return inc;
}

/** Builds incidents from every session's executions; input order does not matter. */
export function buildIncidents(records: ExecutionRecord[]): Incident[] {
  const bySession = new Map<string, ExecutionRecord[]>();
  for (const r of records) {
    if (!isExecution(r)) continue;
    const list = bySession.get(r.sessionId) ?? [];
    list.push(r);
    bySession.set(r.sessionId, list);
  }
  const out: Incident[] = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => a.ts - b.ts || a.endTs - b.endTs || a.id.localeCompare(b.id));
    const open = new Map<string, Open>();
    let turn = list[0]?.turn ?? 0;
    let lastTs = list[0]?.ts ?? 0;
    const closeAll = (by: Incident['closedBy'], ts: number) => {
      for (const o of open.values()) out.push(close(o, by, ts));
      open.clear();
    };
    for (const r of list) {
      if (r.turn !== turn) {
        closeAll('turn_end', lastTs);
        turn = r.turn;
      }
      lastTs = r.endTs || r.ts;
      const key = incidentKey(r);
      const outcome = r.derived.outcome;
      if (outcome === 'failure') {
        const o = open.get(key);
        if (o) {
          o.incident.attempts += 1;
          o.incident.executionIds.push(r.id);
          o.incident.lastTs = lastTs;
          o.callsSinceFirst += 1;
        } else {
          open.set(key, {
            callsSinceFirst: 0,
            incident: {
              id: r.id,
              sessionId: r.sessionId,
              turn: r.turn,
              harness: r.harness,
              harnessVersion: r.harnessVersion,
              model: r.model,
              projectRoot: r.projectRoot,
              shell: r.facts.physical === 'shell' ? r.facts.shell : undefined,
              key,
              category: r.derived.category ?? 'unknown_failure',
              source: r.derived.source,
              signature: r.derived.signature,
              firstTs: r.ts,
              lastTs,
              executionIds: [r.id],
              attempts: 1,
              intervening: 0,
              recovered: false,
              immediate: false,
              extraCalls: 0,
              extraMs: 0,
              closedBy: 'session_end'
            }
          });
        }
        // Every other open incident saw one more call go by.
        for (const [k, o] of open) if (k !== key) bump(o, out, open, k, lastTs);
        continue;
      }
      const resolves = outcome === 'success' || outcome === 'informational' || outcome === 'diagnostic';
      const same = open.get(key);
      if (same && resolves) {
        same.callsSinceFirst += 1;
        same.incident.recovered = true;
        same.incident.recoveryCalls = same.callsSinceFirst;
        same.incident.recoveryMs = Math.max(0, lastTs - same.incident.firstTs);
        same.incident.immediate = same.callsSinceFirst <= IMMEDIATE_RECOVERY_CALLS;
        out.push(close(same, 'success', lastTs));
        open.delete(key);
      }
      for (const [k, o] of open) if (k !== key || !resolves) bump(o, out, open, k, lastTs);
    }
    closeAll('session_end', lastTs);
  }
  return out.sort((a, b) => a.firstTs - b.firstTs || a.id.localeCompare(b.id));
}

/** Counts an intervening call for an open incident, closing it when the window runs out. */
function bump(o: Open, out: Incident[], open: Map<string, Open>, key: string, ts: number): void {
  o.callsSinceFirst += 1;
  o.incident.intervening += 1;
  if (o.callsSinceFirst >= INCIDENT_WINDOW) {
    out.push(close(o, 'window', ts));
    open.delete(key);
  }
}

export interface IncidentCounts {
  incidents: number;
  recovered: number;
  unrecovered: number;
  immediate: number;
  /** Sum of failed attempts across incidents (the raw calls the incidents cover). */
  attempts: number;
  extraCalls: number;
  extraMs: number;
  recoveryMs: number[];
  recoveryCalls: number[];
  bySource: Record<string, number>;
  unrecoveredBySource: Record<string, number>;
}

export function emptyIncidentCounts(): IncidentCounts {
  return { incidents: 0, recovered: 0, unrecovered: 0, immediate: 0, attempts: 0, extraCalls: 0, extraMs: 0, recoveryMs: [], recoveryCalls: [], bySource: {}, unrecoveredBySource: {} };
}

export function countIncident(into: IncidentCounts, inc: Incident): void {
  into.incidents += 1;
  into.attempts += inc.attempts;
  into.extraCalls += inc.extraCalls;
  into.extraMs += inc.extraMs;
  into.bySource[inc.source] = (into.bySource[inc.source] ?? 0) + 1;
  if (inc.recovered) {
    into.recovered += 1;
    if (inc.immediate) into.immediate += 1;
    if (inc.recoveryMs !== undefined) into.recoveryMs.push(inc.recoveryMs);
    if (inc.recoveryCalls !== undefined) into.recoveryCalls.push(inc.recoveryCalls);
  } else {
    into.unrecovered += 1;
    into.unrecoveredBySource[inc.source] = (into.unrecoveredBySource[inc.source] ?? 0) + 1;
  }
}

/** Percentile of a sample by nearest rank; null for an empty sample. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
