import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ModelRef, ProviderConfig } from '../shared/types';
import { selectBackgroundModel } from './agents/model';
import { resolveProviderApiKey } from './models/providers';
import { isAnthropicProvider } from './harness/native/drivers';
import { errorMessage } from './util/async';

/** Placeholder title from the first prompt line: at most 6 words and 60 chars so sidebar rows stay short. */
export function titleFromPrompt(text: string): string {
  const line = text.trim().split('\n')[0].trim();
  const words = line.split(/\s+/);
  return words.slice(0, 6).join(' ').slice(0, 60) || line.slice(0, 60);
}

/** Chat-template control tokens (`<|im_start|>`, DeepSeek's `<｜DSML｜tool_calls>` with U+FF5C bars)
 *  leak into a reply as content when a provider fails to parse them out. They are never a title. */
const CONTROL_TOKEN_RE = /<\||\uFF5C/;

/**
 * Strips quoting/preamble from a raw model reply and clamps it to the same 6-word cap. Rejects an
 * empty reply and leaked control-token markup, so a glitched reply leaves the placeholder in place.
 */
export function sanitizeLlmTitle(raw: string): string | null {
  const line = raw
    .trim()
    .split('\n')[0]
    .replace(/^(session|chat)?\s*(title|name)\s*:\s*/i, '')
    .replace(/^[\s"'`#*]+|[\s"'`*.,!]+$/g, '')
    .trim();
  if (!line || CONTROL_TOKEN_RE.test(line)) return null;
  return titleFromPrompt(line) || null;
}

const TITLE_SYSTEM = [
  'You name coding sessions for a sidebar.',
  'Reply with a title of at most 6 words describing the task in the user message.',
  'Plain text only: no quotes, no punctuation at the end, no explanation.'
].join(' ');

/** How long we wait for the title model before falling back to the truncated prompt. */
const TITLE_TIMEOUT_MS = 20_000;

/** How much of the opening prompt we show the title model. */
const PROMPT_SAMPLE_CHARS = 800;

/** Budget for a plain completion; reasoning models need room to think first. */
const TITLE_MAX_TOKENS = 200;
const TITLE_MAX_COMPLETION_TOKENS = 1024;

/** Same family check the native driver uses: these reject max_tokens in favor of max_completion_tokens. */
function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model);
}

/**
 * One-shot LLM call that names a session from its opening prompt. Never throws:
 * returns null when no provider is usable or the call fails, leaving the
 * truncated-prompt placeholder in place.
 *
 * Prefers the configured utility model (or, failing that, the session's own
 * provider when given) so background chores use a cheap model when possible.
 */
export async function generateSessionTitle(
  prompt: string,
  providers: ProviderConfig[],
  getSecret: (providerId: string) => Promise<string | undefined>,
  preferred?: ModelRef,
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
): Promise<string | null> {
  const picked = selectBackgroundModel(providers, preferred);
  if (!picked) {
    log?.('debug', 'session title: no usable provider, keeping placeholder');
    return null;
  }
  const { provider, model } = picked;
  log?.('debug', `session title: asking ${provider.id}/${model}`);
  const apiKey = await resolveProviderApiKey(provider, getSecret);
  const sample = prompt.trim().slice(0, PROMPT_SAMPLE_CHARS);
  try {
    if (isAnthropicProvider(provider)) {
      const client = new Anthropic({ apiKey, baseURL: provider.baseUrl, maxRetries: 1, defaultHeaders: provider.headers });
      const msg = await client.messages.create(
        { model, max_tokens: TITLE_MAX_TOKENS, system: TITLE_SYSTEM, messages: [{ role: 'user', content: sample }] },
        { signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) }
      );
      const title = sanitizeLlmTitle(msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(' '));
      log?.('debug', `session title: ${title ? `got "${title}"` : 'no usable reply'}`);
      return title;
    }
    const client = new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: provider.baseUrl, maxRetries: 1, defaultHeaders: provider.headers });
    // Reasoning models (o-series, gpt-5) reject max_tokens and spend the budget on thinking
    // before any text arrives, so they need max_completion_tokens and low effort.
    const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = isReasoningModel(model)
      ? { model, max_completion_tokens: TITLE_MAX_COMPLETION_TOKENS, reasoning_effort: 'low', messages: [{ role: 'system', content: TITLE_SYSTEM }, { role: 'user', content: sample }] }
      : { model, max_tokens: TITLE_MAX_TOKENS, messages: [{ role: 'system', content: TITLE_SYSTEM }, { role: 'user', content: sample }] };
    const res = await client.chat.completions.create(body, { signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) });
    const choice = res.choices[0];
    const title = sanitizeLlmTitle(choice?.message?.content ?? '');
    log?.('debug', `session title: ${title ? `got "${title}"` : `no usable reply (finish_reason ${choice?.finish_reason ?? 'unknown'})`}`);
    return title;
  } catch (e) {
    log?.('warn', `session title failed, keeping placeholder: ${errorMessage(e)}`);
    return null;
  }
}
