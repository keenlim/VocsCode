/**
 * Real installed Pi 0.85.1, RPC mode, offline scripted provider: the Vocs Code subagents extension is
 * loaded the way the app loads it, spawns a real child agent session in-process, and the run lands as
 * a run file plus a tool result.
 *
 * Opt-in: `VOCS_CODE_PI_INTEGRATION=1`. A selected but missing runtime fails, never skips.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PiOfflineRunner, piIntegrationPaths, type PiEvent, type ScriptedCall } from './pi-offline-runner';
import { parseRunFile } from '../src/shared/subagents';

const enabled = process.env.VOCS_CODE_PI_INTEGRATION === '1';
const call = (id: string, name: string, args: Record<string, unknown>): ScriptedCall => ({ id, name, arguments: args });
const text = (event: PiEvent) => (event.result?.content ?? []).map((part: PiEvent) => part.text ?? '').join('\n');

describe.skipIf(!enabled)('Vocs Code subagents over the real Pi runtime', () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  const runners: PiOfflineRunner[] = [];

  beforeAll(() => {
    piIntegrationPaths();
  });
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'vocs-pi-subagents-'));
    cwd = path.join(root, 'workspace');
    agentDir = path.join(root, 'agent');
    await fs.mkdir(cwd);
    await fs.mkdir(agentDir);
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  });
  afterEach(async () => {
    await Promise.all(runners.splice(0).map((runner) => runner.close()));
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  const start = (options: Partial<ConstructorParameters<typeof PiOfflineRunner>[0]> = {}) => {
    const runner = new PiOfflineRunner({ cwd, agentDir, ...options });
    runners.push(runner);
    return runner;
  };

  it('registers the subagent tools alongside the third-party ones (coexistence, not replacement)', async () => {
    const runner = start();
    await runner.ready();
    const advertised = runner.events
      .filter((event) => event.type === 'extension_ui_request' && event.message?.startsWith('PI_FIXTURE_TOOLS::'))
      .flatMap((event) => (JSON.parse(event.message.slice('PI_FIXTURE_TOOLS::'.length)) as { tools: { name: string }[] }).tools.map((tool) => tool.name));
    expect(advertised).toContain('subagent');
    expect(advertised).toContain('subagent_result');
    expect(advertised).toContain('subagent_steer');
    expect(runner.events.filter((event) => event.type === 'extension_error')).toEqual([]);
  });

  it('runs a queued foreground child, returns its output and writes a parseable run record', async () => {
    const runner = start();
    await runner.ready();
    const events = await runner.prompt([
      call('s1', 'subagent', { description: 'Find the registry', prompt: 'Where is the harness registry?', type: 'Explore' }),
    ]);
    const ended = events.filter((event) => event.type === 'tool_execution_end');
    expect(ended).toHaveLength(1);
    expect(ended[0].isError).toBe(false);
    // The scripted provider answers any child turn with COMPAT_OK, so the child's answer is the result.
    expect(text(ended[0])).toContain('COMPAT_OK');
    expect(text(ended[0])).toContain('Explore completed');
    expect(ended[0].result?.details).toMatchObject({ agent: 'Explore', status: 'completed', turns: 1 });
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'extension_error')).toEqual([]);

    const dir = path.join(agentDir, 'subagents');
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    const parsed = parseRunFile(await fs.readFile(path.join(dir, files[0]!), 'utf8'))!;
    expect(parsed.meta).toMatchObject({ agent: 'Explore', mode: 'foreground', description: 'Find the registry' });
    expect(parsed.status).toBe('completed');
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]!.model).toBe('scripted');
    expect(parsed.totals.turns).toBe(1);
  });

  it('rejects an unknown agent type without running anything', async () => {
    const runner = start();
    await runner.ready();
    const events = await runner.prompt([
      call('s1', 'subagent', { description: 'Nope', prompt: 'x', type: 'ghost' }),
    ]);
    const ended = events.filter((event) => event.type === 'tool_execution_end');
    expect(ended).toHaveLength(1);
    expect(ended[0].isError).toBe(true);
    expect(text(ended[0])).toContain('Unknown subagent type "ghost"');
    await expect(fs.readdir(path.join(agentDir, 'subagents'))).rejects.toThrow();
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
  });

  it('gates a child command in ask mode: an approved command runs, a denied one never does', async () => {
    const allowed = start({ mode: 'ask', choice: (payload: PiEvent) => (String(payload.summary).includes('allow-me') ? 'Allow once' : 'Deny') });
    await allowed.ready();
    // The child's first model call is scripted by the same fixture the parent uses, so the child asks
    // its gate for a real bash command. The second child turn sees a tool result and answers with text.
    const childPrompt = JSON.stringify({ calls: [call('c1', 'bash', { command: 'echo allow-me' })] });
    let events = await allowed.prompt([call('s1', 'subagent', { description: 'Run a command', prompt: childPrompt, type: 'general-purpose' })]);
    const approvals = events.filter((event) => event.type === 'extension_ui_request' && event.title?.startsWith('VCODE_APPROVAL::')).map((event) => JSON.parse(event.title.slice('VCODE_APPROVAL::'.length)) as Record<string, unknown>);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ tool: 'bash', agent: 'general-purpose' });
    expect(String(approvals[0]!.runId)).toMatch(/^agent_/);
    const readRuns = async () => {
      const dir = path.join(agentDir, 'subagents');
      const files = await fs.readdir(dir).catch(() => [] as string[]);
      return Promise.all(files.map(async (file) => parseRunFile(await fs.readFile(path.join(dir, file), 'utf8'))!));
    };
    const bashItem = (status: string) => (run: Awaited<ReturnType<typeof readRuns>>[number]) => run.items.some((item) => item.kind === 'tool' && item.name === 'bash' && item.status === status);
    // Allow once: the child's command reached the real bash tool.
    expect((await readRuns()).some(bashItem('done'))).toBe(true);
    expect(events.filter((event) => event.type === 'extension_error')).toEqual([]);

    const denied = start({ mode: 'ask', choice: () => 'Deny' });
    await denied.ready();
    events = await denied.prompt([call('s1', 'subagent', { description: 'Run a command', prompt: childPrompt, type: 'general-purpose' })]);
    expect(events.filter((event) => event.type === 'extension_ui_request' && event.title?.startsWith('VCODE_APPROVAL::'))).toHaveLength(1);
    // Deny: the child saw a declined result and the command never reached the tool, so no run shows
    // the bash call as done. The parent's own subagent call is the only tool the parent executed.
    const runs = await readRuns();
    expect(runs.filter(bashItem('done'))).toHaveLength(1); // only the allowed run from this test
    expect(runs.filter(bashItem('error')).length).toBeGreaterThanOrEqual(1);
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
  });
});
