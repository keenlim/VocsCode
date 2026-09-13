/** Provider-kind helpers shared by main and renderer. No runtime deps, no Electron imports. */
import type { ProviderConfig, ProviderKind } from './types';

/**
 * Provider kinds that speak the OpenAI wire protocol. Codex can target these through a
 * `model_providers` entry; Anthropic and Cursor speak their own protocols and cannot.
 */
const OPENAI_WIRE_KINDS: readonly ProviderKind[] = [
  'openai',
  'openai-compatible',
  'deepseek',
  'openrouter',
  'ollama',
  'lmstudio',
  'groq',
  'xai',
  'mistral',
  'gemini-openai'
];

export function isOpenAiWireProvider(provider: Pick<ProviderConfig, 'kind'>): boolean {
  return OPENAI_WIRE_KINDS.includes(provider.kind);
}

/** Codex ships an `openai` provider; every other id has to be registered as a `model_providers` entry. */
export function isCodexBuiltinProvider(id: string | undefined): boolean {
  return !id || id === 'openai' || id === 'codex';
}
