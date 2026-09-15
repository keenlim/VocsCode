/**
 * The one-time repair for Claude sessions priced at the Claude CLI's fallback rates.
 *
 * The fixture is the session that prompted it: a Claude session on OpenCode Go's DeepSeek V4.1
 * Flash, whose spend the CLI recorded at its own $5/$25/$0.50 per Mtok because it has no pricing
 * row for the model. Its token counts are real — its own transcripts agree with them — and the
 * fallback arithmetic reproduces the stored $238.393255 exactly, which is what makes the record
 * recognisable. The catalog's rate for the same tokens is $2.81.
 */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { attribute, dayKey, emptyDay, migrateClaudeFallbackSpend, usageDelta } from '../src/main/analytics';
import { SessionStore } from '../src/main/store';
import { cliFallbackCostUsd, pricedModelOf, repricingOf, turnUsageTotals } from '../src/main/util/usage-repair';
import type { ModelRef, SessionMeta, TranscriptItem, UsageDay, UsageTotals } from '../src/shared/types';

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

function tmpDir(): string {
  const d = fsSync.mkdtempSync(path.join(os.tmpdir(), 'vocs-usage-repair-'));
  dirs.push(d);
  return d;
}

const ZERO: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

function usage(partial: Partial<UsageTotals>): UsageTotals {
  return { ...ZERO, ...partial };
}

function meta(id: string, model: ModelRef | undefined, usageTotals: UsageTotals, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: `Session ${id}`,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    config: { harness: 'claude', permissionMode: 'full-auto', projectRoot: '/repo', ...(model ? { model } : {}) },
    cwd: '/repo',
    status: 'idle',
    harnessRef: {},
    // A copy: the repair corrects `usage` in place, and one shared object across cases would leave
    // the later ones with nothing left to repair.
    usage: { ...usageTotals },
    ...overrides
  };
}

/** The session from the report: real token counts, priced by the CLI's fallback rates. */
const DEEPSEEK: ModelRef = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' };
const DEEPSEEK_USAGE = usage({ inputTokens: 3_289_680, outputTokens: 2_186_799, cacheReadTokens: 334_549_760, costUsd: 238.393255, turns: 33 });
const DEEPSEEK_CATALOG_USD = 2.80918068;
const DEEPSEEK_PHANTOM_USD = 235.58407432;

/** A store-shaped fixture: one day carrying the session's usage, built the way production builds it. */
function fileWith(session: SessionMeta, model: ModelRef): Parameters<typeof migrateClaudeFallbackSpend>[0] {
  const day: UsageDay = emptyDay();
  const delta = usageDelta(ZERO, session.usage);
  Object.assign(day, delta);
  attribute(day, { id: session.id, harness: 'claude', provider: model.provider, model: model.model, projectRoot: session.config.projectRoot }, delta);
  return {
    version: 2,
    days: { [dayKey(session.updatedAt)]: day },
    recorded: { [session.id]: { ...session.usage } },
    sessions: { [session.id]: { id: session.id, title: session.title, harness: 'claude', projectRoot: '/repo', createdAt: session.createdAt, updatedAt: session.updatedAt, usage: { ...session.usage }, toolCalls: 0 } },
    tools: {},
    modelTools: {},
    harnessTools: {},
    harnessModelTools: {},
    recordedTools: [],
    files: {}
  } as Parameters<typeof migrateClaudeFallbackSpend>[0];
}

describe('cliFallbackCostUsd', () => {
  it("reproduces what the CLI charged for the reported session's tokens", () => {
    expect(cliFallbackCostUsd(DEEPSEEK_USAGE)).toBeCloseTo(238.393255, 6);
  });
});

describe('repricingOf', () => {
  it('reprices a DeepSeek session the CLI could not price', () => {
    expect(repricingOf(DEEPSEEK, DEEPSEEK_USAGE)).toEqual({ from: 238.393255, to: DEEPSEEK_CATALOG_USD });
  });

  it('leaves a session already priced from the catalog alone', () => {
    expect(repricingOf(DEEPSEEK, usage({ ...DEEPSEEK_USAGE, costUsd: DEEPSEEK_CATALOG_USD }))).toBeUndefined();
  });

  it('reprices a session billed partly at the fallback rate and partly at the catalog rate', () => {
    // The adapter fix landed mid-history, so a session can span it: some requests billed at the
    // CLI's guess, the rest at the catalog's rate. Its recorded total then sits between the two —
    // and the catalog's rate for every token is still the right answer.
    const mixed = usage({ ...DEEPSEEK_USAGE, costUsd: 100 });
    expect(cliFallbackCostUsd(mixed)).toBeGreaterThan(100);
    expect(repricingOf(DEEPSEEK, mixed)).toEqual({ from: 100, to: DEEPSEEK_CATALOG_USD });
  });

  it('leaves a session priced above the fallback rate alone, whatever model it is filed under', () => {
    // A subagent on a pricier model makes the session's recorded spend exceed what the fallback
    // rate would charge; repricing it at the cheaper filed-under model would undercount it.
    const priced = usage({ ...DEEPSEEK_USAGE, costUsd: 400 });
    expect(cliFallbackCostUsd(priced)).toBeLessThan(400);
    expect(repricingOf(DEEPSEEK, priced)).toBeUndefined();
  });

  it('leaves a model the catalog has no price for alone', () => {
    expect(repricingOf({ provider: 'opencode-go', model: 'not-a-real-model' }, DEEPSEEK_USAGE)).toBeUndefined();
  });

  it('leaves a session with no recorded spend alone', () => {
    expect(repricingOf(DEEPSEEK, usage({ ...DEEPSEEK_USAGE, costUsd: 0 }))).toBeUndefined();
  });
});

