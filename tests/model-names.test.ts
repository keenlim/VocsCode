/** The canonical model name: `provider/model`, and the aggregator form that keeps the vendor. */
import { describe, expect, it } from 'vitest';
import { modelName, modelRefName, parseTypedModel } from '../src/shared/model-names';

describe('model names', () => {
  it('qualifies a model with the provider it runs on', () => {
    expect(modelName('anthropic', 'claude-opus-5')).toBe('anthropic/claude-opus-5');
    expect(modelName('deepseek', 'deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash');
  });

  it('keeps an aggregator route whole, so the vendor stays visible', () => {
    expect(modelName('openrouter', 'deepseek/deepseek-flash')).toBe('openrouter/deepseek/deepseek-flash');
  });

  it('names a stored selection, and nothing when the harness picks', () => {
    expect(modelRefName({ provider: 'deepseek', model: 'deepseek-v4-flash' })).toBe('deepseek/deepseek-v4-flash');
    expect(modelRefName(undefined)).toBeUndefined();
  });
});

describe('a model name typed back in', () => {
  const providers = ['anthropic', 'openrouter', 'deepseek'];

  it('reads back the provider from a name the picker displayed', () => {
    expect(parseTypedModel('anthropic/claude-opus-5', providers, 'openai')).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
    expect(parseTypedModel('openrouter/deepseek/deepseek-flash', providers, 'anthropic')).toEqual({ provider: 'openrouter', model: 'deepseek/deepseek-flash' });
  });

  it('leaves an aggregator id slashed when its first segment is no provider at all', () => {
    expect(parseTypedModel('z-ai/glm-4.6', providers, 'openrouter')).toEqual({ provider: 'openrouter', model: 'z-ai/glm-4.6' });
  });

  it('keeps the fallback provider for a bare id', () => {
    expect(parseTypedModel('acme-custom-1', providers, 'anthropic')).toEqual({ provider: 'anthropic', model: 'acme-custom-1' });
  });
});
