/**
 * Reliability aggregation over execution, turn and incident records. Every rate carries its
 * numerator, denominator and a Wilson 95% interval, so nothing on the dashboard is a bare
 * percentage. Pure and deterministic: the same records always give the same report.
 */
import { buildIncidents, countIncident, emptyIncidentCounts, mean, percentile, type Incident, type IncidentCounts } from './incidents';
import { EXECUTION_RETENTION, isExecution, type ExecutionRecord, type TurnRecord } from './records';
import { OUTCOME_CLASSIFIER_VERSION, type ErrorCategory, type ErrorSource, type LogicalOperation, type OutcomeClass, type PhysicalTool } from './taxonomy';

export type SampleConfidence = 'insufficient' | 'very_low' | 'low' | 'ok';

/** Sample-size bands shown next to every rate: below 20 the number is noise. */
export const SAMPLE_BANDS: { max: number; confidence: SampleConfidence }[] = [
  { max: 20, confidence: 'insufficient' },
  { max: 50, confidence: 'very_low' },
  { max: 100, confidence: 'low' }
];

export interface Rate {
  n: number;
  d: number;
  /** n / d, or null when nothing was measured. */
  rate: number | null;
  /** Wilson 95% interval, null with the rate. */
  lo: number | null;
  hi: number | null;
  confidence: SampleConfidence;
}

export function sampleConfidence(d: number): SampleConfidence {
  for (const b of SAMPLE_BANDS) if (d < b.max) return b.confidence;
  return 'ok';
}

