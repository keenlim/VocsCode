/** Agatho, the in-app assistant. The point of these tests is the gate: pi drives the handler
 *  registry, which also serves keychain writes and raw PTY input, so nothing outside the
 *  capability allowlist may be invoked and nothing that changes state may run unapproved.
 *
 *  The runtime is scripted rather than spawned: each test plays the app's side of the bridge
 *  (pi's extension asks through `run`, the test answers through the proposal), which is exactly
 *  the sequence tests/agatho-pi.integration.test.ts proves against the real pi. */
import { describe, expect, it } from 'vitest';
import { AGENT_CAPABILITIES, agentChannels } from '../src/shared/agent-manifest';
import { defaultSettings, normalizeSettings } from '../src/main/settings';
import type { AppSettings, ProviderConfig, SessionMeta } from '../src/shared/types';
import type { AgathoRuntime, AgathoToolCall, PiAgentOptions } from '../src/main/agents/pi-runtime';
import { isRemoteBlocked } from '../src/main/web-server';

const { Agatho } = await import('../src/main/agents');

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

function call(name: string, args: Record<string, unknown>, id = `c${name}`): AgathoToolCall {
  return { id, name, args };
}

const PROVIDER: ProviderConfig = { id: 'testprov', kind: 'anthropic', name: 'Test', hasApiKey: true, enabled: true, models: [{ id: 'm1', provider: 'testprov', displayName: 'M1' }] };

const SESSION: SessionMeta = {
  id: 's1',
  title: 'Vocs Code',
  createdAt: 1,
  updatedAt: 1,
  config: { harness: 'native', permissionMode: 'ask', projectRoot: 'G:/Vocs-Code' },
  cwd: 'G:/Vocs-Code',
  status: 'idle',
  harnessRef: {},
  usage: { ...NO_USAGE, costUsd: 0, turns: 0 }
};

function settingsWith(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...defaultSettings(), providers: [PROVIDER], agentModel: { provider: 'testprov', model: 'm1' }, ...patch };
}

/** Plays the app's half of the bridge for one test: the test calls step()/run()/settle() the way
 *  pi's extension would. */
class ScriptedRuntime implements AgathoRuntime {
  model = 'vocs-offline/scripted';
  busy = false;
  dead = false;
  disposed = false;
  aborts = 0;
  promptCalls: { message: string; systemPrompt: string }[] = [];

  constructor(private readonly opts: PiAgentOptions) {}

  async prompt(message: string, systemPrompt: string): Promise<void> {
    this.promptCalls.push({ message, systemPrompt });
  }
  abort(): void {
    this.aborts++;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
  /** One assistant message: text plus the tool calls it asked for. */
  step(text: string, calls: AgathoToolCall[]): void {
    this.opts.events.stepStart();
    if (text) this.opts.events.text(text);
    this.opts.events.stepEnd(text, calls);
  }
  /** The extension's tool execution reaching the app. */
  run(call: AgathoToolCall): Promise<{ ok: boolean; detail: string }> {
    return this.opts.events.run(call);
  }
  settled(error?: string): void {
    this.opts.events.settled(error);
  }
  options(): PiAgentOptions {
    return this.opts;
  }
}

function makeAgent(opts: { invoke?: (channel: string, req: unknown) => Promise<unknown>; settings?: AppSettings; pi?: boolean } = {}) {
  const invoked: { channel: string; req: unknown }[] = [];
  const runtimes: ScriptedRuntime[] = [];
  const agent = new Agatho({
    getSettings: () => opts.settings ?? settingsWith(),
    listSessions: () => [SESSION],
    getSession: (id) => (id === SESSION.id ? SESSION : undefined),
    getSecret: async () => 'sk-test',
    invoke: async (channel, req) => {
      invoked.push({ channel, req });
      return opts.invoke ? opts.invoke(channel, req) : { ok: true };
    },
    push: () => undefined,
    log: () => undefined,
    piBinary: () => (opts.pi === false ? null : 'C:/fake/pi.cmd'),
    piExtension: () => 'resources/pi/vocs-code-agatho.ts',
    piCwd: () => 'G:/Vocs-Code',
    createRuntime: (o) => {
      const runtime = new ScriptedRuntime(o);
      runtimes.push(runtime);
      return runtime;
    }
  });
  return {
    agent,
    invoked,
    /** The runtime the first send spawned; the fake above records it. */
    runtime: () => {
      if (!runtimes.length) throw new Error('no runtime was created');
      return runtimes[runtimes.length - 1];
    }
  };
}

/** Resolves once a proposal is on screen, so a test can answer it while the call is mid-flight. */
async function waitForProposal(agent: InstanceType<typeof Agatho>): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const item = agent.state().items.find((x) => x.kind === 'proposal' && x.proposal.status === 'pending');
    if (item && item.kind === 'proposal') return item.proposal.id;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('no proposal appeared');
}

