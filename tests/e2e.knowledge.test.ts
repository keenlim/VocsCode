/**
 * End-to-end flow for Layer 2 project knowledge: a wiki seeded on disk is ingested and rendered in
 * the right panel's Knowledge tab without any accept step, labels and provenance are shown, a claim
 * is rejected (tombstoned) from its row, and an open page's anchors and relation graph render. The
 * session and wiki are seeded on disk so no harness and no provider key is involved. Requires
 * `npm run build`; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { serializeKnowledgeDocument, type KnowledgePageMeta } from '../src/shared/knowledge';
import type { SessionMeta } from '../src/shared/types';
import { isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

function pageMeta(over: Partial<KnowledgePageMeta>): KnowledgePageMeta {
  return {
    id: 'conventions/harness-lifecycle',
    title: 'Harness lifecycle',
    kind: 'convention',
    status: 'current',
    scope: 'repo',
    claim: 'A harness process belongs to exactly one session.',
    keywords: ['harness', 'session'],
    labels: ['session-lifecycle'],
    updatedBy: 'agent:bootstrap',
    sources: [],
    anchors: [],
    related: [],
    supersedes: [],
    contradicts: [],
    ...over
  };
}

describe.runIf(enabled)('project knowledge panel', () => {
  it('renders the auto-ingested wiki, rejects a claim, and shows anchors and relations', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-knowledge-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const wiki = path.join(project, '.vocs-code', 'wiki');
    await fs.mkdir(path.join(wiki, 'conventions'), { recursive: true });
    await fs.mkdir(path.join(wiki, 'gotchas'), { recursive: true });
    await fs.mkdir(userData, { recursive: true });
    // An auto-ingested page: current with no human review step, and an anchor to check.
    await fs.writeFile(path.join(wiki, 'conventions', 'harness-lifecycle.md'), serializeKnowledgeDocument(pageMeta({ anchors: [{ file: 'src/main/session-manager.ts', symbol: 'buildContext' }] }), 'The main process owns harness lifetime.'));
    // A second current page that relates to the first, so the graph has an edge to render.
    await fs.writeFile(
      path.join(wiki, 'gotchas', 'duplicate-pty.md'),
      serializeKnowledgeDocument(
        pageMeta({
          id: 'gotchas/duplicate-pty',
          title: 'Duplicate PTYs',
          kind: 'gotcha',
          claim: 'Renderer reconnects can duplicate a PTY.',
          labels: ['pty-lifecycle'],
          updatedBy: 'agent:distill',
          related: ['conventions/harness-lifecycle']
        }),
        'Reconnects must stay in the main process.'
      )
    );
    // A throwaway page to reject; its claim must end up tombstoned and its file removed.
    await fs.writeFile(
      path.join(wiki, 'gotchas', 'stale-flag.md'),
      serializeKnowledgeDocument(pageMeta({ id: 'gotchas/stale-flag', title: 'Stale flag', kind: 'gotcha', claim: 'The stale flag is set by the CLI.', labels: ['cli'] }), 'A flag the CLI sets.')
    );
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    const sid = 's_knowledge_e2e';
    const session = {
      id: sid,
      title: 'Knowledge panel',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
      cwd: project,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
      queued: 0
    } as SessionMeta;
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
    await fs.mkdir(path.join(userData, 'sessions', sid), { recursive: true });
    await fs.writeFile(path.join(userData, 'sessions', sid, 'transcript.jsonl'), '');

    const packaged = process.env.HARNESS_E2E_EXE;
    app = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js')],
      env: isolatedEnv(userData),
      timeout: 60_000
    });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });

    // Select the seeded session, then open the Knowledge tab in the panel's lower half.
    await win.locator('[data-testid="session-row"]').first().click();
    await win.getByTestId('panel-bottom-knowledge').click();

    const tab = win.getByTestId('knowledge-tab');
    await tab.waitFor({ timeout: 30_000 });

    // The page is there on first paint: ingestion is automatic, with no queue to accept from.
    const lifecycle = win.getByTestId('knowledge-page-conventions/harness-lifecycle');
    await lifecycle.waitFor({ timeout: 10_000 });
    const lifecycleText = await lifecycle.innerText();
    expect(lifecycleText).toContain('accepted');
    expect(lifecycleText).toContain('agent:bootstrap');
    expect(await win.getByTestId('knowledge-labels-conventions/harness-lifecycle').innerText()).toContain('session-lifecycle');
    expect(await win.getByTestId('knowledge-auto-note').innerText()).toContain('automatically');
    expect(await win.getByTestId('knowledge-accept-all').count()).toBe(0);
    expect(await win.getByTestId('knowledge-proposals').count()).toBe(0);

    // Rejecting a claim tombstones it and removes the page, with nothing left on disk.
    const staleFile = path.join(wiki, 'gotchas', 'stale-flag.md');
    expect(await fs.readFile(staleFile, 'utf8')).toContain('status: current');
    await win.getByTestId('knowledge-row-reject-gotchas/stale-flag').click();
    await win.getByTestId('knowledge-page-gotchas/stale-flag').waitFor({ state: 'detached', timeout: 10_000 });
    expect(await fs.readFile(staleFile, 'utf8').catch(() => '')).toBe('');
    const rejected = JSON.parse(await fs.readFile(path.join(wiki, '_rejected.json'), 'utf8')) as Record<string, { claim: string }>;
    expect(Object.values(rejected).map((r) => r.claim)).toContain('The stale flag is set by the CLI.');

    // An anchor is checked against GitNexus live; this sandbox has no index, so the panel says so
    // instead of failing or pretending the pointer is good.
    await lifecycle.click();
    await win.getByTestId('knowledge-detail').waitFor({ timeout: 10_000 });
    const detail = await win.getByTestId('knowledge-detail').innerText();
    // innerText reflects the rendered case (the heading is uppercased by CSS) and the flex row
    // breaks the anchor into separate lines.
    expect(detail).toContain('The main process owns harness lifetime.');
    expect(detail).toContain('GITNEXUS ANCHORS');
    expect(detail).toContain('buildContext');
    expect(detail).toContain('not checked');
    expect(detail).toContain('This project is not indexed by GitNexus.');

    // The relation graph is derived from the pages: the gotcha points at this page.
    const relations = win.getByTestId('knowledge-graph');
    await relations.waitFor({ timeout: 10_000 });
    const relationText = await relations.innerText();
    expect(relationText).toContain('related');
    expect(relationText).toContain('Duplicate PTYs');

    // The built-in MCP server for the wiki is injected and shown on the MCP tab.
    await win.getByTestId('panel-bottom-mcp').click();
    const builtin = win.getByTestId('builtin-vocs-memory');
    await builtin.waitFor({ timeout: 10_000 });
    expect(await builtin.innerText()).toContain('on');

    await app.close();
    app = null;
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
