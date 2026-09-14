/**
 * Incident grouping and reliability aggregation: retries fold into one incident, recovery is
 * measured, and every rate's numerator and denominator are pinned so a denominator change is caught.
 */
import { describe, expect, it } from 'vitest';
import { classifyExecution } from '../src/shared/analytics/classify';
import { buildIncidents, IMMEDIATE_RECOVERY_CALLS, INCIDENT_WINDOW } from '../src/shared/analytics/incidents';
import type { ExecutionRecord, TurnRecord } from '../src/shared/analytics/records';
import { detectRegressions, rate, reliabilityReport, sampleConfidence, wilson } from '../src/shared/analytics/reliability';
import { OUTCOME_CLASSIFIER_VERSION } from '../src/shared/analytics/taxonomy';

const T0 = Date.parse('2026-09-10T10:00:00Z');
const DAY = 86_400_000;

interface Spec {
  id: string;
  session?: string;
  harness?: string;
  model?: string;
  turn?: number;
  ts?: number;
  cmd: string;
  out?: string;
  status?: 'done' | 'error' | 'declined';
  exitCode?: number;
  version?: string;
  tool?: string;
  ingest?: 'live' | 'backfill';
}

/** A record classified from a realistic transcript item, so the aggregation is tested end to end. */
function rec(s: Spec): ExecutionRecord {
  const harness = s.harness ?? 'pi';
  const tool = s.tool ?? (harness === 'codex' ? 'shell' : 'bash');
  const status = s.status ?? (s.out === undefined ? 'done' : 'error');
  const { facts, derived } = classifyExecution({ harness, tool, hint: 'execute', status, output: s.out, exitCode: s.exitCode, input: { command: s.cmd }, platform: 'win32' });
  const ts = s.ts ?? T0;
  return {
    v: 2,
    id: s.id,
    sessionId: s.session ?? 's1',
    ts,
    endTs: ts + 100,
    harness,
    harnessVersion: s.version,
    model: s.model ?? 'p/m',
    role: 'parent',
    projectRoot: '/repo',
    os: 'win32-10',
    turn: s.turn ?? 1,
    ingest: s.ingest ?? 'live',
    facts,
    derived
  };
}

const NO_MATCH = 'Command exited with code 1';
const NOT_FOUND = (name: string) => `/usr/bin/bash: line 1: ${name}: command not found\n\nCommand exited with code 127`;
const NO_SUCH = (p: string) => `ls: cannot access '${p}': No such file or directory\n\nCommand exited with code 2`;

function turn(session: string, n: number, status: TurnRecord['status'], startTs = T0, endTs = T0 + 60_000): TurnRecord {
  return { v: 2, id: `${session}:turn:${n}`, sessionId: session, turn: n, harness: 'pi', model: 'p/m', projectRoot: '/repo', startTs, endTs: status === 'open' ? undefined : endTs, status, ingest: 'live' };
}

