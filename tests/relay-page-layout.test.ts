/** Layout guard for the served web app (docs/REMOTE-ACCESS.md §4): it lives at `/app` on the
 *  landing origin, so its assets are absolute `/app/` paths and it never asks the user for a
 *  relay URL — the base is the page's own origin, with `?relay=` as the dev override. Moving the
 *  page without moving its assets, or re-adding a relay field, breaks the deployed page silently
 *  in a way no other test would catch. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative: string) => readFile(path.join(root, relative), 'utf8');

describe('web app layout (/app on the landing origin)', () => {
  it('loads its stylesheet and bundle from /app', async () => {
    const html = await read('relay/public/app/index.html');
    expect(html).toContain('href="/app/styles.css"');
    expect(html).toContain('src="/app/app.js"');
    // The pre-move root-relative references must not come back.
    expect(html).not.toMatch(/(?:href|src)="\/(?:styles\.css|app\.js)"/);
  });

  it('never asks the visitor for a relay URL', async () => {
    const html = await read('relay/public/app/index.html');
    expect(html).not.toContain('id="relay"');
    const page = await read('relay/src/page.ts');
    expect(page).toContain('relayBaseFor(window.location.origin');
    expect(page).not.toContain("el('relay')");
  });
});