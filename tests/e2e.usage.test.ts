/**
 * Electron end-to-end for the right panel's Usage dashboard. A session, its totals and a transcript
 * carrying turns, tool calls, file changes and failures are seeded on disk, so the whole page is
 * driven through the real UI with no harness and no provider key. Requires `npm run build` first;
 * gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';
import { expectQuietWindow, isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

const SID = 's_usage_e2e';
const T = Date.now() - 600_000;

/** Three turns: one clean, one interrupted, one failed — plus the tool traffic around them. */
function transcript(): TranscriptItem[] {
  return [
    { id: 'u1', kind: 'user', ts: T, text: 'Wire up the registry' },
    { id: 't1', kind: 'tool', ts: T + 1, name: 'read_file', hint: 'read', status: 'done', durationMs: 120 },
    { id: 't2', kind: 'tool', ts: T + 2, name: 'apply_patch', hint: 'edit', status: 'done', durationMs: 340, changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }] },
    { id: 'a1', kind: 'assistant', ts: T + 3, text: 'Registered.' },
    { id: 'turn1', kind: 'turn', ts: T + 4, status: 'completed', durationMs: 5200, costUsd: 0.4, usage: { inputTokens: 900, outputTokens: 420 } },
    { id: 'u2', kind: 'user', ts: T + 5, text: 'Now run the tests' },
    { id: 't3', kind: 'tool', ts: T + 6, name: 'bash', hint: 'execute', status: 'error', durationMs: 900, exitCode: 1, output: 'FAIL tests/registry.test.ts' },
    { id: 'turn2', kind: 'turn', ts: T + 7, status: 'interrupted', durationMs: 2100, costUsd: 0.15, usage: { inputTokens: 300, outputTokens: 60 } },
    { id: 'u3', kind: 'user', ts: T + 8, text: 'Retry' },
    { id: 't4', kind: 'tool', ts: T + 9, name: 'bash', hint: 'execute', status: 'error', durationMs: 150, exitCode: 1, output: 'FAIL tests/registry.test.ts' },
    { id: 'i1', kind: 'info', ts: T + 10, level: 'warn', text: 'context is getting full' },
    { id: 'turn3', kind: 'turn', ts: T + 11, status: 'failed', durationMs: 1800, costUsd: 0.2, error: 'provider returned 429' }
  ];
}

describe.runIf(enabled)('electron e2e: usage dashboard', () => {
  it('shows spend, counters, meters and all three detail views for a seeded session', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-usage-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    const session: SessionMeta = {
      id: SID,
      title: 'Usage dashboard',
      createdAt: T,
      updatedAt: T,
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask', maxBudgetUsd: 1.5 },
      cwd: project,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 1200, outputTokens: 480, cacheReadTokens: 3600, cacheWriteTokens: 240, reasoningTokens: 0, costUsd: 0.75, turns: 3, contextWindow: 200_000, contextTokens: 120_000 }
    };
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
    await fs.mkdir(path.join(userData, 'sessions', SID), { recursive: true });
    await fs.writeFile(path.join(userData, 'sessions', SID, 'transcript.jsonl'), transcript().map((i) => JSON.stringify(i)).join('\n') + '\n');

    const packaged = process.env.HARNESS_E2E_EXE;
    app = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
      env: isolatedEnv(userData),
      timeout: 60_000
    });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });
    await expectQuietWindow(app);

    await win.click('.panel-tab:has-text("Usage")');
    const panel = win.getByTestId('usage-panel');
    await panel.waitFor({ timeout: 30_000 });

    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'usage-00-summary.png') });

    // Summary block: spend, and counters the page derives from the transcript rather than the totals.
    expect(await win.locator('.usage-hero-value').innerText()).toBe('$0.75');
    expect(await win.locator('.usage-hero-sub').innerText()).toContain('4 tool calls');
    expect(await win.locator('.ukpi').count()).toBeGreaterThanOrEqual(8);
    expect(await panel.getByTitle(/Failed tool calls/).innerText()).toContain('3'); // 2 failed tools + 1 failed turn
    expect(await panel.getByTitle(/Distinct paths reported as changed/).innerText()).toContain('2');

    // Both meters are present and read the seeded numbers, not a placeholder.
    expect(await win.getByRole('meter', { name: 'Context window' }).getAttribute('aria-valuenow')).toBe('60');
    expect(await win.getByRole('meter', { name: 'Budget' }).getAttribute('aria-valuenow')).toBe('50');
    expect(await win.getByRole('meter', { name: 'Tool success' }).getAttribute('aria-valuenow')).toBe('50');

    // Turns view: one column per recorded turn, and the readout follows the hovered one.
    expect(await win.locator('.uturn').count()).toBe(3);
    expect(await win.locator('.uturn.st-interrupted').count()).toBe(1);
    expect(await win.locator('.uturn.st-failed').count()).toBe(1);
    await win.locator('.uturn').first().hover();
    expect(await win.locator('.uturn-readout').innerText()).toContain('Turn 1/3');
    // Switching the metric moves the pointer off the chart, so re-enter it before reading a turn.
    await win.getByRole('radio', { name: 'Time' }).click();
    await win.locator('.uturn').first().hover();
    expect(await win.locator('.uturn-readout').innerText()).toContain('5.2s');
    expect(await win.locator('.uturn-row').count()).toBe(3);

    await win.screenshot({ path: path.join(shots, 'usage-01-turns.png') });

    // Tools view: the mix, and the busiest-tool list with its per-tool failure count.
    await win.getByRole('radio', { name: 'Tools' }).click();
    await win.getByRole('img', { name: 'Tool calls by category' }).waitFor({ timeout: 10_000 });
    expect(await win.locator('.usage-detail .hbar').count()).toBe(3);
    expect(await win.locator('.usage-detail .hbar').first().innerText()).toContain('2 failed');
    await win.getByRole('img', { name: 'Reported file changes by kind' }).waitFor({ timeout: 10_000 });
    await win.screenshot({ path: path.join(shots, 'usage-02-tools.png') });

    // Errors view: completion meters, the failure counters and the log of what actually failed.
    await win.getByRole('radio', { name: 'Errors' }).click();
    expect(await win.getByRole('meter', { name: 'Turn completion' }).getAttribute('aria-valuenow')).toBe('33');
    expect(await win.locator('.uerr-count.hot').count()).toBe(4); // failed tools, failed turns, interrupted, warnings
    const log = win.locator('.uerr');
    expect(await log.count()).toBe(3);
    expect(await log.first().innerText()).toContain('provider returned 429');
    expect(await log.nth(1).innerText()).toContain('exit 1 · FAIL tests/registry.test.ts');
    await win.screenshot({ path: path.join(shots, 'usage-03-errors.png') });

    // The page fills the panel's upper half rather than trailing off after a few tiles.
    const body = await win.locator('.panel-section.panel-top .panel-body').boundingBox();
    const content = await panel.boundingBox();
    expect(content!.height).toBeGreaterThan(body!.height * 0.9);
  }, 180_000);
});
