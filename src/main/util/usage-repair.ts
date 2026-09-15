/**
 * Recognition rules for spend the Claude adapter recorded at the CLI's fallback rates.
 *
 * Claude Code prices a model it has no row for at its own default rate — $5/$25/$0.50 per Mtok —
 * and flags the record `costBasis: 'unknown'`. For a cheap third-party model that is two orders of
 * magnitude too high: the DeepSeek V4.1 Flash session this was written for was recorded at $238.39
 * where the app catalog's rate for the same tokens is $2.81. The adapter now substitutes the
 * catalog's rate, but nothing recomputes usage already on disk, so the inflated figures survive in
 * the session index, every transcript turn row and the analytics rollups. These helpers are what
 * the one-time repair uses to tell such a record apart from a correctly priced one.
 *
 * Recognition is deliberately narrow, because a wrong guess here rewrites real money:
 *   - the model must resolve in the app catalog at all — an unpriced model keeps its recorded cost;
 *   - the catalog's figure must be under half what was recorded, so a session already priced from
 *     the catalog (recorded == catalog) is never touched;
 *   - the recorded figure must not exceed the CLI's fallback rate for the same tokens, which rules
 *     out a session that actually ran a pricier model than the one it is filed under.
 * A record that fails any of them is left exactly as it is.
 *
 * The lookup is the adapter's own — `findPricing(provider, model)` with no live model list — so a
 * repaired figure is the one a turn recorded today would carry, not a second opinion about it.
 *
 * A repaired record is often not the fallback figure exactly, but something between it and the
 * catalog's: the adapter fix landed mid-history, so a session that spanned it has some requests
 * billed at the CLI's guess and the rest at the catalog's rate, and a per-turn sample mixing both
 * lands in between. The catalog's rate for every token is still the right answer, which is why the
 * rule is a range rather than the equality the arithmetic invites.
 */
import { estimateCostUsd, findPricing } from '../models/static-models';
import type { ModelRef, SessionMeta, UsageTotals } from '../../shared/types';

/** Claude Code's own rate, per 1M tokens, for a model it has no pricing row for. */
export const CLI_FALLBACK_RATES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } as const;

const PER_MTOK = 1_000_000;

/** What the CLI's fallback rates would charge for these tokens. */
export function cliFallbackCostUsd(usage: Pick<UsageTotals, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return (
    (usage.inputTokens * CLI_FALLBACK_RATES.input +
      usage.outputTokens * CLI_FALLBACK_RATES.output +
      usage.cacheReadTokens * CLI_FALLBACK_RATES.cacheRead +
      usage.cacheWriteTokens * CLI_FALLBACK_RATES.cacheWrite) /
    PER_MTOK
  );
}

/**
 * The model a session's usage belongs to, or undefined when it cannot be pinned down. A live model
 * switch leaves `activeModel` disagreeing with the configured one and the recorded tokens are then
 * a mix of two rates, which no single catalog lookup can reprice.
 */
export function pricedModelOf(meta: SessionMeta): ModelRef | undefined {
  const active = meta.activeModel;
  const chosen = meta.config.model;
  if (active && chosen && (active.provider !== chosen.provider || active.model !== chosen.model)) return undefined;
  return active ?? chosen;
}

export interface Repricing {
  /** What the record says now. */
  from: number;
  /** What the app catalog's rate makes the same tokens worth. */
  to: number;
}

/** The corrected cost for `usage`, or undefined when the record is not a fallback-priced one. */
export function repricingOf(ref: ModelRef | undefined, usage: UsageTotals): Repricing | undefined {
  if (!ref || !(usage.costUsd > 0)) return undefined;
  const pricing = findPricing(ref.provider, ref.model);
  if (!pricing) return undefined;
  const to = estimateCostUsd(pricing, usage);
  if (!(to > 0) || to >= usage.costUsd * 0.5) return undefined;
  if (usage.costUsd > cliFallbackCostUsd(usage) * 1.001) return undefined;
  return { from: usage.costUsd, to };
}

/**
 * One transcript turn row's counters as the totals `repricingOf` reads. A turn row carries only the
 * four token counters and its cost, so the rest of `UsageTotals` is filled in as absent — the cost
 * rule reads nothing else.
 */
export function turnUsageTotals(turn: { usage?: Partial<UsageTotals>; costUsd?: number }): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    turns: 0,
    ...turn.usage,
    costUsd: turn.costUsd ?? 0
  };
}
