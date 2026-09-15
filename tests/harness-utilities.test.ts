import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeFileChange } from '../src/main/util/file-changes';
import { TurnUsageTracker } from '../src/main/util/turn-usage';
import { UsageReporter } from '../src/main/util/usage-reporter';
import { emptyUsage } from '../src/main/models/static-models';
import type { SessionEvent } from '../src/shared/types';

describe('makeFileChange', () => {
  it('normalizes absolute paths and preserves add/update diff semantics', () => {
    const added = makeFileChange('/workspace', '/workspace/src/new.ts', null, 'new\n', { newFileHeader: '(new file)' });
    expect(added).toMatchObject({ path: `src${path.sep}new.ts`, kind: 'add' });
    expect(added.diff).toContain('(new file)');
    expect(makeFileChange('/workspace', 'src/new.ts', null, 'new\n', { oldFileName: '/dev/null' }).diff).toContain('--- /dev/null');

    const updated = makeFileChange('/workspace', '/workspace/src/new.ts', 'old\n', 'new\n');
    expect(updated).toMatchObject({ path: `src${path.sep}new.ts`, kind: 'update' });
    expect(updated.diff).toContain('-old');
    expect(updated.diff).toContain('+new');
  });

  it('can treat an empty old value as an add for protocol payloads', () => {
    expect(makeFileChange('/workspace', 'empty.txt', '', 'content', { addWhenEmpty: true }).kind).toBe('add');
    expect(makeFileChange('/workspace', 'empty.txt', '', 'content').kind).toBe('update');
  });
});