describe('pricedModelOf', () => {
  it('reads the model the session is filed under', () => {
    expect(pricedModelOf(meta('s_1', DEEPSEEK, DEEPSEEK_USAGE))).toEqual(DEEPSEEK);
  });

  it('refuses a session whose live model switched away from the configured one', () => {
    // The tokens are then a mix of two rates and no single lookup can price them.
    const switched = meta('s_1', DEEPSEEK, DEEPSEEK_USAGE, { activeModel: { provider: 'anthropic', model: 'claude-opus-5' } });
    expect(pricedModelOf(switched)).toBeUndefined();
    expect(repricingOf(pricedModelOf(switched), switched.usage)).toBeUndefined();
  });
});

describe('migrateClaudeFallbackSpend', () => {
  it('corrects every copy of the falling-back figure and takes the phantom dollars off the day', () => {
    const session = meta('s_deepseek', DEEPSEEK, DEEPSEEK_USAGE);
    const data = fileWith(session, DEEPSEEK);
    const day = data.days[dayKey(session.updatedAt)];
    const key = `${DEEPSEEK.provider}/${DEEPSEEK.model}`;

    const result = migrateClaudeFallbackSpend(data, [session]);

    expect(result).toEqual({ ids: ['s_deepseek'], usd: DEEPSEEK_PHANTOM_USD });
    // The session the Usage panel reports, and the totals the next turn is measured against.
    expect(session.usage.costUsd).toBeCloseTo(DEEPSEEK_CATALOG_USD, 9);
    expect(data.recorded.s_deepseek.costUsd).toBeCloseTo(DEEPSEEK_CATALOG_USD, 9);
    expect(data.sessions.s_deepseek.usage.costUsd).toBeCloseTo(DEEPSEEK_CATALOG_USD, 9);
    // And every breakdown the dashboard draws the day from.
    expect(day.costUsd).toBeCloseTo(DEEPSEEK_CATALOG_USD, 9);
    expect(day.by?.harness.claude.costUsd).toBeCloseTo(DEEPSEEK_CATALOG_USD, 9);
    expect(day.by?.model[key].costUsd).toBeCloseTo(DEEPSEEK_CATALOG_USD, 9);
    expect(day.by?.harnessModel[`claude|${key}`].costUsd).toBeCloseTo(DEEPSEEK_CATALOG_USD, 9);
    expect(day.by?.project['/repo'].costUsd).toBeCloseTo(DEEPSEEK_CATALOG_USD, 9);
  });

  it('keeps the corrected total continuous, so the session goes on accumulating spend', () => {
    const session = meta('s_deepseek', DEEPSEEK, DEEPSEEK_USAGE);
    const data = fileWith(session, DEEPSEEK);
    migrateClaudeFallbackSpend(data, [session]);

    // The next turn the harness reports on top of the corrected total. Left at the old baseline the
    // delta would clamp to zero and the session would never record another cent.
    const next = usage({ ...DEEPSEEK_USAGE, costUsd: DEEPSEEK_CATALOG_USD + 0.5, turns: 34 });
    expect(usageDelta(data.recorded.s_deepseek, next).costUsd).toBeCloseTo(0.5, 9);
  });

  it('is a no-op the second time, so it can run on every load', () => {
    const session = meta('s_deepseek', DEEPSEEK, DEEPSEEK_USAGE);
    const data = fileWith(session, DEEPSEEK);
    migrateClaudeFallbackSpend(data, [session]);
    const day = data.days[dayKey(session.updatedAt)];
    const after = day.costUsd;

    expect(migrateClaudeFallbackSpend(data, [session])).toEqual({ ids: [], usd: 0 });
    expect(day.costUsd).toBe(after);
    expect(session.usage.costUsd).toBeCloseTo(DEEPSEEK_CATALOG_USD, 9);
  });

  it("leaves another harness's sessions alone", () => {
    const session = meta('s_pi', DEEPSEEK, DEEPSEEK_USAGE, { config: { harness: 'pi', permissionMode: 'full-auto', projectRoot: '/repo', model: DEEPSEEK } });
    const data = fileWith(session, DEEPSEEK);
    expect(migrateClaudeFallbackSpend(data, [session])).toEqual({ ids: [], usd: 0 });
    expect(session.usage.costUsd).toBe(238.393255);
  });

  it('corrects a session the analytics store has not recorded yet without touching a day it is not on', () => {
    // Nothing carries the session and no record of it exists, so its usage is not in the day total
    // and must not be taken out of it; the backfill that follows adds the already-corrected total.
    const session = meta('s_new', DEEPSEEK, DEEPSEEK_USAGE);
    const data = fileWith(session, DEEPSEEK);
    delete (data.recorded as Record<string, unknown>).s_new;
    delete (data.sessions as Record<string, unknown>).s_new;
    const day = emptyDay();
    day.costUsd = 5;
    day.turns = 3;
    data.days[dayKey(session.updatedAt)] = day;

    expect(migrateClaudeFallbackSpend(data, [session])).toEqual({ ids: ['s_new'], usd: DEEPSEEK_PHANTOM_USD });
    expect(session.usage.costUsd).toBeCloseTo(DEEPSEEK_CATALOG_USD, 9);
    expect(day.costUsd).toBe(5);
    expect(day.turns).toBe(3);
  });
});

