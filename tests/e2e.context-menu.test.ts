/**
 * Electron end-to-end for the sidebar's right-click menus, and for the only way to take a project
 * folder out of the app. Two folders and a session are seeded on disk, so the whole flow — menu,
 * confirmation, deletion, settings rewrite — is driven through the real UI with no harness and no
 * provider key. Requires `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { AppSettings, SessionMeta } from '../src/shared/types';
import { expectQuietWindow, isolatedEnv } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

const SID = 's_ctxmenu_e2e';

describe.runIf(enabled)('electron e2e: right-click menus', () => {
  it('removes a folder from the app through its context menu, and leaves the folder on disk', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ctxmenu-'));
    const userData = path.join(tmp, 'userData');
    const doomed = path.join(tmp, 'doomed');
    const keeper = path.join(tmp, 'keeper');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(doomed, { recursive: true });
    await fs.mkdir(keeper, { recursive: true });
    await fs.writeFile(path.join(doomed, 'keep-me.txt'), 'the project itself must survive', 'utf8');
    const settingsFile = path.join(userData, 'settings.json');
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        folders: [doomed, keeper],
        folderOrder: [doomed, keeper],
        recentProjects: [doomed, keeper],
        collapsedFolders: [doomed, keeper],
        folderStyles: { [doomed]: { color: '#f87171' } },
        onboardingDone: true
      })
    );

    const session: SessionMeta = {
      id: SID,
      title: 'Session in the doomed folder',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config: { harness: 'native', projectRoot: doomed, permissionMode: 'ask' },
      cwd: doomed,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    };
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
    await fs.mkdir(path.join(userData, 'sessions', SID), { recursive: true });
    await fs.writeFile(path.join(userData, 'sessions', SID, 'transcript.jsonl'), '');

    app = await electron.launch({
      executablePath: require('electron') as string,
      args: [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
      env: isolatedEnv(userData),
      timeout: 60_000
    });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });
    await expectQuietWindow(app);
    await fs.mkdir(shots, { recursive: true });

    const headers = win.locator('.project-header');
    expect(await headers.count()).toBe(2);
    const doomedHeader = win.locator('.project-header', { hasText: path.basename(doomed) });
    // Both folders are seeded collapsed; expanding this one brings its session row into the list.
    await doomedHeader.locator('.project-fold-btn').click();

    // A right-click on a session row offers that row's actions, and Escape dismisses it.
    await win.locator('.session-row').first().click({ button: 'right' });
    const menu = win.getByTestId('context-menu');
    await menu.waitFor({ timeout: 10_000 });
    expect(await menu.innerText()).toContain('Rename');
    expect(await menu.innerText()).toContain('Delete session');
    await win.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached', timeout: 10_000 });

    // The folder header's menu carries the removal.
    await doomedHeader.click({ button: 'right' });
    await menu.waitFor({ timeout: 10_000 });
    await win.screenshot({ path: path.join(shots, 'context-menu-01-folder.png') });
    expect(await menu.innerText()).toContain('Copy path');
    await menu.getByRole('menuitem', { name: 'Remove folder from Vocs Code' }).click();

    // The confirmation has to say, in the dialog itself, that the folder on disk is not deleted.
    const dialog = win.locator('.modal');
    await dialog.waitFor({ timeout: 10_000 });
    const body = await dialog.innerText();
    expect(body).toContain(`Remove "${path.basename(doomed)}" from Vocs Code?`);
    expect(body).toContain('Its session and its transcript are removed');
    expect(body).toContain('not deleted');
    await win.screenshot({ path: path.join(shots, 'context-menu-02-confirm.png') });
    await dialog.getByRole('button', { name: 'Remove folder' }).click();

    // The folder, its session and its settings go; the other folder stays untouched.
    await expect.poll(async () => await headers.count(), { timeout: 20_000 }).toBe(1);
    expect(await win.locator('.project-header').innerText()).toContain(path.basename(keeper));
    expect(await win.locator('.session-row').count()).toBe(0);
    await win.screenshot({ path: path.join(shots, 'context-menu-03-removed.png') });

    await expect
      .poll(async () => (JSON.parse(await fs.readFile(settingsFile, 'utf8')) as AppSettings).folders, { timeout: 20_000 })
      .toEqual([keeper]);
    const saved = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as AppSettings;
    expect(saved.folderOrder).toEqual([keeper]);
    expect(saved.recentProjects).toEqual([keeper]);
    expect(saved.collapsedFolders).toEqual([keeper]);
    expect(saved.folderStyles).toEqual({});
    expect(JSON.parse(await fs.readFile(path.join(userData, 'sessions.json'), 'utf8'))).toEqual([]);

    // The point of "remove from Vocs Code": the project directory is still there, contents and all.
    expect(await fs.readFile(path.join(doomed, 'keep-me.txt'), 'utf8')).toContain('must survive');

    await app.close();
    app = null;
  }, 120_000);
});