describe('incidents', () => {
  it('19 · a failure followed by a probe and a successful retry is one recovered incident', () => {
    const records = [
      rec({ id: 'a', ts: T0, cmd: 'rg needle wrong/path', out: 'rg: wrong/path: No such file or directory (os error 2)\n\nCommand exited with code 2' }),
      rec({ id: 'b', ts: T0 + 1000, cmd: 'pwd' }),
      rec({ id: 'c', ts: T0 + 2000, cmd: 'rg needle src' })
    ];
    const incidents = buildIncidents(records);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ key: 'search|rg', attempts: 1, intervening: 1, recovered: true, recoveryCalls: 2, recoveryMs: 2100, immediate: true, extraCalls: 1, closedBy: 'success', executionIds: ['a'] });
    expect(IMMEDIATE_RECOVERY_CALLS).toBe(2);
  });

  it('20 · repeated failures of the same operation group into one incident, whose attempts are counted', () => {
    const records = [
      rec({ id: 'a', ts: T0, cmd: 'foo --x', out: NOT_FOUND('foo') }),
      rec({ id: 'b', ts: T0 + 1000, cmd: 'foo --y', out: NOT_FOUND('foo') }),
      rec({ id: 'c', ts: T0 + 2000, cmd: 'foo', out: NOT_FOUND('foo') }),
      rec({ id: 'd', ts: T0 + 3000, cmd: 'npx foo' })
    ];
    const incidents = buildIncidents(records);
    // The correction ran through npx, a different subject, so it does not close the foo incident;
    // three calls, one mistake.
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ attempts: 3, executionIds: ['a', 'b', 'c'], recovered: false, intervening: 1, extraCalls: 3 });
    const same = buildIncidents([...records.slice(0, 3), rec({ id: 'd', ts: T0 + 3000, cmd: 'foo --z' })]);
    expect(same[0]).toMatchObject({ attempts: 3, recovered: true, recoveryCalls: 3, immediate: false, extraCalls: 2 });
  });

  it('21 · an unrecovered failure closes at the turn boundary, at the session end or when the window runs out', () => {
    const turnEnd = buildIncidents([rec({ id: 'a', ts: T0, turn: 1, cmd: 'git push', out: 'fatal: no upstream branch\n\nCommand exited with code 128' }), rec({ id: 'b', ts: T0 + 1000, turn: 2, cmd: 'git push -u origin x' })]);
    expect(turnEnd).toHaveLength(1);
    expect(turnEnd[0]).toMatchObject({ recovered: false, closedBy: 'turn_end', intervening: 0 });
    const sessionEnd = buildIncidents([rec({ id: 'a', ts: T0, cmd: 'git push', out: 'fatal: no upstream branch\n\nCommand exited with code 128' })]);
    expect(sessionEnd[0]).toMatchObject({ recovered: false, closedBy: 'session_end', extraCalls: 0 });
    const many = [rec({ id: 'f', ts: T0, cmd: 'git push', out: 'fatal: no upstream branch\n\nCommand exited with code 128' })];
    for (let i = 0; i < INCIDENT_WINDOW + 2; i++) many.push(rec({ id: `o${i}`, ts: T0 + (i + 1) * 1000, cmd: 'ls' }));
    many.push(rec({ id: 'late', ts: T0 + 100_000, cmd: 'git push -u origin x' }));
    const windowed = buildIncidents(many);
    expect(windowed).toHaveLength(1);
    expect(windowed[0]).toMatchObject({ recovered: false, closedBy: 'window', intervening: INCIDENT_WINDOW });
  });

  it('never opens incidents for informational, diagnostic, control or unknown outcomes', () => {
    const records = [
      rec({ id: 'a', ts: T0, cmd: 'rg needle src', out: NO_MATCH }),
      rec({ id: 'b', ts: T0 + 1000, cmd: 'npm test', out: 'Tests  1 failed | 3 passed (4)\n\nCommand exited with code 1' }),
      rec({ id: 'c', ts: T0 + 2000, cmd: 'sleep 100', out: 'Command aborted' }),
      rec({ id: 'd', ts: T0 + 3000, cmd: 'mystery', out: 'Command exited with code 3' })
    ];
    expect(records.map((r) => r.derived.outcome)).toEqual(['informational', 'diagnostic', 'control', 'unknown']);
    expect(buildIncidents(records)).toEqual([]);
  });
});

describe('rates and confidence', () => {
  it('carries numerator, denominator and a Wilson interval', () => {
    const r = rate(3, 62);
    expect(r.n).toBe(3);
    expect(r.d).toBe(62);
    expect(r.rate).toBeCloseTo(0.0484, 4);
    expect(r.lo).toBeCloseTo(0.0166, 3);
    expect(r.hi).toBeCloseTo(0.1333, 3);
    expect(r.confidence).toBe('low');
    expect(rate(0, 0)).toEqual({ n: 0, d: 0, rate: null, lo: null, hi: null, confidence: 'insufficient' });
    const w = wilson(42, 1764);
    expect(w.lo).toBeCloseTo(0.0177, 3);
    expect(w.hi).toBeCloseTo(0.0321, 3);
  });

  it('bands sample sizes: <20 insufficient, <50 very low, <100 low', () => {
    expect(sampleConfidence(0)).toBe('insufficient');
    expect(sampleConfidence(19)).toBe('insufficient');
    expect(sampleConfidence(20)).toBe('very_low');
    expect(sampleConfidence(49)).toBe('very_low');
    expect(sampleConfidence(50)).toBe('low');
    expect(sampleConfidence(99)).toBe('low');
    expect(sampleConfidence(100)).toBe('ok');
  });
});