/** Wilson score interval for a binomial proportion at 95%. */
export function wilson(n: number, d: number, z = 1.959964): { lo: number; hi: number } {
  if (d <= 0) return { lo: 0, hi: 1 };
  const p = n / d;
  const z2 = z * z;
  const denom = 1 + z2 / d;
  const centre = (p + z2 / (2 * d)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / d + z2 / (4 * d * d))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export function rate(n: number, d: number): Rate {
  if (d <= 0) return { n, d, rate: null, lo: null, hi: null, confidence: 'insufficient' };
  const { lo, hi } = wilson(n, d);
  return { n, d, rate: n / d, lo, hi, confidence: sampleConfidence(d) };
}

/** Outcome tallies for one group of executions. */
export interface OutcomeCounts {
  /** Records that were real executions and not declined. */
  executed: number;
  declined: number;
  /** Executions the harness flagged as errors (the legacy "error" count). */
  rawErrorStatus: number;
  /** Shell executions whose exit code is known, and how many of those were non-zero. */
  exitKnown: number;
  nonZero: number;
  success: number;
  informational: number;
  diagnostic: number;
  failure: number;
  control: number;
  unknown: number;
  byCategory: Partial<Record<ErrorCategory, number>>;
  /** Failures by attributed source (class `failure` only). */
  failureBySource: Partial<Record<ErrorSource, number>>;
  /** Failures the rules reached with low confidence. */
  lowConfidenceFailures: number;
  /** Executions classified from stored facts rather than at ingest (legacy transcripts). */
  backfilled: number;
  durationMs: number;
  timed: number;
  sessions: Set<string>;
}

export function emptyOutcomeCounts(): OutcomeCounts {
  return { executed: 0, declined: 0, rawErrorStatus: 0, exitKnown: 0, nonZero: 0, success: 0, informational: 0, diagnostic: 0, failure: 0, control: 0, unknown: 0, byCategory: {}, failureBySource: {}, lowConfidenceFailures: 0, backfilled: 0, durationMs: 0, timed: 0, sessions: new Set() };
}

/** The one place a record turns into counters, so every table shares the same denominators. */
export function countOutcome(into: OutcomeCounts, r: ExecutionRecord): void {
  // Delegated-run summaries are volume, not executions; they never enter a denominator.
  if (!isExecution(r)) return;
  into.sessions.add(r.sessionId);
  if (r.ingest === 'backfill') into.backfilled += 1;
  if (r.facts.status === 'declined') {
    into.declined += 1;
    return;
  }
  into.executed += 1;
  if (r.facts.status === 'error') into.rawErrorStatus += 1;
  if (r.facts.physical === 'shell' && typeof r.facts.exitCode === 'number') {
    into.exitKnown += 1;
    if (r.facts.exitCode !== 0) into.nonZero += 1;
  }
  into[r.derived.outcome] += 1;
  if (r.derived.category) into.byCategory[r.derived.category] = (into.byCategory[r.derived.category] ?? 0) + 1;
  if (r.derived.outcome === 'failure') {
    into.failureBySource[r.derived.source] = (into.failureBySource[r.derived.source] ?? 0) + 1;
    if (r.derived.confidence === 'low') into.lowConfidenceFailures += 1;
  }
  if (typeof r.facts.durationMs === 'number' && r.facts.durationMs > 0) {
    into.durationMs += r.facts.durationMs;
    into.timed += 1;
  }
}

export interface TurnCounts {
  closed: number;
  completed: number;
  failed: number;
  interrupted: number;
  open: number;
  /** Closed turns with at least one unexpected failure, and how many of those still completed. */
  withFailure: number;
  completedWithFailure: number;
  withUnrecovered: number;
  completedWithUnrecovered: number;
  /** Closed turns blocked (failed/interrupted) whose incidents were attributed to each source. */
  blockedBySource: Partial<Record<ErrorSource, number>>;
  toolCalls: number;
  failures: number;
  incidents: number;
  durationMs: number;
}

export function emptyTurnCounts(): TurnCounts {
  return { closed: 0, completed: 0, failed: 0, interrupted: 0, open: 0, withFailure: 0, completedWithFailure: 0, withUnrecovered: 0, completedWithUnrecovered: 0, blockedBySource: {}, toolCalls: 0, failures: 0, incidents: 0, durationMs: 0 };
}

/** Rates derived from the counters of one group; formulas are documented in docs/ANALYTICS-RELIABILITY.md. */
export interface GroupRates {
  rawErrorStatus: Rate;
  rawNonZero: Rate;
  unexpectedFailure: Rate;
  informational: Rate;
  diagnostic: Rate;
  unknown: Rate;
  control: Rate;
  harnessFailure: Rate;
  modelFailure: Rate;
  environmentFailure: Rate;
  incident: Rate;
  recovery: Rate;
  immediateRecovery: Rate;
  unrecovered: Rate;
  turnCompleted: Rate;
  turnCompletedAfterFailure: Rate;
}

export interface ReliabilityRow {
  key: string;
  label: string;
  counts: Omit<OutcomeCounts, 'sessions'> & { sessions: number };
  incidents: Omit<IncidentCounts, 'recoveryMs' | 'recoveryCalls'> & { medianRecoveryMs: number | null; p95RecoveryMs: number | null; meanRecoveryCalls: number | null };
  turns?: TurnCounts;
  rates: GroupRates;
}

export interface SignatureRow {
  signature: string;
  category: ErrorCategory;
  source: ErrorSource;
  outcome: OutcomeClass;
  count: number;
  sessions: number;
  harnesses: string[];
  models: string[];
  firstSeen: number;
  lastSeen: number;
  /** Incidents opened by this signature and how many recovered. */
  incidents: number;
  recovered: number;
  /** Ids of up to five representative executions, most recent first. */
  examples: string[];
  confidence: Record<string, number>;
}

export interface TrendPoint {
  date: string;
  executed: number;
  rawErrorStatus: number;
  failure: number;
  informational: number;
  diagnostic: number;
  unknown: number;
  control: number;
  incidents: number;
  recovered: number;
}

export interface RegressionFlag {
  /** `harness`, `harness|model` or `harness@version`. */
  scope: string;
  label: string;
  metric: 'unexpectedFailure';
  recent: Rate;
  baseline: Rate;
  /** Absolute change in rate, recent minus baseline. */
  delta: number;
}

export interface ReliabilityReport {
  schemaVersion: number;
  classifierVersion: number;
  /** What the report is built from. */
  coverage: {
    records: number;
    executions: number;
    delegatedCalls: number;
    firstTs?: number;
    lastTs?: number;
    /** Range requested, in days (0 = everything retained). */
    rangeDays: number;
    /** True when the retained log starts after the requested range does. */
    truncated: boolean;
    retention: { maxRecords: number; maxDays: number };
    classifierVersions: Record<string, number>;
    legacyUnclassified: number;
    backfilled: number;
    /** Records whose facts include an exit code, by how it was obtained. */
    exitSources: Record<string, number>;
  };
  overall: ReliabilityRow;
  byHarness: ReliabilityRow[];
  byModel: ReliabilityRow[];
  byHarnessModel: ReliabilityRow[];
  byHarnessVersion: ReliabilityRow[];
  byPhysicalTool: ReliabilityRow[];
  byOperation: ReliabilityRow[];
  /** Shell executions grouped by the executable that owned the exit. */
  byExecutable: ReliabilityRow[];
  byExitCode: ReliabilityRow[];
  byShell: ReliabilityRow[];
  /** Shell executions by harness and the shell that ran them (`codex|powershell`). */
  byHarnessShell: ReliabilityRow[];
  byOs: ReliabilityRow[];
  byComplexity: ReliabilityRow[];
  byShellMismatch: ReliabilityRow[];
  byProject: ReliabilityRow[];
  /** Non-success executions by category and by source, across everything in scope. */
  categories: { category: ErrorCategory; outcome: OutcomeClass; count: number; sessions: number }[];
  sources: { source: ErrorSource; count: number; unrecovered: number }[];
  signatures: SignatureRow[];
  trend: TrendPoint[];
  trendByHarness: Record<string, TrendPoint[]>;
  regressions: RegressionFlag[];
  turns: TurnCounts;
}

export interface ReliabilityOptions {
  /** Now, for the range and regression windows. */
  now: number;
  /** Days back from now to include; 0 = every retained record. */
  rangeDays: number;
  retention: { maxRecords: number; maxDays: number };
  /** Retained log bounds (before range filtering), for the truncation note. */
  retainedFirstTs?: number;
  signatureLimit?: number;
  exampleLimit?: number;
}

const DAY_MS = 86_400_000;

export function utcDayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

interface Group {
  key: string;
  label: string;
  counts: OutcomeCounts;
  incidents: IncidentCounts;
  turns?: TurnCounts;
}

function group(key: string, label: string): Group {
  return { key, label, counts: emptyOutcomeCounts(), incidents: emptyIncidentCounts() };
}

function ratesOf(c: OutcomeCounts, i: IncidentCounts, t?: TurnCounts): GroupRates {
  return {
    rawErrorStatus: rate(c.rawErrorStatus, c.executed),
    rawNonZero: rate(c.nonZero, c.exitKnown),
    unexpectedFailure: rate(c.failure, c.executed),
    informational: rate(c.informational, c.executed),
    diagnostic: rate(c.diagnostic, c.executed),
    unknown: rate(c.unknown, c.executed),
    control: rate(c.control, c.executed),
    harnessFailure: rate(c.failureBySource.harness ?? 0, c.executed),
    modelFailure: rate(c.failureBySource.model ?? 0, c.executed),
    environmentFailure: rate(c.failureBySource.environment ?? 0, c.executed),
    incident: rate(i.incidents, c.executed),
    recovery: rate(i.recovered, i.incidents),
    immediateRecovery: rate(i.immediate, i.incidents),
    unrecovered: rate(i.unrecovered, c.executed),
    turnCompleted: rate(t?.completed ?? 0, t?.closed ?? 0),
    turnCompletedAfterFailure: rate(t?.completedWithFailure ?? 0, t?.withFailure ?? 0)
  };
}

function rowOf(g: Group): ReliabilityRow {
  const { sessions, ...rest } = g.counts;
  const { recoveryMs, recoveryCalls, ...inc } = g.incidents;
  return {
    key: g.key,
    label: g.label,
    counts: { ...rest, sessions: sessions.size },
    incidents: { ...inc, medianRecoveryMs: percentile(recoveryMs, 50), p95RecoveryMs: percentile(recoveryMs, 95), meanRecoveryCalls: mean(recoveryCalls) },
    turns: g.turns,
    rates: ratesOf(g.counts, g.incidents, g.turns)
  };
}

function sortRows(rows: ReliabilityRow[]): ReliabilityRow[] {
  return rows.sort((a, b) => b.counts.executed + b.counts.declined - (a.counts.executed + a.counts.declined) || a.label.localeCompare(b.label));
}

/** Groups records and incidents by a key, folding turns in when a turn key is given. */
function groupBy(records: ExecutionRecord[], incidents: Incident[], keyOf: (r: ExecutionRecord) => { key: string; label: string } | null, incidentKeyOf?: (i: Incident) => string | null, turns?: { records: TurnRecord[]; keyOf: (t: TurnRecord) => string | null; failuresByTurn: Map<string, TurnFailureInfo> }): ReliabilityRow[] {
  const groups = new Map<string, Group>();
  for (const r of records) {
    const k = keyOf(r);
    if (!k) continue;
    const g = groups.get(k.key) ?? group(k.key, k.label);
    countOutcome(g.counts, r);
    groups.set(k.key, g);
  }
  if (incidentKeyOf) {
    for (const i of incidents) {
      const k = incidentKeyOf(i);
      if (!k) continue;
      const g = groups.get(k);
      if (g) countIncident(g.incidents, i);
    }
  }
  if (turns) {
    for (const t of turns.records) {
      const k = turns.keyOf(t);
      if (!k) continue;
      const g = groups.get(k);
      if (!g) continue;
      g.turns ??= emptyTurnCounts();
      countTurn(g.turns, t, turns.failuresByTurn.get(t.id));
    }
  }
  return sortRows([...groups.values()].map(rowOf));
}

interface TurnFailureInfo {
  toolCalls: number;
  failures: number;
  incidents: number;
  unrecovered: number;
  unrecoveredSources: Set<ErrorSource>;
}

function countTurn(into: TurnCounts, t: TurnRecord, info: TurnFailureInfo | undefined): void {
  if (t.status === 'open') {
    into.open += 1;
    return;
  }
  into.closed += 1;
  into[t.status] += 1;
  if (t.endTs) into.durationMs += Math.max(0, t.endTs - t.startTs);
  if (!info) return;
  into.toolCalls += info.toolCalls;
  into.failures += info.failures;
  into.incidents += info.incidents;
  if (info.failures > 0) {
    into.withFailure += 1;
    if (t.status === 'completed') into.completedWithFailure += 1;
  }
  if (info.unrecovered > 0) {
    into.withUnrecovered += 1;
    if (t.status === 'completed') into.completedWithUnrecovered += 1;
    else for (const s of info.unrecoveredSources) into.blockedBySource[s] = (into.blockedBySource[s] ?? 0) + 1;
  }
}

function turnInfo(records: ExecutionRecord[], incidents: Incident[]): Map<string, TurnFailureInfo> {
  const map = new Map<string, TurnFailureInfo>();
  const idOf = (sessionId: string, turn: number) => `${sessionId}:turn:${turn}`;
  const get = (id: string) => {
    const cur = map.get(id) ?? { toolCalls: 0, failures: 0, incidents: 0, unrecovered: 0, unrecoveredSources: new Set<ErrorSource>() };
    map.set(id, cur);
    return cur;
  };
  for (const r of records) {
    if (!isExecution(r) || r.facts.status === 'declined') continue;
    const info = get(idOf(r.sessionId, r.turn));
    info.toolCalls += 1;
    if (r.derived.outcome === 'failure') info.failures += 1;
  }
  for (const i of incidents) {
    const info = get(idOf(i.sessionId, i.turn));
    info.incidents += 1;
    if (!i.recovered) {
      info.unrecovered += 1;
      info.unrecoveredSources.add(i.source);
    }
  }
  return map;
}

function trendOf(records: ExecutionRecord[], incidents: Incident[], startTs: number, endTs: number): TrendPoint[] {
  const byDay = new Map<string, TrendPoint>();
  const point = (date: string) => {
    const p = byDay.get(date) ?? { date, executed: 0, rawErrorStatus: 0, failure: 0, informational: 0, diagnostic: 0, unknown: 0, control: 0, incidents: 0, recovered: 0 };
    byDay.set(date, p);
    return p;
  };
  for (const r of records) {
    if (!isExecution(r) || r.facts.status === 'declined') continue;
    const p = point(utcDayOf(r.ts));
    p.executed += 1;
    if (r.facts.status === 'error') p.rawErrorStatus += 1;
    if (r.derived.outcome !== 'success') p[r.derived.outcome] += 1;
  }
  for (const i of incidents) {
    const p = point(utcDayOf(i.firstTs));
    p.incidents += 1;
    if (i.recovered) p.recovered += 1;
  }
  const out: TrendPoint[] = [];
  const first = Date.parse(`${utcDayOf(startTs)}T00:00:00Z`);
  const last = Date.parse(`${utcDayOf(endTs)}T00:00:00Z`);
  for (let t = first, i = 0; t <= last && i < 731; t += DAY_MS, i++) out.push(point(utcDayOf(t)));
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Flags groups whose unexpected-failure rate in the last seven days moved against the prior four
 * weeks: both windows need at least MIN_REGRESSION_SAMPLE executions, the change must be at least
 * two percentage points and half the baseline, and the Wilson intervals must not overlap.
 */
export const MIN_REGRESSION_SAMPLE = 50;
export const REGRESSION_RECENT_DAYS = 7;
export const REGRESSION_BASELINE_DAYS = 28;

export function detectRegressions(records: ExecutionRecord[], now: number, scopes: { scope: string; label: string; match: (r: ExecutionRecord) => boolean }[]): RegressionFlag[] {
  const recentStart = now - REGRESSION_RECENT_DAYS * DAY_MS;
  const baseStart = recentStart - REGRESSION_BASELINE_DAYS * DAY_MS;
  const out: RegressionFlag[] = [];
  for (const s of scopes) {
    let rn = 0;
    let rd = 0;
    let bn = 0;
    let bd = 0;
    for (const r of records) {
      if (!isExecution(r) || r.facts.status === 'declined' || !s.match(r)) continue;
      if (r.ts >= recentStart) {
        rd += 1;
        if (r.derived.outcome === 'failure') rn += 1;
      } else if (r.ts >= baseStart) {
        bd += 1;
        if (r.derived.outcome === 'failure') bn += 1;
      }
    }
    if (rd < MIN_REGRESSION_SAMPLE || bd < MIN_REGRESSION_SAMPLE) continue;
    const recent = rate(rn, rd);
    const baseline = rate(bn, bd);
    const delta = (recent.rate ?? 0) - (baseline.rate ?? 0);
    const relative = baseline.rate && baseline.rate > 0 ? Math.abs(delta) / baseline.rate : Math.abs(delta) > 0 ? Infinity : 0;
    const disjoint = delta > 0 ? (recent.lo ?? 0) > (baseline.hi ?? 1) : (recent.hi ?? 1) < (baseline.lo ?? 0);
    if (Math.abs(delta) >= 0.02 && relative >= 0.5 && disjoint) out.push({ scope: s.scope, label: s.label, metric: 'unexpectedFailure', recent, baseline, delta });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/** Label of a `provider/model` key for tables; history without a provider keeps the bare id. */
function modelLabel(key: string): string {
  return key.startsWith('/') ? key.slice(1) : key;
}

/** Builds the full report for the records in range. */
export function reliabilityReport(all: ExecutionRecord[], allTurns: TurnRecord[], opts: ReliabilityOptions): ReliabilityReport {
  const start = opts.rangeDays > 0 ? opts.now - opts.rangeDays * DAY_MS : -Infinity;
  const records = all.filter((r) => r.ts >= start);
  const turns = allTurns.filter((t) => t.startTs >= start);
  const executions = records.filter(isExecution);
  const incidents = buildIncidents(records);
  const failuresByTurn = turnInfo(records, incidents);

  const overallGroup = group('all', 'All');
  for (const r of records) countOutcome(overallGroup.counts, r);
  for (const i of incidents) countIncident(overallGroup.incidents, i);
  overallGroup.turns = emptyTurnCounts();
  for (const t of turns) countTurn(overallGroup.turns, t, failuresByTurn.get(t.id));

  const harnessKey = (r: { harness: string }) => ({ key: r.harness, label: r.harness });
  const modelKey = (r: { model?: string }) => (r.model ? { key: r.model, label: modelLabel(r.model) } : null);
  const harnessModelKey = (r: { harness: string; model?: string }) => (r.model ? { key: `${r.harness}|${r.model}`, label: `${r.harness} · ${modelLabel(r.model)}` } : null);
  const versionKey = (r: { harness: string; harnessVersion?: string }) => ({ key: `${r.harness}@${r.harnessVersion ?? 'unknown'}`, label: `${r.harness} ${r.harnessVersion ?? '(version unknown)'}` });

  const byHarness = groupBy(records, incidents, harnessKey, (i) => i.harness, { records: turns, keyOf: (t) => t.harness, failuresByTurn });
  const byModel = groupBy(records, incidents, modelKey, (i) => i.model ?? null, { records: turns, keyOf: (t) => t.model ?? null, failuresByTurn });
  const byHarnessModel = groupBy(records, incidents, harnessModelKey, (i) => (i.model ? `${i.harness}|${i.model}` : null), { records: turns, keyOf: (t) => (t.model ? `${t.harness}|${t.model}` : null), failuresByTurn });
  const byHarnessVersion = groupBy(records, incidents, versionKey, (i) => `${i.harness}@${i.harnessVersion ?? 'unknown'}`);
  const byPhysicalTool = groupBy(records, incidents, (r) => ({ key: r.facts.physical, label: r.facts.physical }), (i) => null);
  const byOperation = groupBy(records, incidents, (r) => ({ key: r.facts.operation, label: r.facts.operation }), (i) => i.key.split('|')[0]);
  const shellOnly = (r: ExecutionRecord) => r.facts.physical === 'shell';
  const byExecutable = groupBy(records.filter(shellOnly), incidents.filter((i) => i.key.split('|')[1] && !i.key.endsWith('|shell')), (r) => ({ key: r.facts.cmd?.last ?? '(unknown)', label: r.facts.cmd?.last ?? '(unknown)' }), (i) => i.key.split('|')[1] ?? null);
  const byExitCode = groupBy(records.filter((r) => shellOnly(r) && typeof r.facts.exitCode === 'number'), incidents, (r) => ({ key: String(r.facts.exitCode), label: String(r.facts.exitCode) }));
  const byShell = groupBy(records.filter(shellOnly), incidents, (r) => ({ key: r.facts.shell ?? 'unknown', label: r.facts.shell ?? 'unknown' }));
  const shellIncidents = incidents.filter((i) => !i.key.endsWith('|edit') && !i.key.endsWith('|read') && !i.key.endsWith('|write'));
  const byHarnessShell = groupBy(records.filter(shellOnly), shellIncidents, (r) => ({ key: `${r.harness}|${r.facts.shell ?? 'unknown'}`, label: `${r.harness} · ${r.facts.shell ?? 'unknown'}` }), (i) => (i.shell ? `${i.harness}|${i.shell}` : null));
  const byOs = groupBy(records, incidents, (r) => ({ key: r.os, label: r.os }));
  const byComplexity = groupBy(records.filter(shellOnly), incidents, (r) => ({ key: r.facts.cmd?.complexity ?? 'unknown', label: r.facts.cmd?.complexity ?? 'unknown' }));
  const byShellMismatch = groupBy(records.filter(shellOnly), incidents, (r) => ({ key: r.facts.cmd?.shellMismatch ? 'mismatch' : 'native', label: r.facts.cmd?.shellMismatch ? 'Other shell’s idioms' : 'Native idioms' }));
  const byProject = groupBy(records, incidents, (r) => ({ key: r.projectRoot, label: r.projectRoot }), (i) => i.projectRoot, { records: turns, keyOf: (t) => t.projectRoot, failuresByTurn });

  // Categories and sources over non-success executions.
  const catMap = new Map<ErrorCategory, { count: number; sessions: Set<string>; outcome: OutcomeClass }>();
  for (const r of executions) {
    if (r.facts.status === 'declined' || !r.derived.category) continue;
    const c = catMap.get(r.derived.category) ?? { count: 0, sessions: new Set<string>(), outcome: r.derived.outcome };
    c.count += 1;
    c.sessions.add(r.sessionId);
    catMap.set(r.derived.category, c);
  }
  const categories = [...catMap.entries()].map(([category, c]) => ({ category, outcome: c.outcome, count: c.count, sessions: c.sessions.size })).sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  const srcMap = new Map<ErrorSource, { count: number; unrecovered: number }>();
  for (const r of executions) {
    if (r.derived.outcome !== 'failure') continue;
    const s = srcMap.get(r.derived.source) ?? { count: 0, unrecovered: 0 };
    s.count += 1;
    srcMap.set(r.derived.source, s);
  }
  for (const i of incidents) if (!i.recovered) srcMap.set(i.source, { count: srcMap.get(i.source)?.count ?? 0, unrecovered: (srcMap.get(i.source)?.unrecovered ?? 0) + 1 });
  const sources = [...srcMap.entries()].map(([source, s]) => ({ source, ...s })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));

  // Signatures: every non-success execution with a signature, plus incident outcomes by opening signature.
  const sigMap = new Map<string, SignatureRow & { sessionSet: Set<string>; harnessSet: Set<string>; modelSet: Set<string> }>();
  for (const r of executions) {
    if (!r.derived.signature || r.facts.status === 'declined') continue;
    const s = sigMap.get(r.derived.signature) ?? { signature: r.derived.signature, category: r.derived.category ?? 'unknown_failure', source: r.derived.source, outcome: r.derived.outcome, count: 0, sessions: 0, harnesses: [], models: [], firstSeen: r.ts, lastSeen: r.ts, incidents: 0, recovered: 0, examples: [], confidence: {}, sessionSet: new Set(), harnessSet: new Set(), modelSet: new Set() };
    s.count += 1;
    s.sessionSet.add(r.sessionId);
    s.harnessSet.add(r.harness);
    if (r.model) s.modelSet.add(r.model);
    s.firstSeen = Math.min(s.firstSeen, r.ts);
    s.lastSeen = Math.max(s.lastSeen, r.ts);
    s.confidence[r.derived.confidence] = (s.confidence[r.derived.confidence] ?? 0) + 1;
    s.examples.push(r.id);
    sigMap.set(r.derived.signature, s);
  }
  for (const i of incidents) {
    const s = sigMap.get(i.signature);
    if (!s) continue;
    s.incidents += 1;
    if (i.recovered) s.recovered += 1;
  }
  const byId = new Map(executions.map((r) => [r.id, r]));
  const exampleLimit = opts.exampleLimit ?? 5;
  const signatures: SignatureRow[] = [...sigMap.values()]
    .map(({ sessionSet, harnessSet, modelSet, ...s }) => ({
      ...s,
      sessions: sessionSet.size,
      harnesses: [...harnessSet].sort(),
      models: [...modelSet].sort(),
      examples: s.examples
        .sort((a, b) => (byId.get(b)?.ts ?? 0) - (byId.get(a)?.ts ?? 0))
        .slice(0, exampleLimit)
    }))
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen || a.signature.localeCompare(b.signature))
    .slice(0, opts.signatureLimit ?? 50);

  const tsList = executions.map((r) => r.ts);
  const firstTs = tsList.length ? Math.min(...tsList) : undefined;
  const lastTs = tsList.length ? Math.max(...tsList) : undefined;
  const trendStart = opts.rangeDays > 0 ? start : (firstTs ?? opts.now);
  const trend = trendOf(records, incidents, Math.min(trendStart, opts.now), opts.now);
  const trendByHarness: Record<string, TrendPoint[]> = {};
  for (const h of byHarness.map((r) => r.key)) trendByHarness[h] = trendOf(records.filter((r) => r.harness === h), incidents.filter((i) => i.harness === h), Math.min(trendStart, opts.now), opts.now);

  const scopes: { scope: string; label: string; match: (r: ExecutionRecord) => boolean }[] = [];
  for (const h of byHarness) scopes.push({ scope: h.key, label: h.label, match: (r) => r.harness === h.key });
  for (const hm of byHarnessModel) scopes.push({ scope: hm.key, label: hm.label, match: (r) => r.model === hm.key.split('|')[1] && r.harness === hm.key.split('|')[0] });
  for (const v of byHarnessVersion) scopes.push({ scope: v.key, label: v.label, match: (r) => `${r.harness}@${r.harnessVersion ?? 'unknown'}` === v.key });
  const regressions = detectRegressions(all, opts.now, scopes);

  const classifierVersions: Record<string, number> = {};
  const exitSources: Record<string, number> = {};
  let legacy = 0;
  let backfilled = 0;
  let delegated = 0;
  for (const r of records) {
    classifierVersions[String(r.derived.classifier)] = (classifierVersions[String(r.derived.classifier)] ?? 0) + 1;
    if (r.derived.category === 'legacy_unclassified') legacy += 1;
    if (r.ingest === 'backfill') backfilled += 1;
    if (!isExecution(r)) delegated += r.weight ?? 0;
    if (r.facts.physical === 'shell') exitSources[r.facts.exitSource] = (exitSources[r.facts.exitSource] ?? 0) + 1;
  }

  return {
    schemaVersion: 2,
    classifierVersion: OUTCOME_CLASSIFIER_VERSION,
    coverage: {
      records: records.length,
      executions: executions.length,
      delegatedCalls: delegated,
      firstTs,
      lastTs,
      rangeDays: opts.rangeDays,
      truncated: opts.retainedFirstTs !== undefined && opts.rangeDays > 0 && opts.retainedFirstTs > start && all.length >= opts.retention.maxRecords,
      retention: opts.retention,
      classifierVersions,
      legacyUnclassified: legacy,
      backfilled,
      exitSources
    },
    overall: rowOf(overallGroup),
    byHarness,
    byModel,
    byHarnessModel,
    byHarnessVersion,
    byPhysicalTool,
    byOperation,
    byExecutable,
    byExitCode,
    byShell,
    byHarnessShell,
    byOs,
    byComplexity,
    byShellMismatch,
    byProject,
    categories,
    sources,
    signatures,
    trend,
    trendByHarness,
    regressions,
    turns: overallGroup.turns
  };
}

/** A report over nothing, for stubs and loading states. */
export function emptyReliabilityReport(now = Date.now(), rangeDays = 30): ReliabilityReport {
  return reliabilityReport([], [], { now, rangeDays, retention: EXECUTION_RETENTION });
}

/** Physical tools and operations as label helpers for the UI, re-exported to keep imports short. */
export type { LogicalOperation, PhysicalTool };
