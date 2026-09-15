/**
 * End-to-end flow for Layer 2 project knowledge: a seeded wiki renders in the right panel's
 * Knowledge tab, a proposal is accepted only on an explicit click, and the accepted page is written
 * back to markdown with human-review provenance. The session and wiki are seeded on disk so no
 * harness and no provider key is involved. Requires `npm run build`; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { serializeKnowledgeDocument, type KnowledgePageMeta } from '../src/shared/knowledge';
import type { SessionMeta } from '../src/shared/types';
import { seedSettings } from './e2e-ui';

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
    sources: [],
    anchors: [],
    related: [],
    supersedes: [],
    contradicts: [],
    review: { state: 'reviewed', by: 'human' },
    ...over
  };
}

/** Boots the built app against a seeded userData, with every provider key stripped. */
async function launch(userData: string): Promise<Page> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
    if (/^(ANTHROPIC|OPENAI|DEEPSEEK|OPENROUTER|GEMINI|GROQ|XAI|MISTRAL)_API_KEY$/.test(k)) continue;
    env[k] = v;
  }
  env.VOCS_CODE_USER_DATA = userData;

  const packaged = process.env.HARNESS_E2E_EXE;
  app = await electron.launch({
    executablePath: packaged || (require('electron') as string),
    args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js')],
    env,
    timeout: 60_000
  });
  const win: Page = await app.firstWindow();
  await win.waitForSelector('.brand', { timeout: 60_000 });
  return win;
}

/** Writes the sessions index and an empty transcript for one seeded session. */
async function seedSession(userData: string, sid: string, project: string): Promise<void> {
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
}

