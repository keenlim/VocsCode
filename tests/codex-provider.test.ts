/**
 * Codex can run models from the app's own OpenAI-wire providers (OpenRouter, DeepSeek, Groq, …)
 * through its `model_providers` seam. These offline tests pin the two production boundaries:
 * the New Session catalog offers those models, and starting a session registers the selected
 * provider with the Responses wire API (Codex 0.153 rejects `chat`) and injects its key — while an
 * OpenAI session never sees another provider's key.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import { listHarnessModels } from '../src/main/harness/registry';
import { defaultSettings } from '../src/main/settings';
import type { HarnessContext } from '../src/main/harness/types';
import type { AppSettings, HarnessRef, ModelRef, ProviderConfig, SessionEvent, SessionMeta } from '../src/shared/types';
import { emptyUsage } from '../src/main/models/static-models';

type AnyRecord = Record<string, any>;

const mocks = vi.hoisted(() => ({
  spawnChildren: [] as AnyRecord[],
  spawnCalls: [] as { file: string; args: string[]; opts: AnyRecord }[]
}));

vi.mock('../src/main/harness/spawn', () => ({
  spawnTool: (file: string, args: string[], opts: AnyRecord) => {
    mocks.spawnCalls.push({ file, args, opts });
    const child = mocks.spawnChildren.shift();
    if (!child) throw new Error('no scripted child process');
    return child;
  },
  shutdownChild: async () => undefined,
  killTree: async () => undefined,
  quoteWin: (arg: string) => arg
}));

function makeFakeChild(): AnyRecord {
  const child = new EventEmitter() as AnyRecord;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 4242;
  child.kill = vi.fn();
  return child;
}

/** JSON-RPC peer for the codex app-server (no `jsonrpc` field, matching that transport). */
class FakeJsonRpcServer {
  readonly requests: AnyRecord[] = [];
  private buf = '';
  private readonly handlers = new Map<string, (params: AnyRecord, id: AnyRecord) => unknown>();

  constructor(private readonly child: AnyRecord) {
    child.stdin.on('data', (d: Buffer) => this.onData(d.toString('utf8')));
  }

  on(method: string, handler: (params: AnyRecord, id: AnyRecord) => unknown): this {
    this.handlers.set(method, handler);
    return this;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx = this.buf.indexOf('\n');
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) this.dispatch(JSON.parse(line) as AnyRecord);
      idx = this.buf.indexOf('\n');
    }
  }

  private dispatch(msg: AnyRecord): void {
    if (msg.method === undefined) return;
    this.requests.push(msg);
    if (msg.id === undefined || msg.id === null) return;
    Promise.resolve()
      .then(() => this.handlers.get(msg.method)?.(msg.params as AnyRecord, msg.id) ?? {})
      .then(
        (result) => this.write({ id: msg.id, result: result ?? {} }),
        (e: unknown) => this.write({ id: msg.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } })
      );
  }

  private write(msg: AnyRecord): void {
    this.child.stdout.write(JSON.stringify(msg) + '\n');
  }
}

const OPENROUTER_MODELS = [
  { id: 'z-ai/glm-4.6', provider: 'openrouter', displayName: 'GLM 4.6', supportsImages: false },
  { id: 'moonshotai/kimi-k2', provider: 'openrouter', displayName: 'Kimi K2', supportsImages: false }
];

function openRouterProvider(): ProviderConfig {
  return {
    id: 'openrouter',
    kind: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    hasApiKey: true,
    envKey: 'OPENROUTER_API_KEY',
    models: OPENROUTER_MODELS,
    builtin: true,
    enabled: true
  };
}

function settingsWithOpenRouter(): AppSettings {
  const base = defaultSettings();
  return { ...base, providers: [...base.providers.filter((p) => p.id !== 'openrouter'), openRouterProvider()] };
}

function makeCtx(meta: SessionMeta, settings: AppSettings): { ctx: HarnessContext; events: SessionEvent[]; keys: string[] } {
  const events: SessionEvent[] = [];
  const keys: string[] = [];
  const ctx = {
    sessionId: meta.id,
    session: () => meta,
    settings: () => settings,
    runtime: { resolve: () => ({ name: 'codex', path: 'C:/fake/codex.exe' }) },
    sessionDir: process.cwd(),
    permissionMode: () => meta.config.permissionMode,
    effort: () => undefined,
    getApiKey: async (id: string) => {
      keys.push(id);
      return id === 'openrouter' ? 'sk-openrouter-test' : undefined;
    },
    emit: (event: SessionEvent) => events.push(event),
    requestApproval: async () => ({ optionId: 'deny' }),
    updateRef: (patch: Partial<HarnessRef>) => Object.assign(meta.harnessRef, patch),
    updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
    log: vi.fn(),
    readJson: async () => null,
    writeJson: async () => undefined,
    mcpServers: async () => []
  } as unknown as HarnessContext;
  return { ctx, events, keys };
}