describe('reliability report', () => {
  /** 62 executed calls: 52 successes, 3 unexpected failures, 4 no-match searches, 2 diagnostic reports, 1 aborted; plus 1 declined. */
  function fixture(): { records: ExecutionRecord[]; turns: TurnRecord[] } {
    const records: ExecutionRecord[] = [];
    let i = 0;
    const at = () => T0 + i++ * 1000;
    for (let k = 0; k < 51; k++) records.push(rec({ id: `ok${k}`, ts: at(), cmd: k % 2 ? 'cat README.md' : 'rg foo src' }));
    for (let k = 0; k < 4; k++) records.push(rec({ id: `nm${k}`, ts: at(), cmd: 'rg zzz src', out: NO_MATCH }));
    records.push(rec({ id: 't1', ts: at(), cmd: 'npm test', out: 'Tests  1 failed | 3 passed (4)\n\nCommand exited with code 1' }));
    records.push(rec({ id: 't2', ts: at(), cmd: 'npm run typecheck', out: "src/a.ts(1,1): error TS2304: Cannot find name 'x'.\n\nCommand exited with code 2" }));
    records.push(rec({ id: 'f1', ts: at(), cmd: 'foo', out: NOT_FOUND('foo') })); // failure, ambiguous
    records.push(rec({ id: 'f1r', ts: at(), cmd: 'foo --fixed' })); // recovers f1
    records.push(rec({ id: 'f2', ts: at(), cmd: 'ls missing/dir', out: NO_SUCH('missing/dir') })); // failure, model
    records.push(rec({ id: 'f3', ts: at(), cmd: 'pnpm i', out: NOT_FOUND('pnpm') })); // failure, environment
    records.push(rec({ id: 'ab', ts: at(), cmd: 'sleep 9', out: 'Command aborted' }));
    records.push(rec({ id: 'dc', ts: at(), cmd: 'rm -rf x', out: 'denied', status: 'declined' }));
    expect(records.filter((r) => r.facts.status !== 'declined')).toHaveLength(62);
    return { records, turns: [turn('s1', 1, 'completed')] };
  }

  it('pins every denominator: 3 / 62 = 4.8% unexpected, 62 executed, 1 declined', () => {
    const { records, turns } = fixture();
    const report = reliabilityReport(records, turns, { now: T0 + DAY, rangeDays: 30, retention: { maxRecords: 1000, maxDays: 90 } });
    const o = report.overall;
    expect(o.counts).toMatchObject({ executed: 62, declined: 1, rawErrorStatus: 10, success: 52, informational: 4, diagnostic: 2, failure: 3, control: 1, unknown: 0, sessions: 1 });
    expect(o.rates.unexpectedFailure).toMatchObject({ n: 3, d: 62 });
    expect(o.rates.unexpectedFailure.rate).toBeCloseTo(3 / 62, 6);
    expect(o.rates.rawErrorStatus).toMatchObject({ n: 10, d: 62 });
    // Exit codes came from the output text for every non-success shell call; successes carry none.
    expect(o.rates.rawNonZero).toMatchObject({ n: 9, d: 9 });
    expect(o.rates.informational).toMatchObject({ n: 4, d: 62 });
    expect(o.rates.diagnostic).toMatchObject({ n: 2, d: 62 });
    expect(o.rates.control).toMatchObject({ n: 1, d: 62 });
    expect(o.counts.failureBySource).toEqual({ ambiguous: 1, model: 1, environment: 1 });
    expect(o.rates.modelFailure).toMatchObject({ n: 1, d: 62 });
    expect(o.rates.environmentFailure).toMatchObject({ n: 1, d: 62 });
    expect(o.rates.harnessFailure).toMatchObject({ n: 0, d: 62 });
    // Three failures, three incidents (different subjects), one recovered immediately.
    expect(o.incidents).toMatchObject({ incidents: 3, recovered: 1, unrecovered: 2, immediate: 1, attempts: 3 });
    expect(o.rates.incident).toMatchObject({ n: 3, d: 62 });
    expect(o.rates.recovery).toMatchObject({ n: 1, d: 3 });
    expect(o.rates.immediateRecovery).toMatchObject({ n: 1, d: 3 });
    expect(o.rates.unrecovered).toMatchObject({ n: 2, d: 62 });
    // From the failure's start to the end of the call that recovered it (1000 ms apart, 100 ms long).
    expect(o.incidents.medianRecoveryMs).toBe(1100);
    expect(o.incidents.meanRecoveryCalls).toBe(1);
    // The one turn completed despite its failures.
    expect(report.turns).toMatchObject({ closed: 1, completed: 1, withFailure: 1, completedWithFailure: 1, withUnrecovered: 1, completedWithUnrecovered: 1, toolCalls: 62, failures: 3, incidents: 3 });
    expect(o.rates.turnCompleted).toMatchObject({ n: 1, d: 1 });
    expect(o.rates.turnCompletedAfterFailure).toMatchObject({ n: 1, d: 1 });
    // Highest count first, ties alphabetical.
    expect(report.categories.map((c) => [c.category, c.count])).toEqual([
      ['search_no_match', 4],
      ['cancelled', 1],
      ['check_failures_reported', 1],
      ['command_not_found', 1],
      ['invalid_path', 1],
      ['missing_dependency', 1],
      ['test_failures_reported', 1]
    ]);
    expect(report.sources).toEqual([
      { source: 'ambiguous', count: 1, unrecovered: 0 },
      { source: 'environment', count: 1, unrecovered: 1 },
      { source: 'model', count: 1, unrecovered: 1 }
    ]);
    expect(report.classifierVersion).toBe(OUTCOME_CLASSIFIER_VERSION);
    expect(report.coverage).toMatchObject({ records: 63, executions: 63, legacyUnclassified: 0, backfilled: 0, truncated: false });
  });

  it('lists signatures with sessions, harnesses, models, first/last seen, recovery and examples', () => {
    const { records, turns } = fixture();
    records.push(rec({ id: 'f4', session: 's2', harness: 'claude', model: 'a/opus', ts: T0 + 500_000, cmd: 'foo', out: 'Exit code 127\nbash: foo: command not found' }));
    const report = reliabilityReport(records, turns, { now: T0 + DAY, rangeDays: 30, retention: { maxRecords: 1000, maxDays: 90 } });
    const sig = report.signatures.find((s) => s.signature === 'bash | command_not_found | foo')!;
    expect(sig).toMatchObject({ category: 'command_not_found', source: 'ambiguous', outcome: 'failure', count: 2, sessions: 2, harnesses: ['claude', 'pi'], models: ['a/opus', 'p/m'], incidents: 2, recovered: 1, firstSeen: records.find((r) => r.id === 'f1')!.ts, lastSeen: T0 + 500_000 });
    expect(sig.examples).toEqual(['f4', 'f1']);
    expect(report.signatures[0].signature).toBe('bash | search_no_match | rg');
    expect(report.signatures[0].count).toBe(4);
  });

  it('22 · attributes a subagent call to its own model and keeps the parent beside it', () => {
    const parent = rec({ id: 'p', harness: 'claude', model: 'anthropic/opus', cmd: 'ls' });
    const sub = { ...rec({ id: 's', harness: 'claude', model: 'anthropic/haiku', cmd: 'foo', out: 'Exit code 127\nbash: foo: command not found' }), parentModel: 'anthropic/opus', role: 'subagent' as const };
    const report = reliabilityReport([parent, sub], [], { now: T0 + DAY, rangeDays: 30, retention: { maxRecords: 1000, maxDays: 90 } });
    expect(report.byModel.map((r) => [r.key, r.counts.executed, r.counts.failure])).toEqual([
      ['anthropic/haiku', 1, 1],
      ['anthropic/opus', 1, 0]
    ]);
  });

  it('23 · the same model under two harnesses stays two rows in the harness × model table and one in the model table', () => {
    const records = [
      rec({ id: 'a', harness: 'pi', model: 'deepseek/flash', cmd: 'rg x', out: NO_MATCH }),
      rec({ id: 'b', harness: 'codex', model: 'deepseek/flash', cmd: 'rg x', exitCode: 1, out: '' }),
      rec({ id: 'c', harness: 'codex', model: 'deepseek/flash', cmd: 'ls' , exitCode: 0, status: 'done' })
    ];
    const report = reliabilityReport(records, [], { now: T0 + DAY, rangeDays: 30, retention: { maxRecords: 1000, maxDays: 90 } });
    expect(report.byHarnessModel.map((r) => [r.key, r.counts.executed, r.counts.informational])).toEqual([
      ['codex|deepseek/flash', 2, 1],
      ['pi|deepseek/flash', 1, 1]
    ]);
    expect(report.byModel.map((r) => [r.key, r.counts.executed])).toEqual([['deepseek/flash', 3]]);
    expect(report.byShell.map((r) => [r.key, r.counts.executed])).toEqual([
      ['powershell', 2],
      ['bash', 1]
    ]);
  });

  it('25 · legacy and backfilled records are counted and reported, never reinterpreted', () => {
    const legacy = rec({ id: 'l', cmd: 'x', out: undefined, status: 'error', ingest: 'backfill' });
    expect(legacy.derived.category).toBe('legacy_unclassified');
    const report = reliabilityReport([legacy, rec({ id: 'ok', cmd: 'ls', ingest: 'backfill' })], [], { now: T0 + DAY, rangeDays: 30, retention: { maxRecords: 1000, maxDays: 90 } });
    expect(report.overall.counts).toMatchObject({ executed: 2, unknown: 1, failure: 0, backfilled: 2 });
    expect(report.coverage).toMatchObject({ legacyUnclassified: 1, backfilled: 2 });
    expect(report.overall.rates.unknown).toMatchObject({ n: 1, d: 2 });
  });

  it('excludes delegated-run summaries from execution denominators but reports their volume', () => {
    const summary: ExecutionRecord = { ...rec({ id: 'sub', tool: 'subagent', cmd: '', status: 'done' }), weight: 17 };
    summary.facts.physical = 'agent';
    const report = reliabilityReport([summary, rec({ id: 'ok', cmd: 'ls' })], [], { now: T0 + DAY, rangeDays: 30, retention: { maxRecords: 1000, maxDays: 90 } });
    expect(report.overall.counts.executed).toBe(1);
    expect(report.coverage).toMatchObject({ records: 2, executions: 1, delegatedCalls: 17 });
  });

  it('builds a daily trend and filters to the requested range', () => {
    const records = [rec({ id: 'a', ts: T0 - 5 * DAY, cmd: 'foo', out: NOT_FOUND('foo') }), rec({ id: 'b', ts: T0 - DAY, cmd: 'ls' }), rec({ id: 'c', ts: T0, cmd: 'rg x', out: NO_MATCH })];
    const report = reliabilityReport(records, [], { now: T0 + 1000, rangeDays: 3, retention: { maxRecords: 1000, maxDays: 90 } });
    expect(report.overall.counts.executed).toBe(2);
    expect(report.trend).toHaveLength(4);
    expect(report.trend.map((p) => [p.date, p.executed, p.failure, p.informational])).toEqual([
      ['2026-09-07', 0, 0, 0],
      ['2026-09-08', 0, 0, 0],
      ['2026-09-09', 1, 0, 0],
      ['2026-09-10', 1, 0, 1]
    ]);
    const all = reliabilityReport(records, [], { now: T0 + 1000, rangeDays: 0, retention: { maxRecords: 1000, maxDays: 90 } });
    expect(all.overall.counts.executed).toBe(3);
    expect(all.trend[0].date).toBe('2026-09-05');
  });

  it('flags a regression only with enough samples, a material change and disjoint intervals', () => {
    const records: ExecutionRecord[] = [];
    // Baseline: 200 calls, 2% failures over the four weeks before the last one.
    for (let i = 0; i < 200; i++) records.push(rec({ id: `b${i}`, ts: T0 - 20 * DAY + i * 60_000, cmd: i % 50 === 0 ? 'foo' : 'ls', out: i % 50 === 0 ? NOT_FOUND('foo') : undefined, version: '1.0' }));
    // Recent: 100 calls, 15% failures.
    for (let i = 0; i < 100; i++) records.push(rec({ id: `r${i}`, ts: T0 - 2 * DAY + i * 60_000, cmd: i % 7 === 0 ? 'foo' : 'ls', out: i % 7 === 0 ? NOT_FOUND('foo') : undefined, version: '1.1' }));
    const flags = detectRegressions(records, T0, [{ scope: 'pi', label: 'pi', match: (r) => r.harness === 'pi' }]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ scope: 'pi', recent: { n: 15, d: 100 }, baseline: { n: 4, d: 200 } });
    expect(flags[0].delta).toBeCloseTo(0.13, 2);
    // Too few recent calls: silence, however large the change.
    expect(detectRegressions(records.filter((r) => !r.id.startsWith('r') || Number(r.id.slice(1)) < 30), T0, [{ scope: 'pi', label: 'pi', match: () => true }])).toEqual([]);
    const report = reliabilityReport(records, [], { now: T0, rangeDays: 30, retention: { maxRecords: 1000, maxDays: 90 } });
    expect(report.regressions.map((f) => f.scope)).toEqual(expect.arrayContaining(['pi', 'pi|p/m']));
    expect(report.byHarnessVersion.map((r) => [r.key, r.counts.executed])).toEqual([
      ['pi@1.0', 200],
      ['pi@1.1', 100]
    ]);
  });
});