describe('TurnUsageTracker', () => {
  it('derives cumulative and per-turn usage from reported counters', () => {
    const tracker = new TurnUsageTracker(emptyUsage());
    tracker.beginTurn();
    tracker.setCumulative({ inputTokens: 10, outputTokens: 4, costUsd: 0.5, contextTokens: 14 });
    const first = tracker.finishTurn();
    expect(first.totals).toMatchObject({ inputTokens: 10, outputTokens: 4, costUsd: 0.5, turns: 1, contextTokens: 14 });
    expect(first.usage).toMatchObject({ inputTokens: 10, outputTokens: 4, costUsd: 0.5 });

    tracker.beginTurn();
    tracker.setCumulative({ inputTokens: 16, outputTokens: 7, costUsd: 0.8 });
    expect(tracker.finishTurn().usage).toMatchObject({ inputTokens: 6, outputTokens: 3 });
    // A duplicate completion event cannot create a phantom turn.
    expect(tracker.finishTurn()).toEqual({ totals: expect.objectContaining({ turns: 2 }) });
    expect(tracker.snapshot().turns).toBe(2);
  });

  it('rebases a reset cumulative counter without decreasing app totals', () => {
    const tracker = new TurnUsageTracker({ ...emptyUsage(), inputTokens: 20 });
    tracker.beginTurn();
    tracker.setCumulative({ inputTokens: 3 });
    expect(tracker.finishTurn().usage?.inputTokens).toBe(0);
    expect(tracker.snapshot().inputTokens).toBe(20);

    tracker.beginTurn();
    tracker.setCumulative({ inputTokens: 8 });
    expect(tracker.finishTurn().usage?.inputTokens).toBe(5);
    expect(tracker.snapshot().inputTokens).toBe(25);
  });

  it('adds per-step usage for adapters with non-cumulative responses', () => {
    const tracker = new TurnUsageTracker(emptyUsage());
    tracker.beginTurn();
    tracker.addUsage({ inputTokens: 2, outputTokens: 1 });
    tracker.addUsage({ inputTokens: 3, outputTokens: 4 });
    expect(tracker.finishTurn().usage).toMatchObject({ inputTokens: 5, outputTokens: 5 });
  });

  it('keeps streamed samples pending when a turn ends before its cumulative snapshot', () => {
    const tracker = new TurnUsageTracker(emptyUsage());
    tracker.beginTurn();
    tracker.setCumulative({ inputTokens: 100 });
    expect(tracker.finishTurn().usage?.inputTokens).toBe(100);

    // A turn the provider never confirmed: its streamed samples are the only record of it until a
    // later snapshot covers them, so closing the turn must not mark them reconciled.
    tracker.beginTurn();
    tracker.addUsage({ inputTokens: 40 });
    expect(tracker.finishTurn().usage?.inputTokens).toBe(40);

    tracker.beginTurn();
    tracker.setCumulative({ inputTokens: 150 });
    expect(tracker.snapshot()).toMatchObject({ inputTokens: 150, turns: 2 });
  });

  it('counts the first cumulative sample of a declared process instead of discarding it', () => {
    // Claude Code restarts its counters at zero on every resume, so the first snapshot of a new
    // process arrives *below* the totals already recorded. Read as a stale sample it hits the
    // only-raise branch and the whole first turn's cost is dropped — which is exactly what the
    // resumed sessions showed: a turn with real tokens recorded at cost 0.
    const seeded = (): TurnUsageTracker => new TurnUsageTracker({ ...emptyUsage(), inputTokens: 5_000, costUsd: 10 });

    const undeclared = seeded();
    undeclared.beginTurn();
    undeclared.setCumulative({ inputTokens: 1_000, costUsd: 0.4 });
    expect(undeclared.finishTurn().usage).toMatchObject({ inputTokens: 0, costUsd: 0 });
    expect(undeclared.snapshot().inputTokens).toBe(5_000);
    expect(undeclared.snapshot().costUsd).toBeCloseTo(10, 9);

    const declared = seeded();
    declared.beginProcess();
    declared.beginTurn();
    declared.setCumulative({ inputTokens: 1_000, costUsd: 0.4 });
    // The process's own counters, counted on top of what the session already held.
    const turn = declared.finishTurn().usage;
    expect(turn?.inputTokens).toBe(1_000);
    expect(turn?.costUsd).toBeCloseTo(0.4, 9);
    expect(declared.snapshot().inputTokens).toBe(6_000);
    expect(declared.snapshot().costUsd).toBeCloseTo(10.4, 9);
  });

  it('adds each process epoch once, without double counting the samples streamed before it', () => {
    const tracker = new TurnUsageTracker({ ...emptyUsage(), costUsd: 10 });
    tracker.beginProcess();
    tracker.beginTurn();
    // The streamed sample for the same request arrives first and is provisional: the cumulative
    // snapshot that follows covers it, so taking both would bill the request twice.
    tracker.addUsage({ costUsd: 0.1 });
    tracker.setCumulative({ costUsd: 0.4 });
    expect(tracker.finishTurn().usage?.costUsd).toBeCloseTo(0.4, 9);
    expect(tracker.snapshot().costUsd).toBeCloseTo(10.4, 9);

    // A second process on the same session: its first sample is its own too.
    tracker.beginProcess();
    tracker.beginTurn();
    tracker.setCumulative({ costUsd: 0.25 });
    expect(tracker.finishTurn().usage?.costUsd).toBeCloseTo(0.25, 9);
    expect(tracker.snapshot().costUsd).toBeCloseTo(10.65, 9);
  });

  it('reconciles streamed per-request samples with the final cumulative counter', () => {
    const tracker = new TurnUsageTracker(emptyUsage());
    tracker.beginTurn();
    tracker.addUsage({ inputTokens: 10, outputTokens: 2, costUsd: 0.1 });
    tracker.setCumulative({ inputTokens: 10, outputTokens: 2, costUsd: 0.1 });
    expect(tracker.finishTurn().usage).toMatchObject({ inputTokens: 10, outputTokens: 2, costUsd: 0.1 });

    tracker.beginTurn();
    tracker.addUsage({ inputTokens: 20, outputTokens: 3, costUsd: 0.2 });
    tracker.setCumulative({ inputTokens: 30, outputTokens: 5, costUsd: 0.3 });
    const second = tracker.finishTurn();
    expect(second.usage).toMatchObject({ inputTokens: 20, outputTokens: 3 });
    expect(second.usage?.costUsd).toBeCloseTo(0.2);
    expect(second.totals).toMatchObject({ inputTokens: 30, outputTokens: 5, turns: 2 });
    expect(second.totals.costUsd).toBeCloseTo(0.3);
  });
});

describe('UsageReporter', () => {
  it('emits the first live snapshot immediately and coalesces later updates', () => {
    vi.useFakeTimers();
    try {
      const events: SessionEvent[] = [];
      const reporter = new UsageReporter((event) => events.push(event), 1_000);
      reporter.report({ ...emptyUsage(), inputTokens: 10 });
      reporter.report({ ...emptyUsage(), inputTokens: 20 });
      expect(events).toHaveLength(1);
      vi.advanceTimersByTime(999);
      expect(events).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(events).toHaveLength(2);
      expect(events[1].type === 'usage' && events[1].totals.inputTokens).toBe(20);
      reporter.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
