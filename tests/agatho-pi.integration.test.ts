/** Agatho against the real installed Pi runtime, offline.
 *
 *  The unit suite scripts the bridge; this one proves the bridge itself: the bundled capability
 *  extension registers the allowlist, pi dispatches the calls, the app's gate answers them, and
 *  the transcript the panel renders comes back over the real RPC stream. Opt-in because it needs
 *  the inspected Pi 0.85.1 runtime installed — a selected but missing runtime is a failure, never
 *  a skip. */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentItem } from '../src/shared/agent';
import type { AppSettings, SessionMeta } from '../src/shared/types';
import { Agatho } from '../src/main/agents';
import { PiAgentRuntime } from '../src/main/agents/pi-runtime';
import { spawnTool } from '../src/main/harness/spawn';
import { defaultSettings } from '../src/main/settings';
import { piIntegrationPaths } from './pi-offline-runner';

const enabled = process.env.VOCS_CODE_PI_INTEGRATION === '1';

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

const SESSION: SessionMeta = {
  id: 's1',
  title: 'Vocs Code',
  createdAt: 1,
  updatedAt: 1,
  config: { harness: 'pi', permissionMode: 'ask', projectRoot: '.' },
  cwd: '.',
  status: 'idle',
  harnessRef: {},
  usage: { ...NO_USAGE, costUsd: 0, turns: 0 }
};

const scriptedCall = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: args });
const scriptedPrompt = (calls: unknown[]) => JSON.stringify({ calls });

async function until(predicate: () => boolean, what: string, timeout = 90_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!enabled)('Agatho on the real Pi runtime', () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let cli = '';
  const agents: Agatho[] = [];

  beforeAll(() => {
    cli = piIntegrationPaths().cli;
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'vocs-agatho-pi-'));
    cwd = path.join(root, 'workspace');
    agentDir = path.join(root, 'agent');
    await fs.mkdir(cwd);
    await fs.mkdir(agentDir);
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  });

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.dispose().catch(() => undefined)));
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  /** Real Agatho + real PiAgentRuntime; only the process launch differs (node runs the CLI). */
  function make(invoke: (channel: string, req: unknown) => Promise<unknown>) {
    const invoked: { channel: string; req: unknown }[] = [];
    const settings: AppSettings = { ...defaultSettings(), defaultHarness: 'pi', agentModel: { provider: 'vocs-offline', model: 'scripted' } };
    const fixture = path.resolve('tests/fixtures/pi-scripted-provider.mjs');
    const agent = new Agatho({
      getSettings: () => settings,
      listSessions: () => [SESSION],
      getSession: (id) => (id === SESSION.id ? SESSION : undefined),
      getSecret: async () => undefined,
      invoke: async (channel, req) => {
        invoked.push({ channel, req });
        return invoke(channel, req);
      },
      push: () => undefined,
      log: () => undefined,
      piBinary: () => cli,
      piExtension: () => path.resolve('resources/pi/vocs-code-agatho.ts'),
      piCwd: () => cwd,
      createRuntime: (opts) =>
        new PiAgentRuntime({
          ...opts,
          env: { PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_CODING_AGENT_DIR: agentDir },
          // The runtime launches the resolved binary; under test the CLI is a JS entrypoint.
          spawn: (_bin, args, spawnOpts) => spawnTool(process.execPath, [cli, '-e', fixture, '--offline', '--thinking', 'off', ...args], spawnOpts)
        })
    });
    agents.push(agent);
    return { agent, invoked };
  }

  const assistantText = (items: AgentItem[]) =>
    items.filter((i): i is Extract<AgentItem, { kind: 'assistant' }> => i.kind === 'assistant').map((i) => i.text).join('\n');

  it('runs a read capability without a proposal and reports the outcome to the model', async () => {
    const { agent, invoked } = make(async () => [SESSION]);
    await agent.send(scriptedPrompt([scriptedCall('c1', 'list_sessions', {})]), { sessionId: 's1' });
    await until(() => invoked.length === 1 && assistantText(agent.state().items).includes('COMPAT_OK'), 'the read turn to settle');
    expect(invoked.map((i) => i.channel)).toEqual(['sessions:list']);
    expect(agent.state().items.some((i) => i.kind === 'proposal')).toBe(false);
    const tool = agent.state().items.find((i): i is Extract<AgentItem, { kind: 'tool' }> => i.kind === 'tool');
    expect(tool?.ok).toBe(true);
    expect(agent.state().busy).toBe(false);
  });

  it('holds a destructive call until the user approves the proposal, then applies it', async () => {
    const { agent, invoked } = make(async () => ({ ok: true }));
    await agent.send(scriptedPrompt([scriptedCall('d1', 'delete_branch', { session_id: 's1', branch: 'old' })]), { sessionId: 's1' });
    await until(() => agent.state().items.some((i) => i.kind === 'proposal' && i.proposal.status === 'pending'), 'the proposal');
    expect(invoked).toEqual([]);
    const item = agent.state().items.find((i): i is Extract<AgentItem, { kind: 'proposal' }> => i.kind === 'proposal');
    expect(item?.proposal.actions.map((a) => a.summary)).toEqual(['Delete branch old']);
    agent.resolveProposal(item!.proposal.id, true);
    await until(() => invoked.length === 1 && assistantText(agent.state().items).includes('COMPAT_OK'), 'the approved turn to settle');
    expect(invoked[0]).toMatchObject({ channel: 'git:deleteBranch', req: { sessionId: 's1', branch: 'old', force: false } });
    const resolved = agent.state().items.find((i): i is Extract<AgentItem, { kind: 'proposal' }> => i.kind === 'proposal');
    expect(resolved?.proposal.status).toBe('applied');
    expect(resolved?.proposal.results).toEqual(['Done']);
  });

  it('invokes nothing when the user declines', async () => {
    const { agent, invoked } = make(async () => ({ ok: true }));
    await agent.send(scriptedPrompt([scriptedCall('d2', 'delete_branch', { session_id: 's1', branch: 'keep' })]), { sessionId: 's1' });
    await until(() => agent.state().items.some((i) => i.kind === 'proposal' && i.proposal.status === 'pending'), 'the proposal');
    const item = agent.state().items.find((i): i is Extract<AgentItem, { kind: 'proposal' }> => i.kind === 'proposal');
    agent.resolveProposal(item!.proposal.id, false);
    await until(() => assistantText(agent.state().items).includes('COMPAT_OK'), 'the declined turn to settle');
    expect(invoked).toEqual([]);
    expect(item!.proposal.status).toBe('rejected');
  });
});
