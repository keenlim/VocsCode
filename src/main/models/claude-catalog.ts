/**
 * Claude Code speaks the Anthropic API. Anthropic's own endpoint supplies the native catalog; every
 * other Claude-capable provider (an anthropic-kind gateway such as GLM or LiteLLM, or a vendor that
 * publishes its own Anthropic route such as OpenRouter or DeepSeek) contributes its models, and the
 * adapter pins the session's endpoint to the provider the chosen model came from.
 */
import type { AppSettings, ModelInfo } from '../../shared/types';
import { isClaudeCapableProvider } from '../../shared/providers';
import { ANTHROPIC_STATIC_MODELS } from './static-models';

/** The built-in catalog: the Anthropic provider's cached list, or the static one when it has none. */
export function claudeNativeModels(settings: AppSettings): ModelInfo[] {
  const provider = settings.providers.find((p) => p.id === 'anthropic');
  const models = provider?.enabled !== false && provider?.models.length ? provider.models : ANTHROPIC_STATIC_MODELS;
  return models.map((m) => ({ ...m, provider: 'anthropic' }));
}

/** One other Claude-capable provider's models; empty when it is disabled or cannot host Claude Code. */
export function claudeProviderModels(settings: AppSettings, providerId: string): ModelInfo[] {
  const provider = settings.providers.find((p) => p.id === providerId);
  if (!provider || !provider.enabled || provider.id === 'anthropic' || !isClaudeCapableProvider(provider)) return [];
  return provider.models.map((m) => ({ ...m, provider: provider.id }));
}

/** Keep the first row for each selectable provider/id, preserving SDK order and metadata.
 *  Run after alias-to-explicit mapping: different SDK rows can resolve to the same selection.
 *  `default`, context variants and identical model ids on different providers remain distinct. */
export function dedupeClaudeModels(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = JSON.stringify([model.provider, model.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every usable provider's models, appended to the native catalog without duplicates. */
export function mergeClaudeCatalog(native: ModelInfo[], settings: AppSettings): ModelInfo[] {
  return dedupeClaudeModels([...native, ...settings.providers.flatMap((provider) => claudeProviderModels(settings, provider.id))]);
}
