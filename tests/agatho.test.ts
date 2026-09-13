/** Agatho, the in-app assistant. The point of these tests is the gate: the model drives the
 *  handler registry, which also serves keychain writes and raw PTY input, so nothing outside
 *  the capability allowlist may be invoked and nothing that changes state may run unapproved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepResult } from '../src/main/harness/native/drivers';
import { AGENT_CAPABILITIES, agentChannels } from '../src/shared/agent-manifest';
import { defaultSettings, normalizeSettings } from '../src/main/settings';
import type { AppSettings, ProviderConfig, SessionMeta } from '../src/shared/types';
import { isRemoteBlocked } from '../src/main/web-server';

/* The provider drivers are the only part of the loop that talks to the network; scripting them
   makes the whole turn deterministic. */
const scripted: StepResult[] = [];
vi.mock('../src/main/harness/native/drivers', () => ({
  isAnthropicProvider: () => true,
  anthropicStep: vi.fn(async () => {
    const next = scripted.shift();
    if (!next) throw new Error('no scripted step left');
    return next;
  }),
  openaiStep: vi.fn(async () => {
    throw new Error('openaiStep should not be used here');
  })
}));

const { Agatho } = await import('../src/main/agents');

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

function step(partial: Partial<StepResult>): StepResult {
  return { text: '', reasoning: '', toolCalls: [], usage: { ...NO_USAGE }, stopReason: 'end_turn', ...partial };
}

function call(name: string, args: Record<string, unknown>, id = `c${name}`) {
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

function makeAgent(opts: { invoke?: (channel: string, req: unknown) => Promise<unknown>; settings?: AppSettings } = {}) {
  const invoked: { channel: string; req: unknown }[] = [];
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
    log: () => undefined
  });
  return { agent, invoked };
}

/** Resolves once a proposal is on screen, so a test can answer it while the turn is mid-flight. */
async function waitForProposal(agent: InstanceType<typeof Agatho>): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const item = agent.state().items.find((x) => x.kind === 'proposal' && x.proposal.status === 'pending');
    if (item && item.kind === 'proposal') return item.proposal.id;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('no proposal appeared');
}

beforeEach(() => {
  scripted.length = 0;
});

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

describe('gating', () => {
  it('runs a read capability without asking', async () => {
    scripted.push(step({ toolCalls: [call('list_sessions', {})] }), step({ text: 'You have one session.' }));
    const { agent, invoked } = makeAgent({ invoke: async () => [SESSION] });
    await agent.send('what sessions do I have?');
    expect(invoked.map((i) => i.channel)).toEqual(['sessions:list']);
    expect(agent.state().items.some((i) => i.kind === 'assistant' && i.text.includes('one session'))).toBe(true);
  });

  it('does not invoke a destructive capability until the user approves', async () => {
    scripted.push(step({ toolCalls: [call('delete_branch', { session_id: 's1', branch: 'old' })] }), step({ text: 'Deleted.' }));
    const { agent, invoked } = makeAgent();
    const turn = agent.send('delete the old branch');
    const id = await waitForProposal(agent);
    expect(invoked).toEqual([]);
    agent.resolveProposal(id, true);
    await turn;
    expect(invoked).toEqual([{ channel: 'git:deleteBranch', req: { sessionId: 's1', branch: 'old', force: false } }]);
  });

  it('invokes nothing when the user declines, and tells the model so', async () => {
    scripted.push(step({ toolCalls: [call('delete_branch', { session_id: 's1', branch: 'old' })] }), step({ text: 'Left it alone.' }));
    const { agent, invoked } = makeAgent();
    const turn = agent.send('delete the old branch');
    const id = await waitForProposal(agent);
    agent.resolveProposal(id, false);
    await turn;
    expect(invoked).toEqual([]);
    const proposal = agent.state().items.find((i) => i.kind === 'proposal');
    expect(proposal?.kind === 'proposal' && proposal.proposal.status).toBe('rejected');
  });

  it('groups one step\'s changes into a single proposal listing every target', async () => {
    scripted.push(
      step({
        toolCalls: [
          call('delete_branch', { session_id: 's1', branch: 'a' }, 'c1'),
          call('delete_branch', { session_id: 's1', branch: 'b' }, 'c2'),
          call('delete_branch', { session_id: 's1', branch: 'c' }, 'c3')
        ]
      }),
      step({ text: 'Removed three branches.' })
    );
    const { agent, invoked } = makeAgent();
    const turn = agent.send('clean up branches older than a day');
    const id = await waitForProposal(agent);
    const proposals = agent.state().items.filter((i) => i.kind === 'proposal');
    expect(proposals).toHaveLength(1);
    const only = proposals[0];
    expect(only.kind === 'proposal' && only.proposal.actions.map((a) => a.summary)).toEqual(['Delete branch a', 'Delete branch b', 'Delete branch c']);
    agent.resolveProposal(id, true);
    await turn;
    expect(invoked).toHaveLength(3);
  });

  it('gates a stdio probe but not an http one', async () => {
    scripted.push(step({ toolCalls: [call('probe_mcp_server', { server: { id: 'x', transport: 'http', url: 'https://example.com/mcp' } })] }), step({ text: 'It works.' }));
    const http = makeAgent({ invoke: async () => ({ ok: true, tools: [], durationMs: 1 }) });
    await http.agent.send('set up https://example.com/mcp');
    expect(http.invoked.map((i) => i.channel)).toEqual(['mcp:inspect']);
    expect(http.agent.state().items.some((i) => i.kind === 'proposal')).toBe(false);

    scripted.push(step({ toolCalls: [call('probe_mcp_server', { server: { id: 'y', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] } })] }), step({ text: 'Done.' }));
    const stdio = makeAgent({ invoke: async () => ({ ok: true, tools: [], durationMs: 1 }) });
    const turn = stdio.agent.send('set up the pkg server');
    const id = await waitForProposal(stdio.agent);
    expect(stdio.invoked).toEqual([]);
    stdio.agent.resolveProposal(id, true);
    await turn;
    expect(stdio.invoked.map((i) => i.channel)).toEqual(['mcp:inspect']);
  });
});

