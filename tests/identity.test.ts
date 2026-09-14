import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCT_APP_ID, resolveAppIdentity } from '../src/main/identity';

const root = path.resolve(__dirname, '..');
const appDataDir = path.join(os.tmpdir(), 'vocs-appdata');

const installed = resolveAppIdentity({ packaged: true, appDataDir });
const dev = resolveAppIdentity({ packaged: false, appDataDir });

describe('app identity', () => {
  it('gives the installed app the product profile and Windows identity', () => {
    expect(installed.userDataDir).toBe(path.join(appDataDir, 'Vocs Code'));
    expect(installed.appUserModelId).toBe(PRODUCT_APP_ID);
    expect(installed.shortcutFile).toBe('Vocs Code.lnk');
    expect(installed.displayName).toBe('Vocs Code');
  });

  it('keeps an unpackaged run off the installed app profile, AUMID and shortcut', () => {
    // The single-instance lock is keyed on userData, so a shared profile makes an installed launch
    // quit and focus the open dev window; a shared AUMID/shortcut makes the installed Start Menu
    // entry launch dev instead. Both must differ from the packaged identity.
    expect(dev.userDataDir).not.toBe(installed.userDataDir);
    expect(dev.appUserModelId).not.toBe(installed.appUserModelId);
    expect(dev.shortcutFile).not.toBe(installed.shortcutFile);
    expect(dev.userDataDir).toBe(path.join(appDataDir, 'Vocs Code (Dev)'));
    expect(dev.appUserModelId).toBe(`${PRODUCT_APP_ID}.dev`);
    expect(dev.shortcutFile).toBe('Vocs Code (Dev).lnk');
    expect(dev.displayName).toBe('Vocs Code (Dev)');
  });

  it('lets VOCS_CODE_USER_DATA win over the derived directory', () => {
    const override = path.join(os.tmpdir(), 'vocs-isolated');
    expect(resolveAppIdentity({ packaged: false, appDataDir, userDataOverride: override }).userDataDir).toBe(override);
    expect(resolveAppIdentity({ packaged: true, appDataDir, userDataOverride: override }).userDataDir).toBe(override);
  });

  it('applies the identity before taking the single-instance lock', () => {
    // Setting userData after the lock would leave an unpackaged run holding (or losing) the installed
    // app's lock, which is the failure this guards.
    const source = readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
    const applied = source.indexOf("app.setPath('userData', identity.userDataDir)");
    const lock = source.indexOf('app.requestSingleInstanceLock()');
    expect(applied, 'index.ts must apply identity.userDataDir').toBeGreaterThan(-1);
    expect(lock, 'index.ts must take the single-instance lock').toBeGreaterThan(-1);
    expect(applied).toBeLessThan(lock);
  });

  it('matches the AppUserModelID the installer registers', () => {
    const builder = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    expect(builder).toContain(`appId: ${PRODUCT_APP_ID}`);
  });
});
