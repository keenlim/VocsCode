/** Packaged in-app auto-update (issue #198) against a staged mock update feed.
 *
 *  Proves what the unit suites cannot: a packaged app reads `resources/app-update.yml`, its
 *  startup check hits the feed, the title-bar pill appears, the download runs to
 *  restart-pending, and the About panel describes it — while an unpackaged run of the same build
 *  never contacts the feed at all. "Restart to update" is not clicked here: the staged installer
 *  is a dummy file, so a real install can only be verified against a real Release.
 *
 *  Run: npm run dist:dir && VOCS_CODE_E2E_UI=1 HARNESS_E2E_EXE="dist/win-unpacked/Vocs Code.exe" npx vitest run tests/e2e.update.test.ts
 */
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { IpcChannel, IpcRequest, IpcResponse } from '../src/shared/ipc';
import type { UpdateState } from '../src/shared/types';
import { isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const packaged = process.env.HARNESS_E2E_EXE;
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
/** Per-run updater cache dir name, so a previous run's downloaded installer can never satisfy a
 *  new run's download (electron-updater skips the request when the cached file's sha512 matches). */
const cacheDirName = `vocs-code-update-e2e-${crypto.randomBytes(4).toString('hex')}`;

function invoke<K extends IpcChannel>(win: Page, channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
  return win.evaluate(({ channel, request }) => window.harness.invoke(channel, request), { channel, request }) as Promise<IpcResponse<K>>;
}

/** A static feed serving latest.yml + a dummy installer; counts every request it receives. */
interface Feed {
  url: string;
  requests: number;
  stop(): Promise<void>;
}

async function startFeed(): Promise<Feed> {
  const installer = Buffer.alloc(64 * 1024, 7);
  const sha512 = crypto.createHash('sha512').update(installer).digest('base64');
  const name = 'Vocs-Code-Setup-999.0.0.exe';
  const latest = [
    'version: 999.0.0',
    "releaseDate: '2026-01-01T00:00:00.000Z'",
    'path: ' + name,
    'sha512: ' + sha512,
    'files:',
    `  - url: ${name}`,
    '    sha512: ' + sha512,
    `    size: ${installer.length}`
  ].join('\n');
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (req.url?.endsWith('.exe')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(installer);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/yaml' });
    res.end(latest);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    get requests() {
      return requests;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

async function launch(userData: string, executablePath: string, args: string[], env: Record<string, string>): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({ executablePath, args, env, timeout: 90_000 });
  const win = await app.firstWindow();
  await expect.poll(() => win.evaluate(() => typeof window.harness?.invoke), { timeout: 30_000 }).toBe('function');
  return { app, win };
}

/** Waits for the update state to reach a status; polls invoke('update:state'). */
async function waitForState(win: Page, status: UpdateState['status'], timeout = 60_000): Promise<UpdateState> {
  let last: UpdateState | null = null;
  await expect
    .poll(
      async () => {
        last = await invoke(win, 'update:state', undefined);
        return last.status;
      },
      { timeout, interval: 1_000 }
    )
    .toBe(status);
  return last!;
}

describe.runIf(enabled)('electron e2e: in-app auto-update', () => {
  let feed: Feed;

  afterEach(async () => {
    if (feed) await feed.stop();
  });

  it('an unpackaged run never checks the feed', async () => {
    expect(process.env.VOCS_CODE_E2E_UI, 'Set VOCS_CODE_E2E_UI=1 to launch Electron').toBe('1');
    feed = await startFeed();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-update-dev-'));
    const userData = path.join(tmp, 'userData');
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(userData));
    const { app, win } = await launch(userData, require('electron') as string, [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`], isolatedEnv(userData, { VOCS_CODE_UPDATER_DISABLE: '' }));
    try {
      // Past the deferred-check moment (5s after startup), the feed must still be untouched.
      const state = await waitForState(win, 'idle');
      expect(state.status).toBe('idle');
      await new Promise((r) => setTimeout(r, 8_000));
      expect(feed.requests, 'the unpackaged app must never contact the update feed').toBe(0);
    } finally {
      await app.close();
    }
  });

  it.runIf(packaged)('the packaged app checks, shows the pill, downloads and reaches restart-pending', async () => {
    feed = await startFeed();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-update-app-'));
    const userData = path.join(tmp, 'userData');
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(userData));
    // Stage the feed the way electron-builder would on a real install: resources/app-update.yml
    // in the unpacked app, pointed at the local mock (a real install points at GitHub Releases).
    const resourcesDir = path.join(path.dirname(packaged!), 'resources');
    await fs.writeFile(path.join(resourcesDir, 'app-update.yml'), `provider: generic\nurl: ${feed.url}\nupdaterCacheDirName: ${cacheDirName}\n`);
    const { app, win } = await launch(userData, packaged!, [`--user-data-dir=${userData}`], isolatedEnv(userData, { VOCS_CODE_UPDATER_DISABLE: '' }));
    try {
      // Startup check → update available (999.0.0 > 0.2.0), pill in the title bar.
      const available = await waitForState(win, 'available');
      expect(available.version).toBe('999.0.0');
      const pill = win.locator('.update-pill');
      await pill.waitFor({ timeout: 20_000 });
      expect(await pill.textContent()).toContain('999.0.0');

      // Download via the pill (the way a user acts on it) → progress → restart-pending.
      await pill.click();
      const done = await waitForState(win, 'restart-pending');
      expect(done.version).toBe('999.0.0');
      expect(feed.requests).toBeGreaterThanOrEqual(2);

      // The About panel describes the state and offers restart-to-update. The pill in the title
      // bar carries the same name, so the lookup is scoped to the panel.
      await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
      await win.getByRole('button', { name: 'About & doctor' }).click();
      const panel = win.locator('.settings-updates');
      await panel.waitFor({ timeout: 20_000 });
      await expect
        .poll(async () => (await panel.textContent()) ?? '', { timeout: 20_000 })
        .toContain('is ready');
      await panel.getByRole('button', { name: 'Restart to update' }).waitFor({ timeout: 10_000 });
    } finally {
      await app.close();
    }
  });
});
