/**
 * Offline tests for the subagent run reader. Run ids arrive from the renderer, so the assertions that
 * matter most are the rejections: nothing outside the session's run directory may ever be read.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore, emptyCall, emptyTotals } from '../resources/pi/subagent-runs';
import { isValidRunId, listSubagentRuns, readSubagentRun, subagentDir } from '../src/main/subagents';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-subagents-store-'));
  tempDirs.push(dir);
  return dir;
}

async function writeRun(sessionDir: string, runId: string, options: { startedAt: number; agent?: string; status?: 'completed' | 'error' } = { startedAt: 1000 }): Promise<void> {
  const store = new RunStore(subagentDir(sessionDir));
  await store.start({ runId, agent: options.agent ?? 'Explore', description: `Task ${runId}`, mode: 'foreground', provider: 'anthropic', model: 'claude-sonnet-4-5', cwd: '/repo', startedAt: options.startedAt });
  await store.item(runId, { id: `${runId}-m0`, ts: options.startedAt + 1, kind: 'assistant', text: 'COMPAT_OK' });
  await store.call(runId, { ...emptyCall(0), provider: 'anthropic', model: 'claude-sonnet-4-5', inputTokens: 100, outputTokens: 10, costUsd: 0.02, durationMs: 500, toolsInvoked: ['grep'] });
  const totals = emptyTotals();
  totals.turns = 1;
  totals.toolUses = 2;
  totals.costUsd = 0.02;
  totals.inputTokens = 100;
  await store.end(runId, options.status ?? 'completed', totals);
  await store.flush();
}

describe('run listing', () => {
  it('returns summaries newest first with the stats the panel shows', async () => {
    const dir = await tempDir();
    await writeRun(dir, 'agent_old', { startedAt: 1000 });
    await writeRun(dir, 'agent_new', { startedAt: 5000, agent: 'Plan', status: 'error' });
    const runs = await listSubagentRuns(dir);
    expect(runs.map((run) => run.runId)).toEqual(['agent_new', 'agent_old']);
    expect(runs[0]).toMatchObject({ agent: 'Plan', status: 'error', mode: 'foreground', provider: 'anthropic', model: 'claude-sonnet-4-5', costUsd: 0.02, turns: 1, toolUses: 2 });
    expect(runs[0]!.endedAt).toBeGreaterThan(0);
  });

  it('treats a session with no runs as empty rather than an error', async () => {
    const dir = await tempDir();
    expect(await listSubagentRuns(dir)).toEqual([]);
    await fs.mkdir(subagentDir(dir), { recursive: true });
    expect(await listSubagentRuns(dir)).toEqual([]);
  });

  it('skips foreign files, directories that look like runs, and unsafe names', async () => {
    const dir = await tempDir();
    await writeRun(dir, 'agent_ok', { startedAt: 1000 });
    await fs.writeFile(path.join(subagentDir(dir), 'notes.txt'), 'not a run', 'utf8');
    await fs.writeFile(path.join(subagentDir(dir), '..jsonl'), '{"t":"run","runId":".."}', 'utf8');
    await fs.mkdir(path.join(subagentDir(dir), 'agent_dir.jsonl'), { recursive: true });
    await fs.writeFile(path.join(subagentDir(dir), 'agent_broken.jsonl'), 'not json at all\n', 'utf8');
    expect((await listSubagentRuns(dir)).map((run) => run.runId)).toEqual(['agent_ok']);
  });
});

describe('run detail', () => {
  it('returns the transcript items and per-call rows of one run', async () => {
    const dir = await tempDir();
    await writeRun(dir, 'agent_1', { startedAt: 1000 });
    const run = await readSubagentRun(dir, 'agent_1');
    expect(run).not.toBeNull();
    expect(run!.items.map((item) => item.text)).toEqual(['COMPAT_OK']);
    expect(run!.calls).toHaveLength(1);
    expect(run!.calls[0]).toMatchObject({ inputTokens: 100, outputTokens: 10, costUsd: 0.02, toolsInvoked: ['grep'] });
    expect(run!.status).toBe('completed');
  });

  it('returns null for an unknown run', async () => {
    const dir = await tempDir();
    await writeRun(dir, 'agent_1', { startedAt: 1000 });
    expect(await readSubagentRun(dir, 'agent_missing')).toBeNull();
  });

  it('never reads outside the session run directory', async () => {
    const dir = await tempDir();
    await writeRun(dir, 'agent_1', { startedAt: 1000 });
    // A run file one level up, exactly where a traversal would land.
    await fs.writeFile(path.join(dir, 'secret.jsonl'), '{"t":"run","runId":"secret","agent":"x","description":"","mode":"foreground","cwd":"/","startedAt":1}', 'utf8');
    for (const runId of ['../secret', '..\\secret', '..', '.', '', 'a/b', 'agent_1.jsonl', '.hidden', 'x'.repeat(65), 'agent 1']) {
      expect(isValidRunId(runId)).toBe(false);
      expect(await readSubagentRun(dir, runId)).toBeNull();
    }
    expect(isValidRunId('agent_1')).toBe(true);
  });
});

describe('runs whose owner is gone', () => {
  it('reports a run with no end record as interrupted once the session is not running', async () => {
    const dir = await tempDir();
    const store = new RunStore(subagentDir(dir));
    await store.start({ runId: 'agent_crash', agent: 'Explore', description: 'Killed mid-run', mode: 'background', cwd: '/repo', startedAt: 1000 });
    await store.item('agent_crash', { id: 'i1', ts: 1001, kind: 'assistant', text: 'half an answer' });
    await store.flush();

    // While the pi process is alive the run really is running…
    const live = await listSubagentRuns(dir, { live: true });
    expect(live[0]).toMatchObject({ runId: 'agent_crash', status: 'running' });
    expect((await readSubagentRun(dir, 'agent_crash', { live: true }))!.status).toBe('running');

    // …and after a restart it is interrupted, not spinning forever in the panel.
    const dead = await listSubagentRuns(dir, { live: false });
    expect(dead[0]).toMatchObject({ runId: 'agent_crash', status: 'interrupted' });
    const detail = await readSubagentRun(dir, 'agent_crash', { live: false });
    expect(detail!.status).toBe('interrupted');
    // The transcript up to the crash is kept: the file itself was never rewritten.
    expect(detail!.items.map((item) => item.text)).toEqual(['half an answer']);
    expect(await fs.readFile(path.join(subagentDir(dir), 'agent_crash.jsonl'), 'utf8')).not.toContain('"t":"end"');
  });

  it('leaves a finished run alone whatever the liveness says', async () => {
    const dir = await tempDir();
    await writeRun(dir, 'agent_done', { startedAt: 1000 });
    expect((await listSubagentRuns(dir, { live: false }))[0]).toMatchObject({ status: 'completed' });
    expect((await listSubagentRuns(dir, { live: true }))[0]).toMatchObject({ status: 'completed' });
  });
});
