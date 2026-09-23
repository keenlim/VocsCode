/** The Claude picker must list models from every enabled Anthropic-compatible provider, not only the
 *  built-in Anthropic one; that is what makes a gateway's models selectable for Claude Code. */
import type { AppSettings, ProviderConfig } from '../src/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { listHarnessModels } from '../src/main/harness/registry';
import { ANTHROPIC_STATIC_MODELS } from '../src/main/models/static-models';

const provider = (over: Partial<ProviderConfig>): ProviderConfig => ({
  id: 'x',
  kind: 'anthropic',
  name: 'x',
  hasApiKey: false,
  models: [],
  enabled: true,
  ...over
});

function settings(providers: ProviderConfig[]): AppSettings {
  return { claude: { runtime: 'auto', useProviderKey: false, settingSources: [] }, providers } as unknown as AppSettings;
}

const missingRuntime = { resolve: () => null } as never;
const list = (providers: ProviderConfig[], runtime = missingRuntime) =>
  listHarnessModels({ harness: 'claude', settings: settings(providers), runtime, getApiKey: async () => undefined });

describe('Claude model catalog', () => {
  beforeEach(() => queryMock.mockReset());
  it('lists the built-in Anthropic catalog when nothing else is configured', async () => {
    const r = await list([provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' })]);
    expect(r.models.map((m) => m.id)).toEqual(ANTHROPIC_STATIC_MODELS.map((m) => m.id));
    expect(r.models.every((m) => m.provider === 'anthropic')).toBe(true);
  });

  it('asks the installed Claude runtime for the login-backed catalog before a session exists', async () => {
    const close = vi.fn();
    const supportedModels = vi.fn().mockResolvedValue([
      {
        value: 'default',
        resolvedModel: 'claude-opus-5-5[1m]',
        displayName: 'Default (recommended)',
        description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
      },
      {
        value: 'opus[1m]',
        resolvedModel: 'claude-opus-5-5[1m]',
        displayName: 'Opus (1M context)',
        description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high', 'max']
      },
      {
        value: 'haiku',
        resolvedModel: 'claude-haiku-4-5-20251001',
        displayName: 'Haiku',
        description: 'Haiku 4.5 · Fastest for quick answers',
        supportsEffort: false
      }
    ]);
    queryMock.mockReturnValue({ supportedModels, close });
    const runtime = { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never;

    const r = await list(
      [
        provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' }),
        provider({ id: 'zai', name: 'Z.AI', models: [{ id: 'glm-4.6', provider: 'zai', displayName: 'GLM-4.6' }] })
      ],
      runtime
    );

    expect(r.error).toBeUndefined();
    expect(r.models).toEqual([
      expect.objectContaining({ id: 'default', displayName: 'Default (recommended) — Opus 5.5 with 1M context', isDefault: true }),
      expect.objectContaining({ id: 'claude-opus-5-5[1m]', displayName: 'Opus 5.5 with 1M context', supportedEfforts: ['low', 'high', 'max'] }),
      expect.objectContaining({ id: 'claude-haiku-4-5-20251001', supportsReasoning: false, supportedEfforts: undefined }),
      expect.objectContaining({ id: 'glm-4.6', provider: 'zai' })
    ]);
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.objectContaining({ [Symbol.asyncIterator]: expect.any(Function) }),
        options: expect.objectContaining({
          cwd: process.cwd(),
          pathToClaudeCodeExecutable: '/bin/claude',
          permissionMode: 'plan',
          settingSources: [],
          persistSession: false
        })
      })
    );
    expect(supportedModels).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('falls back to the saved catalog when live Claude discovery fails', async () => {
    const close = vi.fn();
    queryMock.mockReturnValue({ supportedModels: vi.fn().mockRejectedValue(new Error('login expired')), close });
    const runtime = { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never;

    const r = await list([provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' })], runtime);

    expect(r.models.map((m) => m.id)).toEqual(ANTHROPIC_STATIC_MODELS.map((m) => m.id));
    expect(r.error).toContain('login expired');
    expect(close).toHaveBeenCalledOnce();
  });

  it('times out and closes a Claude model probe that never initializes', async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn();
      queryMock.mockReturnValue({ supportedModels: vi.fn(() => new Promise(() => undefined)), close });
      const runtime = { resolve: () => ({ path: '/bin/claude', source: 'system' }) } as never;

      const pending = list([provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' })], runtime);
      await vi.advanceTimersByTimeAsync(20_000);
      const r = await pending;

      expect(r.models.map((m) => m.id)).toEqual(ANTHROPIC_STATIC_MODELS.map((m) => m.id));
      expect(r.error).toContain('timed out after 20000ms');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists an added Anthropic-compatible provider\u2019s models under its own provider id', async () => {
    const r = await list([
      provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' }),
      provider({
        id: 'zai',
        name: 'Z.AI (GLM)',
        baseUrl: 'https://api.z.ai/api/anthropic',
        models: [
          { id: 'glm-4.6', provider: 'zai', displayName: 'GLM-4.6' },
          { id: 'glm-4.5', provider: 'zai', displayName: 'GLM-4.5' }
        ]
      })
    ]);
    expect(r.models.find((m) => m.id === 'glm-4.6')).toMatchObject({ provider: 'zai', displayName: 'GLM-4.6' });
    expect(r.models.some((m) => m.id === 'claude-sonnet-5' && m.provider === 'anthropic')).toBe(true);
  });

  it('lists a vendor\u2019s own Anthropic-format catalog (OpenRouter, DeepSeek)', async () => {
    const r = await list([
      provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' }),
      provider({
        id: 'openrouter',
        kind: 'openrouter',
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: [{ id: 'z-ai/glm-4.6', provider: 'openrouter', displayName: 'GLM 4.6' }]
      }),
      provider({
        id: 'deepseek',
        kind: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        models: [{ id: 'deepseek-v4-pro', provider: 'deepseek', displayName: 'DeepSeek V4 Pro' }]
      })
    ]);
    expect(r.models.find((m) => m.id === 'z-ai/glm-4.6')?.provider).toBe('openrouter');
    expect(r.models.find((m) => m.id === 'deepseek-v4-pro')?.provider).toBe('deepseek');
  });

  it('ignores disabled providers and providers that cannot host Claude Code', async () => {
    const r = await list([
      provider({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com' }),
      provider({ id: 'zai', name: 'Z.AI', enabled: false, models: [{ id: 'glm-4.6', provider: 'zai', displayName: 'GLM-4.6' }] }),
      provider({ id: 'openai', kind: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', provider: 'openai', displayName: 'GPT-5' }] })
    ]);
    expect(r.models.some((m) => m.id === 'glm-4.6')).toBe(false);
    expect(r.models.some((m) => m.id === 'gpt-5')).toBe(false);
  });
});
