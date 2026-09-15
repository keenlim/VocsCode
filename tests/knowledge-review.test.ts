/**
 * Review, discard, publish and episode ordering — exercised from a *worktree* session, which is the
 * app's default and the shape the earlier suites never used. Both the scope-fallthrough discard bug
 * and the publish target only appear when `cwd !== projectRoot` and the session carries a branch.
 */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { KnowledgeService } from '../src/main/knowledge/service';
import { claimKey } from '../src/shared/knowledge';
import type { AppSettings } from '../src/shared/types';
import type { KnowledgePageMeta, KnowledgeScope } from '../src/shared/knowledge';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

function tmpDir(prefix: string): string {
  const d = fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function service(): KnowledgeService {
  const settings = { knowledge: { prime: true, autoDistill: false } } as AppSettings;
  return new KnowledgeService({ log: () => undefined, settings: () => settings });
}

function pageMeta(over: Partial<KnowledgePageMeta> = {}): KnowledgePageMeta {
  return {
    id: 'conventions/harness-lifecycle',
    title: 'Harness lifecycle',
    kind: 'convention',
    status: 'current',
    scope: 'repo',
    keywords: ['harness', 'session'],
    sources: [],
    anchors: [],
    related: [],
    supersedes: [],
    contradicts: [],
    ...over
  };
}

/** Every worktree session carries a branch; worktrees are the app's default for new sessions. */
function worktree(): { projectRoot: string; scope: KnowledgeScope } {
  const projectRoot = tmpDir('vocs-kr-');
  const cwd = path.join(projectRoot, '.vocs-code', 'worktrees', 'feature');
  fsSync.mkdirSync(cwd, { recursive: true });
  return { projectRoot, scope: { projectRoot, cwd, branch: 'vocscode/feature' } };
}

describe('discard and publish from a worktree session', () => {
  it('removes a repo-scope page instead of reporting a phantom success on the branch wiki', async () => {
    const { projectRoot, scope } = worktree();
    const svc = service();
    await svc.store.write(scope, pageMeta({ id: 'gotcha/throwaway', title: 'Throwaway', status: 'draft', claim: 'A throwaway claim.' }), 'body');
    const file = path.join(projectRoot, '.vocs-code', 'wiki', 'gotcha', 'throwaway.md');
    expect(fsSync.existsSync(file)).toBe(true);

    // The branch slice is tried first and holds nothing; the repo wiki must still be reached.
    expect(await svc.store.deletePage(scope, 'gotcha/throwaway')).toBe(true);
    expect(fsSync.existsSync(file)).toBe(false);
    expect(await svc.store.deletePage(scope, 'gotcha/throwaway')).toBe(false);
  });

  it('discards through review and tombstones the claim', async () => {
    const { projectRoot, scope } = worktree();
    const svc = service();
    await svc.store.write(scope, pageMeta({ id: 'gotcha/throwaway', title: 'Throwaway', status: 'draft', claim: 'A throwaway claim.' }), 'body');

    expect(await svc.review(scope, 'gotcha/throwaway', 'reject', { by: 'human' })).toBeNull();
    expect(fsSync.existsSync(path.join(projectRoot, '.vocs-code', 'wiki', 'gotcha', 'throwaway.md'))).toBe(false);
    expect(await svc.store.read(scope, 'gotcha/throwaway')).toBeNull();
    expect(await svc.store.rejectedClaims(scope)).toContain('A throwaway claim.');
  });

  it('never tombstones a claim whose page could not be removed', async () => {
    const { scope } = worktree();
    const svc = service();
    await svc.store.write(scope, pageMeta({ id: 'gotcha/stubborn', title: 'Stubborn', status: 'draft', claim: 'A stubborn claim.' }), 'body');
    svc.store.deletePage = async () => false;

    await expect(svc.review(scope, 'gotcha/stubborn', 'reject', { by: 'human' })).rejects.toThrow('Could not discard');
    // A claim refused while its page is still served would be the worst of both worlds.
    expect(await svc.store.rejectedClaims(scope)).not.toContain('A stubborn claim.');
  });

  it('publishes into the session checkout, not the main one', async () => {
    const { projectRoot, scope } = worktree();
    const svc = service();
    await svc.store.write(scope, pageMeta(), 'body text');
    const result = await svc.publish(scope, ['conventions/harness-lifecycle']);

    expect(result.ok).toBe(true);
    expect(result.written).toEqual(['docs/wiki/conventions/harness-lifecycle.md']);
    expect(fsSync.existsSync(path.join(scope.cwd, 'docs', 'wiki', 'conventions', 'harness-lifecycle.md'))).toBe(true);
    // Untracked files in the main checkout, on whatever branch it is on, are not ours to create.
    expect(fsSync.existsSync(path.join(projectRoot, 'docs', 'wiki', 'conventions', 'harness-lifecycle.md'))).toBe(false);
  });
});

describe('episodes, previews and pending statuses', () => {
  it('reads episodes newest first, including several within one day', async () => {
    const projectRoot = tmpDir('vocs-kr-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    await svc.store.write(scope, pageMeta(), 'body');
    // One daily .jsonl appended oldest first — the shape a day of commits produces.
    await svc.store.appendEpisode(scope, { kind: 'commit', sessionId: 's_first', at: '2026-09-15T01:00:00.000Z', summary: 'first commit of the day' });
    await svc.store.appendEpisode(scope, { kind: 'commit', sessionId: 's_second', at: '2026-09-15T05:00:00.000Z', summary: 'second commit' });
    await svc.store.appendEpisode(scope, { kind: 'merge', sessionId: 's_third', at: '2026-09-15T09:00:00.000Z', summary: 'merged it' });
    await svc.store.appendEpisode(scope, { kind: 'commit', sessionId: 's_old', at: '2026-09-14T09:00:00.000Z', summary: 'yesterday' });

    const episodes = await svc.store.readEpisodes(scope);
    expect(episodes.map((e) => e.sessionId)).toEqual(['s_third', 's_second', 's_first', 's_old']);
    // Distillation reads [0] as "the most recent outcome" and attributes its proposals to it.
    expect(episodes[0].summary).toBe('merged it');
  });

  it('previews a queued proposal, which lives outside the page tree', async () => {
    const projectRoot = tmpDir('vocs-kr-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    const filed = await svc.propose(scope, { title: 'Queue me', claim: 'Proposals are previewable.', body: '## Why\n\nA human reviews it first.' }, 'agent:mcp', 's1');

    const detail = await svc.detail(scope, filed.id);
    expect(detail?.page.meta.title).toBe('Queue me');
    expect(detail?.page.body).toContain('A human reviews it first');
    expect(await svc.detail(scope, 'nothing/here')).toBeNull();
  });

  it('leaves an uncertain page alone when accepting everything', async () => {
    const projectRoot = tmpDir('vocs-kr-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    await svc.store.write(scope, pageMeta({ id: 'conventions/maybe', title: 'Maybe', status: 'uncertain', claim: 'We are not sure about this.' }), 'body');
    await svc.store.write(scope, pageMeta({ id: 'conventions/draft', title: 'Draft', status: 'draft', claim: 'A draft claim.' }), 'body');

    const result = await svc.acceptAll(scope, { by: 'human' });
    expect(result.accepted).toBe(1);
    const after = await svc.view(scope);
    // `uncertain` is a recorded judgement about the claim, not an unreviewed candidate.
    expect(after.pages.find((p) => p.id === 'conventions/maybe')?.status).toBe('uncertain');
    expect(after.pages.find((p) => p.id === 'conventions/draft')?.status).toBe('current');
  });

  it('creates a wiki for a project with no docs and no utility model', async () => {
    const projectRoot = tmpDir('vocs-kr-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    expect((await svc.view(scope)).status.hasWiki).toBe(false);

    const view = await svc.createWiki(scope);
    expect(view.status.hasWiki).toBe(true);
    expect(fsSync.existsSync(path.join(projectRoot, '.vocs-code', 'wiki'))).toBe(true);
    // Episodes only record for a project that has a wiki, so this switches L3 capture on too.
    await svc.recordEpisode(scope, { kind: 'commit', sessionId: 's1', at: new Date().toISOString(), summary: 'First commit' });
    expect(await svc.store.readEpisodes(scope)).toHaveLength(1);
  });

  it('re-reads the claim ledgers when another process writes them', async () => {
    const projectRoot = tmpDir('vocs-kr-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const svc = service();
    await svc.store.write(scope, pageMeta(), 'body');
    expect(await svc.store.isRejected(scope, 'Written by the MCP server.')).toBe(false);

    // vocs-memory is a separate process writing these same two files.
    const wiki = path.join(projectRoot, '.vocs-code', 'wiki');
    const tombstone = { [claimKey('Written by the MCP server.')]: { claim: 'Written by the MCP server.', at: new Date().toISOString() } };
    await fs.writeFile(path.join(wiki, '_rejected.json'), JSON.stringify(tombstone), 'utf8');
    expect(await svc.store.isRejected(scope, 'Written by the MCP server.')).toBe(true);
  });
});