describe('SessionStore.repriceTurns', () => {
  async function storeWithTurnRows(): Promise<{ store: SessionStore; dir: string; rows: () => Promise<string[]> }> {
    const dir = tmpDir();
    const store = new SessionStore(dir);
    await store.load();
    const rows = async (): Promise<string[]> => (await fs.readFile(path.join(dir, 'sessions', 's_1', 'transcript.jsonl'), 'utf8')).split('\n').filter(Boolean);
    return { store, dir, rows };
  }

  const turnRow = (id: string, costUsd: number, inputTokens: number): TranscriptItem => ({
    id,
    kind: 'turn',
    ts: 1_700_000_000_000,
    status: 'completed',
    durationMs: 1000,
    costUsd,
    usage: { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  });

  it('rewrites the turn rows an id was upserted under, and nothing else', async () => {
    const { store, rows } = await storeWithTurnRows();
    await store.appendTranscript('s_1', { id: 'user_1', kind: 'user', ts: 1, text: 'hello' });
    await store.appendTranscript('s_1', turnRow('turn_1', 100, 20_000_000));
    await store.appendTranscript('s_1', turnRow('turn_2', 0.15, 1_000_000));
    await store.appendTranscript('s_1', turnRow('turn_1', 100, 20_000_000));

    const changed = await store.repriceTurns('s_1', (turn) => repricingOf(DEEPSEEK, turnUsageTotals(turn))?.to);

    expect(changed).toBe(2);
    const written = await rows();
    expect(written).toHaveLength(4);
    const parsed = written.map((line) => JSON.parse(line) as TranscriptItem);
    expect(parsed[0]).toMatchObject({ id: 'user_1', kind: 'user', text: 'hello' });
    expect(parsed[1]).toMatchObject({ id: 'turn_1', costUsd: 3 }); // 20M input at the catalog's $0.15
    expect(parsed[3]).toMatchObject({ id: 'turn_1', costUsd: 3 }); // the duplicate upsert moves with it
    expect(parsed[2]).toMatchObject({ id: 'turn_2', costUsd: 0.15 }); // already priced from the catalog
  });

  it('leaves a turn whose spend was never recorded alone', async () => {
    // A turn that lost its sample records no cost at all; there is no fallback figure to correct.
    const { store, rows } = await storeWithTurnRows();
    await store.appendTranscript('s_1', turnRow('turn_1', 0, 20_000_000));
    expect(await store.repriceTurns('s_1', (turn) => repricingOf(DEEPSEEK, turnUsageTotals(turn))?.to)).toBe(0);
    expect(JSON.parse((await rows())[0])).toMatchObject({ id: 'turn_1', costUsd: 0 });
  });

  it('survives a transcript it cannot parse, keeping the bad row as it was', async () => {
    const { store, rows } = await storeWithTurnRows();
    await store.appendTranscript('s_1', turnRow('turn_1', 100, 20_000_000));
    const file = path.join(store.sessionDir('s_1'), 'transcript.jsonl');
    await fs.appendFile(file, 'not json at all\n');

    expect(await store.repriceTurns('s_1', (turn) => repricingOf(DEEPSEEK, turnUsageTotals(turn))?.to)).toBe(1);
    const written = await rows();
    expect(written[written.length - 1]).toBe('not json at all');
    expect(JSON.parse(written[0])).toMatchObject({ id: 'turn_1', costUsd: 3 });
  });

  it('leaves the transcript exactly as it was when repricing throws', async () => {
    const { store, rows } = await storeWithTurnRows();
    await store.appendTranscript('s_1', turnRow('turn_1', 100, 20_000_000));
    const before = await rows();

    await expect(
      store.repriceTurns('s_1', () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(await rows()).toEqual(before);
  });
});
