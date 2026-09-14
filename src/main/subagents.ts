/**
 * Reading subagent run records written by the pi extension.
 *
 * The writer is `resources/pi/subagent-runs.ts` (copied into the packaged app and loaded by pi); this
 * is the app's reader. `tests/subagent-runs.test.ts` round-trips both so the format cannot drift.
 * Run ids come from the renderer, so every id is validated before it touches the filesystem.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parseRunFile, summarizeRun, type SubagentRun, type SubagentRunSummary } from '../shared/subagents';

export type { SubagentRunSummary };

/** Run ids are generated as `agent_<8 hex>`; anything else is refused outright. */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Run files live beside the pi session's own state: `<sessionDir>/pi/subagents` (the adapter passes
 * that path to the extension as VOCS_CODE_SUBAGENT_DIR). */
export const SUBAGENT_DIR = path.join('pi', 'subagents');
/** Bound on one listing: a session with a runaway loop should not stall the panel. */
const MAX_RUNS = 200;

export function subagentDir(sessionDir: string): string {
  return path.join(sessionDir, SUBAGENT_DIR);
}

/** True when `runId` may be used as a file name inside the run directory. */
export function isValidRunId(runId: unknown): runId is string {
  return typeof runId === 'string' && RUN_ID_RE.test(runId) && !runId.startsWith('.');
}

async function readRunFile(file: string): Promise<SubagentRun | null> {
  try {
    return parseRunFile(await fs.readFile(file, 'utf8'));
  } catch {
    return null; // unreadable or vanished between listing and reading
  }
}

/**
 * Every run recorded for a session, newest first. Missing directory means "no runs yet".
 *
 * `live` says whether the pi process that owns these runs is still alive. A run whose file has no end
 * record and whose process is gone crashed with it (an app restart, a killed session), so it is
 * reported as `interrupted` rather than pretending to still be running forever.
 */
export async function listSubagentRuns(sessionDir: string, options: { live?: boolean } = {}): Promise<SubagentRunSummary[]> {
  let files: string[];
  try {
    files = await fs.readdir(subagentDir(sessionDir));
  } catch {
    return [];
  }
  const runs: SubagentRunSummary[] = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl') || runs.length >= MAX_RUNS) continue;
    const runId = file.slice(0, -'.jsonl'.length);
    if (!isValidRunId(runId)) continue;
    const run = await readRunFile(path.join(subagentDir(sessionDir), file));
    if (run) runs.push(summarizeRun(settleStale(run, options.live !== false)));
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}

/** One run with its transcript items and per-call rows, or null when it does not exist. */
export async function readSubagentRun(sessionDir: string, runId: string, options: { live?: boolean } = {}): Promise<SubagentRun | null> {
  if (!isValidRunId(runId)) return null;
  const file = path.join(subagentDir(sessionDir), `${runId}.jsonl`);
  // Defence in depth: the id is already a safe file name, and the resolved path must stay inside.
  const dir = subagentDir(sessionDir);
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) return null;
  const run = await readRunFile(file);
  return run ? settleStale(run, options.live !== false) : null;
}

/** A run with no end record whose owner is gone was interrupted; the file itself is left untouched. */
function settleStale(run: SubagentRun, live: boolean): SubagentRun {
  if (live || run.status !== 'running') return run;
  return { ...run, status: 'interrupted', totals: run.totals };
}