describe.runIf(enabled)('project knowledge panel', () => {
  it('shows the wiki, accepts a proposal on click, and writes it back as reviewed markdown', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-knowledge-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const wiki = path.join(project, '.vocs-code', 'wiki');
    await fs.mkdir(path.join(wiki, 'conventions'), { recursive: true });
    await fs.mkdir(path.join(wiki, '_proposals'), { recursive: true });
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(path.join(wiki, 'conventions', 'harness-lifecycle.md'), serializeKnowledgeDocument(pageMeta({ anchors: [{ file: 'src/main/session-manager.ts', symbol: 'buildContext' }] }), 'The main process owns harness lifetime.'));
    await fs.writeFile(
      path.join(wiki, '_proposals', 'pty-guard.md'),
      serializeKnowledgeDocument(
        pageMeta({
          id: 'pty-guard',
          title: 'PTY guard',
          kind: 'gotcha',
          status: 'proposed',
          claim: 'Renderer reconnects can duplicate a PTY.',
          targetPageId: 'gotchas/pty-guard',
          review: { state: 'unreviewed' }
        }),
        'Reconnects must stay in the main process.'
      )
    );
    // A generated draft, which the panel must be able to accept into the served wiki.
    await fs.mkdir(path.join(wiki, 'architecture'), { recursive: true });
    await fs.writeFile(
      path.join(wiki, 'architecture', 'process-split.md'),
      serializeKnowledgeDocument(
        pageMeta({ id: 'architecture/process-split', title: 'Process split', kind: 'architecture', status: 'draft', claim: 'The main process owns privileged work.', review: { state: 'unreviewed' } }),
        'The renderer stays sandboxed.'
      )
    );
    // A deliberate `uncertain` page: a recorded judgement, which Accept all must leave alone.
    await fs.writeFile(
      path.join(wiki, 'conventions', 'maybe.md'),
      serializeKnowledgeDocument(
        pageMeta({ id: 'conventions/maybe', title: 'Maybe', status: 'uncertain', claim: 'We are not sure this still holds.', review: { state: 'unreviewed' } }),
        'Unverified.'
      )
    );
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    const sid = 's_knowledge_e2e';
    await seedSession(userData, sid, project);

    const win = await launch(userData);

    // Select the seeded session, then open the Knowledge tab in the panel's lower half.
    await win.locator('[data-testid="session-row"]').first().click();
    await win.getByTestId('panel-bottom-knowledge').click();

    const tab = win.getByTestId('knowledge-tab');
    await tab.waitFor({ timeout: 30_000 });
    const accepted = win.getByTestId('knowledge-page-conventions/harness-lifecycle');
    await accepted.waitFor({ timeout: 10_000 });
    expect(await accepted.innerText()).toContain('human-reviewed');

    // The proposal is rendered and nothing has been written yet.
    const proposal = win.getByTestId('knowledge-proposal-pty-guard');
    await proposal.waitFor({ timeout: 10_000 });
    expect(await proposal.innerText()).toContain('Renderer reconnects can duplicate a PTY.');
    const proposalFile = path.join(wiki, '_proposals', 'pty-guard.md');
    expect(await fs.readFile(proposalFile, 'utf8')).toContain('status: proposed');

    // Preview reads a *proposal*, which lives outside the page tree — it used to resolve to
    // nothing at all and leave the panel unchanged.
    await win.getByTestId('knowledge-preview-pty-guard').click();
    const preview = win.getByTestId('knowledge-detail');
    await preview.waitFor({ timeout: 10_000 });
    expect(await preview.innerText()).toContain('Reconnects must stay in the main process.');
    await win.getByTestId('knowledge-detail').getByTitle('Back to the list').click();
    await preview.waitFor({ state: 'detached', timeout: 10_000 });

    // A draft is accepted straight from its row, without opening it.
    const draftFile = path.join(wiki, 'architecture', 'process-split.md');
    expect(await fs.readFile(draftFile, 'utf8')).toContain('status: draft');
    await win.getByTestId('knowledge-row-accept-architecture/process-split').click();
    await win.getByTestId('knowledge-row-accept-architecture/process-split').waitFor({ state: 'detached', timeout: 10_000 });
    const acceptedDraft = await fs.readFile(draftFile, 'utf8');
    expect(acceptedDraft).toContain('status: current');
    expect(acceptedDraft).toContain('review_state: reviewed');

    // Accept all takes what is left: the proposal becomes a reviewed page under its target id.
    await win.getByTestId('knowledge-accept-all').click();
    await proposal.waitFor({ state: 'detached', timeout: 10_000 });
    expect(await fs.readFile(proposalFile, 'utf8').catch(() => '')).toBe('');
    const stored = await fs.readFile(path.join(wiki, 'gotchas', 'pty-guard.md'), 'utf8');
    expect(stored).toContain('status: current');
    expect(stored).toContain('review_state: reviewed');
    expect(stored).not.toContain('target_page:');
    expect(stored).toContain('Reconnects must stay in the main process.');

    // Accept all is for unreviewed candidates only: `uncertain` is a judgement about the claim, so
    // a bulk action must not promote it to current truth behind the user's back.
    expect(await fs.readFile(path.join(wiki, 'conventions', 'maybe.md'), 'utf8')).toContain('status: uncertain');

    // Discarding from the detail view deletes the page and tombstones its claim, and the panel
    // lists the tombstone — the rule an agent silently hits has to be inspectable.
    await win.getByTestId('knowledge-page-conventions/maybe').click();
    await win.getByTestId('knowledge-detail').waitFor({ timeout: 10_000 });
    await win.getByTestId('knowledge-page-discard').click();
    const rejected = win.getByTestId('knowledge-rejected');
    await rejected.waitFor({ timeout: 10_000 });
    expect(await rejected.innerText()).toContain('1 rejected claim');
    await expect(fs.stat(path.join(wiki, 'conventions', 'maybe.md'))).rejects.toThrow();
    const tombstones = JSON.parse(await fs.readFile(path.join(wiki, '_rejected.json'), 'utf8')) as Record<string, { claim: string }>;
    expect(Object.values(tombstones).map((t) => t.claim)).toEqual(['We are not sure this still holds.']);

    // The built-in MCP server for the wiki is injected and shown on the MCP tab.
    await win.getByTestId('panel-bottom-mcp').click();
    const builtin = win.getByTestId('builtin-vocs-memory');
    await builtin.waitFor({ timeout: 10_000 });
    expect(await builtin.innerText()).toContain('on');
    await win.getByTestId('panel-bottom-knowledge').click();

    // An anchor is checked against GitNexus live; this sandbox has no index, so the panel says so
    // instead of failing or pretending the pointer is good.
    await win.getByTestId('knowledge-page-conventions/harness-lifecycle').click();
    await win.getByTestId('knowledge-detail').waitFor({ timeout: 10_000 });
    const detail = await win.getByTestId('knowledge-detail').innerText();
    // innerText reflects the rendered case (the heading is uppercased by CSS) and the flex row
    // breaks the anchor into separate lines.
    expect(detail).toContain('GITNEXUS ANCHORS');
    expect(detail).toContain('buildContext');
    expect(detail).toContain('not checked');
    expect(detail).toContain('This project is not indexed by GitNexus.');

    await app?.close();
    app = null;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('starts a wiki for a project with no docs, which is what switches the memory server on', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-knowledge-init-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const sid = 's_knowledge_init_e2e';
    await seedSession(userData, sid, project);

    const win = await launch(userData);
    await win.locator('[data-testid="session-row"]').first().click();
    await win.getByTestId('panel-bottom-knowledge').click();
    await win.getByTestId('knowledge-tab').waitFor({ timeout: 30_000 });

    // Bootstrap needs both docs to read and a configured utility model; this project has neither,
    // and without a wiki directory there is no MCP server and no episode capture at all.
    const memoryOff = win.getByTestId('builtin-vocs-memory');
    await win.getByTestId('panel-bottom-mcp').click();
    await memoryOff.waitFor({ timeout: 10_000 });
    expect(await memoryOff.innerText()).toContain('No project wiki yet');
    await win.getByTestId('panel-bottom-knowledge').click();

    const start = win.getByTestId('knowledge-start-wiki');
    await start.waitFor({ timeout: 10_000 });
    await start.click();
    await start.waitFor({ state: 'detached', timeout: 10_000 });
    expect((await fs.stat(path.join(project, '.vocs-code', 'wiki'))).isDirectory()).toBe(true);

    // With a wiki on disk the pull seam switches on for the next session start.
    await win.getByTestId('panel-bottom-mcp').click();
    const memoryOn = win.getByTestId('builtin-vocs-memory');
    await memoryOn.waitFor({ timeout: 10_000 });
    expect(await memoryOn.innerText()).toContain('Reads .vocs-code/wiki in this project.');

    await app?.close();
    app = null;
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