function makeMeta(model?: ModelRef): SessionMeta {
  return {
    id: 's_codex',
    title: 'Codex provider',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'codex', projectRoot: '/proj', permissionMode: 'ask', model },
    cwd: '/proj',
    status: 'idle',
    harnessRef: {},
    usage: emptyUsage()
  };
}

function scriptServer(child: AnyRecord): FakeJsonRpcServer {
  return new FakeJsonRpcServer(child)
    .on('initialize', () => ({}))
    .on('thread/start', () => ({ thread: { id: 'thread-1' }, model: 'z-ai/glm-4.6', modelProvider: 'openrouter', reasoningEffort: null }))
    .on('model/list', () => ({ data: [] }))
    .on('thread/unsubscribe', () => ({}));
}

beforeEach(() => {
  mocks.spawnChildren.length = 0;
  mocks.spawnCalls.length = 0;
  // The adapter inherits process.env; clear the provider key so only its own injection can supply one.
  delete process.env.OPENROUTER_API_KEY;
});

describe('codex provider catalog', () => {
  it('offers configured OpenAI-wire provider models for the codex harness', async () => {
    const { models } = await listHarnessModels({
      harness: 'codex',
      settings: settingsWithOpenRouter(),
      runtime: { resolve: () => null } as never,
      getApiKey: async () => undefined
    });
    expect(models.some((m) => m.provider === 'openrouter' && m.id === 'z-ai/glm-4.6')).toBe(true);
  });

  it('leaves codex-exec on the OpenAI catalog, since it cannot register a provider', async () => {
    const { models } = await listHarnessModels({
      harness: 'codex-exec',
      settings: settingsWithOpenRouter(),
      runtime: { resolve: () => null } as never,
      getApiKey: async () => undefined
    });
    expect(models.some((m) => m.provider === 'openrouter')).toBe(false);
  });

  it('does not offer providers Codex cannot speak to', async () => {
    const base = defaultSettings();
    const settings: AppSettings = { ...base, providers: [...base.providers.filter((p) => p.id !== 'openrouter'), openRouterProvider()] };
    const { models } = await listHarnessModels({ harness: 'codex', settings, runtime: { resolve: () => null } as never, getApiKey: async () => undefined });
    expect(models.some((m) => m.provider === 'anthropic')).toBe(false);
  });
});

describe('codex custom provider wiring', () => {
  it('registers the selected model’s provider with the Responses wire API and injects its key', async () => {
    const meta = makeMeta({ provider: 'openrouter', model: 'z-ai/glm-4.6' });
    const { ctx, keys } = makeCtx(meta, settingsWithOpenRouter());
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    const server = scriptServer(child);

    const adapter = new CodexAppServerAdapter(ctx);
    await adapter.start();

    const thread = server.requests.find((r) => r.method === 'thread/start');
    expect(thread?.params.model).toBe('z-ai/glm-4.6');
    expect(thread?.params.modelProvider).toBe('openrouter');
    expect(thread?.params.config?.model_providers?.openrouter).toEqual({
      name: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      env_key: 'OPENROUTER_API_KEY',
      wire_api: 'responses'
    });
    expect(mocks.spawnCalls[0].opts.env.OPENROUTER_API_KEY).toBe('sk-openrouter-test');
    expect(keys).toContain('openrouter');
    await adapter.dispose();
  });

  it('scopes the session catalog to the pinned provider so unusable switches are not offered', async () => {
    const meta = makeMeta({ provider: 'openrouter', model: 'z-ai/glm-4.6' });
    const { ctx } = makeCtx(meta, settingsWithOpenRouter());
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    scriptServer(child);

    const adapter = new CodexAppServerAdapter(ctx);
    await adapter.start();
    const models = await adapter.listModels!();

    expect(models.map((m) => m.id)).toEqual(['z-ai/glm-4.6', 'moonshotai/kimi-k2']);
    expect(models.every((m) => m.provider === 'openrouter')).toBe(true);
    await adapter.dispose();
  });

  it('keeps an OpenAI session free of other providers’ keys and entries', async () => {
    const meta = makeMeta({ provider: 'openai', model: 'gpt-5.6-sol' });
    const { ctx, keys } = makeCtx(meta, settingsWithOpenRouter());
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    const server = scriptServer(child);

    const adapter = new CodexAppServerAdapter(ctx);
    await adapter.start();

    const thread = server.requests.find((r) => r.method === 'thread/start');
    expect(thread?.params.modelProvider).toBeFalsy();
    expect(thread?.params.config?.model_providers).toBeUndefined();
    expect(mocks.spawnCalls[0].opts.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(keys).not.toContain('openrouter');
    await adapter.dispose();
  });
});
