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
 * The lookup is the adapter's own — `findPricing(provider, model, models)` with the endpoint's cached
 * catalog — so a repaired figure is the one a turn recorded today would carry, not a second opinion
 * about it. Passing the same list the adapter passes is the whole point: a model the gateway knows
 * and the bundled catalogs do not (OpenRouter's `z-ai/glm-5.3-flash`) has a price here only because
 * the caller supplied that list, and without it the repair would see no row and leave the fallback
 * figure in place — the one record it exists to correct.
 *
 * A repaired record is often not the fallback figure exactly, but something between it and the
 * catalog's: the adapter fix landed mid-history, so a session that spanned it has some requests
 * billed at the CLI's guess and the rest at the catalog's rate, and a per-turn sample mixing both
 * lands in between. The catalog's rate for every token is still the right answer, which is why the
 * rule is a range rather than the equality the arithmetic invites.
 */
import { estimateCostUsd, findPricing } from '../models/static-models';
import type { ModelInfo, ModelRef, SessionMeta, TranscriptItem, UsageTotals } from '../../shared/types';

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

/**
 * The corrected cost for `usage`, or undefined when the record is not a fallback-priced one. `models`
 * is the endpoint's cached catalog, which is where a model only that gateway names is priced; callers
 * pass whatever the adapter that recorded the figure would pass.
 */
export function repricingOf(ref: ModelRef | undefined, usage: UsageTotals, models: ModelInfo[] = []): Repricing | undefined {
  if (!ref || !(usage.costUsd > 0)) return undefined;
  const pricing = findPricing(ref.provider, ref.model, models);
  if (!pricing) return undefined;
  const to = estimateCostUsd(pricing, usage);
  if (!(to > 0) || to >= usage.costUsd * 0.5) return undefined;
  if (usage.costUsd > cliFallbackCostUsd(usage) * 1.001) return undefined;
  return { from: usage.costUsd, to };
}

/**
 * The counters a session's recorded totals are made of, which is also what a day bucket
 * accumulates. `turns` is a count, not a sum of anything a row carries, so the split below reads it
 * off the number of rows.
 */
export const LEDGER_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd', 'turns'] as const;
export type LedgerField = (typeof LEDGER_FIELDS)[number];

/** What a session recorded that belongs to the session it was forked from, and the rows that say so. */
export interface ForkInheritance {
  /** Per counter, the part of the session's totals that is really its fork source's. */
  inherited: Partial<Record<LedgerField, number>>;
  /** The copied turn rows, whose text and tokens are this session's context but whose money is not. */
  carriedIds: string[];
}

/**
 * Splits a session's recorded totals into what it spent itself and what it inherited from the
 * session it was forked from — the one-time correction for history written while `fork` copied its
 * source's totals into the new session, so the same dollars were charged to two sessions.
 *
 * Nothing on disk says which rows were copied; `createdAt` is the cut, and it is a safe one. `fork`
 * is the only path that writes another session's rows into a transcript and it stamps a fresh
 * `createdAt`, so every row older than the session is the source's, and every row at or after it is
 * this session's own.
 *
 * Both sides are clamped, never guessed: a session can only have inherited what its own rows do not
 * account for (`meta − own`), and never more than the copied rows are worth. That is what leaves
 * the sessions whose counters were already reset alone — a pi fork reporting 0.0478 against 25.24
 * of carried rows computes zero — and why a session this has already corrected computes zero too.
 * The result is `undefined` when there is nothing to take back.
 */
export function inheritedUsageOf(meta: SessionMeta, items: readonly TranscriptItem[]): ForkInheritance | undefined {
  const own: Partial<Record<LedgerField, number>> = {};
  const carried: Partial<Record<LedgerField, number>> = {};
  const carriedIds: string[] = [];
  let carriedCost = 0;
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    const isCarried = item.ts < meta.createdAt;
    const into = isCarried ? carried : own;
    if (isCarried) {
      carriedIds.push(item.id);
      carriedCost += item.costUsd ?? 0;
    }
    const usage = turnUsageTotals(item);
    for (const field of LEDGER_FIELDS) into[field] = (into[field] ?? 0) + (field === 'turns' ? 1 : usage[field]);
  }
  const inherited: Partial<Record<LedgerField, number>> = {};
  for (const field of LEDGER_FIELDS) {
    const share = Math.min(Math.max(0, (meta.usage[field] ?? 0) - (own[field] ?? 0)), carried[field] ?? 0);
    if (share > 0) inherited[field] = share;
  }
  // A row can be worth money its session's counter never held — a fork whose harness restarted its
  // counters already reports its own spend and nothing else, and its copied rows are still the
  // source's. Correcting the totals is a no-op there, but handing the rows over is not.
  if (!Object.keys(inherited).length && carriedCost <= 0) return undefined;
  return { inherited, carriedIds };
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
