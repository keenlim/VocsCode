/**
 * The identity a run presents to the OS and the directory it keeps its state in.
 *
 * An unpackaged run (the dev server, `npm run preview`, the e2e suites) must not claim the installed
 * app's identity. On Windows a shared AppUserModelID and Start Menu shortcut mean a dev run rewrites
 * `Vocs Code.lnk` to point at the repo's Electron, so the installed app's shortcut launches dev. And
 * Electron derives the default userData from the product name, so an unpackaged run would also share
 * the installed app's single-instance lock, settings, sessions and keychain entries: the lock is
 * keyed on userData, so launching the installed build while `npm run dev` is open just focuses the
 * dev window and quits. Unpackaged runs therefore take a `(Dev)` profile and id; only a packaged
 * build uses the product name and id that the installer registers.
 */
import path from 'node:path';

/** Product name and AppUserModelID. The id must match `appId` in electron-builder.yml. */
export const PRODUCT_NAME = 'Vocs Code';
export const PRODUCT_APP_ID = 'dev.vocs.vocscode';

/** Separates an unpackaged run's profile and Windows identity from the installed app's. */
const DEV_SUFFIX = ' (Dev)';

export interface AppIdentity {
  /** Directory holding this run's settings, sessions, logs and keychain entries. */
  userDataDir: string;
  /** Windows AppUserModelID: groups taskbar buttons and resolves the shortcut's display name. */
  appUserModelId: string;
  /** Start Menu shortcut filename (not a full path). */
  shortcutFile: string;
  /** Name registered against the AUMID and written into the shortcut. */
  displayName: string;
}

export interface IdentityInput {
  packaged: boolean;
  /** Electron's appData root, from `app.getPath('appData')`. */
  appDataDir: string;
  /** Explicit `VOCS_CODE_USER_DATA`, which wins over the derived directory. */
  userDataOverride?: string | undefined;
}

export function resolveAppIdentity(input: IdentityInput): AppIdentity {
  const displayName = input.packaged ? PRODUCT_NAME : `${PRODUCT_NAME}${DEV_SUFFIX}`;
  return {
    userDataDir: input.userDataOverride ?? path.join(input.appDataDir, displayName),
    appUserModelId: input.packaged ? PRODUCT_APP_ID : `${PRODUCT_APP_ID}.dev`,
    shortcutFile: `${displayName}.lnk`,
    displayName
  };
}