describe('robustness', () => {
  it('refuses a tool that is not on the allowlist instead of dispatching it', async () => {
    scripted.push(step({ toolCalls: [call('terminal:input', { terminalId: 't1', data: 'rm -rf /\n' })] }), step({ text: 'I cannot do that.' }));
    const { agent, invoked } = makeAgent();
    await agent.send('open a terminal and wipe the disk');
    expect(invoked).toEqual([]);
  });

  it('survives a model that answers in prose instead of calling a tool', async () => {
    scripted.push(step({ text: 'I think you should add it manually.' }));
    const { agent, invoked } = makeAgent();
    await agent.send('set up an mcp server');
    expect(invoked).toEqual([]);
    expect(agent.state().busy).toBe(false);
    expect(agent.state().items.some((i) => i.kind === 'error')).toBe(false);
  });

  it('reports a failed capability without retrying it', async () => {
    scripted.push(step({ toolCalls: [call('list_branches', { session_id: 's1' })] }), step({ text: 'That repo is not a git checkout.' }));
    const { agent, invoked } = makeAgent({
      invoke: async () => {
        throw new Error('not a git repository');
      }
    });
    await agent.send('list branches');
    expect(invoked).toHaveLength(1);
    const tool = agent.state().items.find((i) => i.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.ok).toBe(false);
  });

  it('reports the model that answered, so a weak utility model is visible', async () => {
    scripted.push(step({ text: 'hello' }));
    const { agent } = makeAgent();
    await agent.send('hi');
    expect(agent.state().model).toBe('testprov/m1');
  });

  it('says so instead of failing when no provider is configured', async () => {
    const { agent, invoked } = makeAgent({ settings: settingsWith({ providers: [], agentModel: undefined }) });
    expect(agent.state().unavailable).toBeTruthy();
    await agent.send('do something');
    expect(invoked).toEqual([]);
  });

  it('clears the conversation on reset', async () => {
    scripted.push(step({ text: 'hello' }));
    const { agent } = makeAgent();
    await agent.send('hi');
    expect(agent.state().items.length).toBeGreaterThan(0);
    agent.reset();
    expect(agent.state().items).toEqual([]);
  });
});

describe('remote transport', () => {
  it('keeps Agatho off the WebSocket bridge, which has no other channel allowlist', () => {
    expect(isRemoteBlocked('agent:send')).toBe(true);
    expect(isRemoteBlocked('agent:resolve')).toBe(true);
    expect(isRemoteBlocked('sessions:list')).toBe(false);
  });
});