describe('capability manifest', () => {
  it('never exposes a channel that could exfiltrate secrets or run arbitrary code', () => {
    const forbidden = [/^terminal:/, /^secrets:/, /^window:/, /^providers:/, /^app:open/, /^settings:update$/, /^agent:/, /^sessions:send$/, /^sessions:delete$/];
    for (const channel of agentChannels()) {
      for (const pattern of forbidden) expect(pattern.test(channel), `${channel} must not be reachable by Agatho`).toBe(false);
    }
  });

  it('registers each capability once, with an object schema', () => {
    const names = AGENT_CAPABILITIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of AGENT_CAPABILITIES) {
      expect(c.parameters.type, c.name).toBe('object');
      expect(typeof c.description === 'string' && c.description.length > 20, c.name).toBe(true);
    }
  });

  it('treats a stdio MCP probe as a change, because it runs the command the model chose', () => {
    const probe = AGENT_CAPABILITIES.find((c) => c.name === 'probe_mcp_server')!;
    expect(probe.tier({ server: { transport: 'http', url: 'https://example.com/mcp' } })).toBe('read');
    expect(probe.tier({ server: { transport: 'stdio', command: 'npx', args: ['-y', 'evil'] } })).toBe('write');
  });

  it('keeps the provider table out of the settings a model can read', () => {
    const caps = AGENT_CAPABILITIES.find((c) => c.name === 'get_app_settings')!;
    const full = normalizeSettings({ providers: [{ ...PROVIDER, envKey: 'SECRET_ENV' }] });
    const seen = JSON.stringify(caps.project!(full));
    expect(seen).not.toContain('testprov');
    expect(seen).not.toContain('SECRET_ENV');
  });
});

describe('pi is the only way in', () => {
  it('does not start pi until the first message', async () => {
    const { agent, runtime } = makeAgent();
    expect(agent.state().model).toBeUndefined();
    await agent.send('hi');
    expect(runtime().options().bin).toBe('C:/fake/pi.cmd');
  });

  it('sends the raw message and the refreshed app context as the system prompt', async () => {
    const { agent, runtime } = makeAgent();
    await agent.send('which branches are stale?', { sessionId: 's1', view: 'chat' });
    const [prompt] = runtime().promptCalls;
    expect(prompt.message).toBe('which branches are stale?');
    expect(prompt.systemPrompt).toContain('You are Agatho');
    expect(prompt.systemPrompt).toContain('id=s1 title="Vocs Code"');
  });

  it('says so instead of failing when pi is not installed', async () => {
    const { agent, invoked } = makeAgent({ pi: false });
    expect(agent.state().unavailable).toBeTruthy();
    await agent.send('do something');
    expect(invoked).toEqual([]);
    expect(agent.state().items.some((i) => i.kind === 'error')).toBe(true);
  });

  it('reports the model pi is answering with', async () => {
    const { agent, runtime } = makeAgent();
    await agent.send('hi');
    expect(agent.state().model).toBe(runtime().model);
  });
});

