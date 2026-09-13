/**
 * Codex's own `model/list` reports OpenAI models only. Its `model_providers` seam also accepts any
 * configured OpenAI-wire endpoint (OpenRouter, DeepSeek, Groq, …), so those models are merged into
 * the picker here; the adapter registers the matching provider once one is selected.
 */
import type { AppSettings, ModelInfo } from '../../shared/types';
import { isCodexBuiltinProvider, isOpenAiWireProvider } from '../../shared/providers';
import { STATIC_MODELS_BY_PROVIDER } from './static-models';

/** One configured provider's models, shaped for the Codex picker. Empty when Codex cannot reach it. */
export function codexProviderModels(settings: AppSettings, providerId: string): ModelInfo[] {
  const provider = settings.providers.find((p) => p.id === providerId);
  if (!provider || !provider.enabled || !provider.baseUrl || isCodexBuiltinProvider(provider.id) || !isOpenAiWireProvider(provider)) return [];
  const models = provider.models.length ? provider.models : STATIC_MODELS_BY_PROVIDER[provider.id] ?? [];
  return models.map((m) => ({ ...m, provider: provider.id }));
}

/** Every usable provider's models, appended to Codex's native catalog without duplicates. */
export function mergeCodexCatalog(native: ModelInfo[], settings: AppSettings): ModelInfo[] {
  const seen = new Set(native.map((m) => `${m.provider}/${m.id}`));
  const extra: ModelInfo[] = [];
  for (const provider of settings.providers) {
    for (const model of codexProviderModels(settings, provider.id)) {
      const key = `${model.provider}/${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      extra.push(model);
    }
  }
  return [...native, ...extra];
}
