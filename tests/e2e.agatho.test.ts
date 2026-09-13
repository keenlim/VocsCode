/** Real Electron -> preload -> Agatho -> installed Pi, with an offline scripted model.
 *
 *  Proves the things the unit suites cannot: the panel is anchored by its bottom edge and grows
 *  upward, a read capability runs through the real pi bridge without asking, and a declined write
 *  visibly changes nothing. Set VOCS_CODE_PI_INTEGRATION=1 (installed Pi required) and
 *  VOCS_CODE_E2E_UI=1 (launch Electron); HARNESS_E2E_EXE selects the packaged app.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { IpcChannel, IpcRequest, IpcResponse } from '../src/shared/ipc';
import type { SessionMeta } from '../src/shared/types';
import { piIntegrationPaths } from './pi-offline-runner';
import { isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_PI_INTEGRATION === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

function invoke<K extends IpcChannel>(win: Page, channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
  return win.evaluate(({ channel, request }) => window.harness.invoke(channel, request), { channel, request }) as Promise<IpcResponse<K>>;
}

const scripted = (calls: unknown[]) => JSON.stringify({ calls });

describe.runIf(enabled)('electron e2e: Agatho on pi', () => {
  it('anchors at the bottom, runs a read capability, and applies nothing the user declines', async () => {
    expect(process.env.VOCS_CODE_E2E_UI, 'Set VOCS_CODE_E2E_UI=1 to launch Electron').toBe('1');
    const { cli } = piIntegrationPaths();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-agatho-app-'));
    const userData = path.join(tmp, 'userData');
    const agentDir = path.join(tmp, 'agent');
    const project = path.join(tmp, 'project');
    let app: ElectronApplication | undefined;
    try {
      await Promise.all([userData, agentDir, project].map((dir) => fs.mkdir(dir, { recursive: true })));
      // The app resolves `binaries.pi`, so the shim is where the offline scripted provider gets
      // attached — Agatho's own hermetic flags are untouched.
      const shim = path.join(tmp, process.platform === 'win32' ? 'pi.cmd' : 'pi');
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const scriptedArgs = ['-e', path.join(root, 'tests', 'fixtures', 'pi-scripted-provider.mjs'), '--offline', '--provider', 'vocs-offline', '--model', 'scripted', '--thinking', 'off'];
      await fs.writeFile(
        shim,
        process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${cli}" ${scriptedArgs.map((a) => `"${a}"`).join(' ')} %*\r\n`
          : `#!/bin/sh\nexec ${[process.execPath, cli, ...scriptedArgs].map(quote).join(' ')} "$@"\n`
      );
      if (process.platform !== 'win32') await fs.chmod(shim, 0o755);
      await fs.writeFile(
        path.join(userData, 'settings.json'),
        seedSettings(project, {
          binaries: { pi: shim },
          agentModel: { provider: 'vocs-offline', model: 'scripted' },
          agent: { enabled: true, collapsed: true }
        })
      );
      const packaged = process.env.HARNESS_E2E_EXE;
      app = await electron.launch({
        executablePath: packaged || (require('electron') as string),
        args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
        env: isolatedEnv(userData, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' }),
        timeout: 60_000
      });
      const win = await app.firstWindow();
      await expect.poll(() => win.evaluate(() => typeof window.harness?.invoke), { timeout: 30_000 }).toBe('function');

      // Open from the avatar the way a user does, then check where the panel sits.
      await win.getByLabel('Open Agatho').click();
      const panel = win.getByRole('dialog', { name: 'Agatho' });
      await panel.waitFor();
      const parked = (await panel.boundingBox())!;
      const viewport = await win.evaluate(() => window.innerHeight);
      expect(Math.abs(viewport - (parked.y + parked.height) - 24), 'the panel parks 24px above the bottom edge').toBeLessThanOrEqual(2);

      // A read capability runs without a proposal and its result reaches the model. The filler
      // makes the user bubble taller than the panel's empty-state minimum, so growth is visible.
      const composer = win.getByPlaceholder('Ask Agatho…');
      const filler = 'which sessions are active right now? '.repeat(6);
      await composer.fill(JSON.stringify({ note: filler, calls: [{ id: 'r1', name: 'list_sessions', arguments: {} }] }));
      await composer.press('Enter');
      await win.getByText('List sessions').waitFor({ timeout: 60_000 });
      await win.getByText('COMPAT_OK').waitFor({ timeout: 60_000 });
      expect(await win.getByText('Apply').count(), 'a read capability is never gated').toBe(0);

      // The foot stays put while the transcript grows: that is what "grows upward" means.
      const grown = (await panel.boundingBox())!;
      expect(grown.height).toBeGreaterThan(parked.height);
      expect(Math.abs(grown.y + grown.height - (parked.y + parked.height))).toBeLessThanOrEqual(1);

      // A write capability is proposed, and declining leaves the app exactly as it was.
      const sessionsBefore = await invoke(win, 'sessions:list', undefined);
      await composer.fill(scripted([{ id: 'w1', name: 'create_session', arguments: { project_root: project, title: 'Ghost' } }]));
      await composer.press('Enter');
      const decline = win.getByRole('button', { name: 'Decline' });
      await decline.waitFor({ timeout: 60_000 });
      expect(await invoke(win, 'sessions:list', undefined)).toHaveLength(sessionsBefore.length);
      await decline.click();
      await win.getByText('COMPAT_OK').nth(1).waitFor({ timeout: 60_000 });
      const sessionsAfter = await invoke(win, 'sessions:list', undefined);
      expect(sessionsAfter.map((s: SessionMeta) => s.id).sort()).toEqual(sessionsBefore.map((s: SessionMeta) => s.id).sort());
      expect(sessionsAfter.some((s: SessionMeta) => s.title === 'Ghost')).toBe(false);
    } finally {
      await app?.close().catch(() => undefined);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 180_000);
});