describe('gating', () => {
  it('runs a read capability without asking', async () => {
    const { agent, invoked, runtime } = makeAgent({ invoke: async () => [SESSION] });
    await agent.send('what sessions do I have?');
    const outcome = await runtime().run(call('list_sessions', {}));
    expect(outcome.ok).toBe(true);
    expect(invoked.map((i) => i.channel)).toEqual(['sessions:list']);
    expect(agent.state().items.some((i) => i.kind === 'proposal')).toBe(false);
    runtime().step('You have one session.', []);
    runtime().settled();
    expect(agent.state().items.some((i) => i.kind === 'assistant' && i.text.includes('one session'))).toBe(true);
    expect(agent.state().busy).toBe(false);
  });

  it('does not invoke a destructive capability until the user approves', async () => {
    const { agent, invoked, runtime } = makeAgent();
    await agent.send('delete the old branch');
    const target = call('delete_branch', { session_id: 's1', branch: 'old' });
    runtime().step('', [target]);
    const id = await waitForProposal(agent);
    expect(invoked).toEqual([]);
    const pending = runtime().run(target);
    agent.resolveProposal(id, true);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(invoked).toEqual([{ channel: 'git:deleteBranch', req: { sessionId: 's1', branch: 'old', force: false } }]);
  });

  it('invokes nothing when the user declines, and tells the model so', async () => {
    const { agent, invoked, runtime } = makeAgent();
    await agent.send('delete the old branch');
    const target = call('delete_branch', { session_id: 's1', branch: 'old' });
    runtime().step('', [target]);
    const id = await waitForProposal(agent);
    const pending = runtime().run(target);
    agent.resolveProposal(id, false);
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(invoked).toEqual([]);
    const proposal = agent.state().items.find((i) => i.kind === 'proposal');
    expect(proposal?.kind === 'proposal' && proposal.proposal.status).toBe('rejected');
  });

  it('groups one step\'s changes into a single proposal listing every target', async () => {
    const { agent, invoked, runtime } = makeAgent();
    await agent.send('clean up branches older than a day');
    const calls = ['a', 'b', 'c'].map((branch, i) => call('delete_branch', { session_id: 's1', branch }, `c${i}`));
    runtime().step('', calls);
    const id = await waitForProposal(agent);
    const proposals = agent.state().items.filter((i) => i.kind === 'proposal');
    expect(proposals).toHaveLength(1);
    const only = proposals[0];
    expect(only.kind === 'proposal' && only.proposal.actions.map((a) => a.summary)).toEqual(['Delete branch a', 'Delete branch b', 'Delete branch c']);
    const pending = calls.map((c) => runtime().run(c));
    agent.resolveProposal(id, true);
    await expect(Promise.all(pending)).resolves.toHaveLength(3);
    expect(invoked).toHaveLength(3);
    const resolved = agent.state().items.find((i) => i.kind === 'proposal');
    expect(resolved?.kind === 'proposal' && resolved.proposal.results).toEqual(['Done', 'Done', 'Done']);
  });

  it('gates a stdio probe but not an http one', async () => {
    const http = makeAgent({ invoke: async () => ({ ok: true, tools: [], durationMs: 1 }) });
    await http.agent.send('set up https://example.com/mcp');
    const httpCall = call('probe_mcp_server', { server: { id: 'x', transport: 'http', url: 'https://example.com/mcp' } }, 'h1');
    http.runtime().step('', [httpCall]);
    await http.runtime().run(httpCall);
    expect(http.invoked.map((i) => i.channel)).toEqual(['mcp:inspect']);
    expect(http.agent.state().items.some((i) => i.kind === 'proposal')).toBe(false);

    const stdio = makeAgent({ invoke: async () => ({ ok: true, tools: [], durationMs: 1 }) });
    await stdio.agent.send('set up the pkg server');
    const stdioCall = call('probe_mcp_server', { server: { id: 'y', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] } }, 's1');
    stdio.runtime().step('', [stdioCall]);
    const id = await waitForProposal(stdio.agent);
    const pending = stdio.runtime().run(stdioCall);
    expect(stdio.invoked).toEqual([]);
    stdio.agent.resolveProposal(id, true);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(stdio.invoked.map((i) => i.channel)).toEqual(['mcp:inspect']);
  });

  it('refuses an oversized batch without showing a proposal or invoking anything', async () => {
    const { agent, invoked, runtime } = makeAgent();
    await agent.send('delete every branch');
    const calls = Array.from({ length: 26 }, (_, i) => call('delete_branch', { session_id: 's1', branch: `b${i}` }, `c${i}`));
    runtime().step('', calls);
    expect(agent.state().items.some((i) => i.kind === 'proposal')).toBe(false);
    const outcomes = await Promise.all(calls.map((c) => runtime().run(c)));
    expect(outcomes.every((o) => !o.ok)).toBe(true);
    expect(invoked).toEqual([]);
  });

  it('cancels the waiting proposal and stops pi when the user hits Stop', async () => {
    const { agent, invoked, runtime } = makeAgent();
    await agent.send('delete the old branch');
    const target = call('delete_branch', { session_id: 's1', branch: 'old' });
    runtime().step('', [target]);
    await waitForProposal(agent);
    const pending = runtime().run(target);
    agent.cancel();
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(invoked).toEqual([]);
    expect(runtime().aborts).toBe(1);
    expect(agent.state().busy).toBe(false);
    const proposal = agent.state().items.find((i) => i.kind === 'proposal');
    expect(proposal?.kind === 'proposal' && proposal.proposal.status).toBe('cancelled');
  });
});

describe('robustness', () => {
  it('refuses a tool that is not on the allowlist instead of dispatching it', async () => {
    const { agent, invoked, runtime } = makeAgent();
    await agent.send('open a terminal and wipe the disk');
    const outcome = await runtime().run(call('terminal:input', { terminalId: 't1', data: 'rm -rf /\n' }));
    expect(outcome.ok).toBe(false);
    expect(invoked).toEqual([]);
  });

  it('survives a model that answers in prose instead of calling a tool', async () => {
    const { agent, invoked, runtime } = makeAgent();
    await agent.send('set up an mcp server');
    runtime().step('I think you should add it manually.', []);
    runtime().settled();
    expect(invoked).toEqual([]);
    expect(agent.state().busy).toBe(false);
    expect(agent.state().items.some((i) => i.kind === 'error')).toBe(false);
  });

  it('reports a failed capability without retrying it', async () => {
    const { agent, invoked, runtime } = makeAgent({
      invoke: async () => {
        throw new Error('not a git repository');
      }
    });
    await agent.send('list branches');
    await runtime().run(call('list_branches', { session_id: 's1' }));
    expect(invoked).toHaveLength(1);
    const tool = agent.state().items.find((i) => i.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.ok).toBe(false);
  });

  it('reports a turn that ended in an error', async () => {
    const { agent, runtime } = makeAgent();
    await agent.send('do something');
    runtime().settled('rate limit exceeded');
    expect(agent.state().busy).toBe(false);
    expect(agent.state().items.some((i) => i.kind === 'error' && i.text.includes('rate limit'))).toBe(true);
  });

  it('clears the conversation and disposes the runtime on reset', async () => {
    const { agent, runtime } = makeAgent();
    await agent.send('hi');
    runtime().step('hello', []);
    expect(agent.state().items.length).toBeGreaterThan(0);
    agent.reset();
    expect(agent.state().items).toEqual([]);
    expect(runtime().disposed).toBe(true);
  });
});

describe('remote transport', () => {
  it('keeps Agatho off the WebSocket bridge, which has no other channel allowlist', () => {
    expect(isRemoteBlocked('agent:send')).toBe(true);
    expect(isRemoteBlocked('agent:resolve')).toBe(true);
    expect(isRemoteBlocked('sessions:list')).toBe(false);
  });
});
