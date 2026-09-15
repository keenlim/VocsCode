/**
 * The Layer 2 store: a project wiki on disk, nothing but markdown and a couple of JSON ledgers.
 *
 * Layout, relative to a project root (`<project>/.vocs-code/wiki/`; the worktree keeps its own):
 *   any `name.md`          a page, one file per page, path = id
 *   _proposals/*.md       proposals waiting for a human decision
 *   _observations/*.jsonl durable outcomes (commit / PR / merge / session) awaiting distillation
 *   _rejected.json        claim tombstones, so an agent does not refile a rejected claim
 *   _evidence.json        how many independent sessions have seen a claim (the promotion rule)
 *
 * Repo-scope pages live in the main checkout's wiki and are shared by every worktree; branch-scope
 * pages live in the worktree's own wiki and are overlaid on top for matching sessions. Writes are
 * temp-file + rename so a crash never leaves a half-written page, and the store never touches
 * anything outside its own wiki directory.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  KNOWLEDGE_BRANCHES_DIR,
  KNOWLEDGE_DIR,
  KNOWLEDGE_OBSERVATIONS_DIR,
  KNOWLEDGE_PROPOSALS_DIR,
  branchSlug,
  claimKey,
  isKnowledgeId,
  isSameClaim,
  pathForProposal,
  parseKnowledgeDocument,
  serializeKnowledgeDocument,
  type KnowledgeEpisode,
  type KnowledgeKind,
  type KnowledgePage,
  type KnowledgePageMeta,
  type KnowledgePageScope,
  type KnowledgeScope,
  type KnowledgeSource,
  type KnowledgeStatus
} from '../../shared/knowledge';
import { ensureDir, exists, readJson } from '../util/fs';
import { excludeVocsCodeDir } from '../git';

export type { KnowledgeScope } from '../../shared/knowledge';

/** A loaded page plus where it came from, which the merged view otherwise loses. */
export interface StoredPage extends KnowledgePage {
  /** Absolute file path. */
  abs: string;
  scopeDir: string;
  mtimeMs: number;
}

interface EvidenceEntry {
  count: number;
  sessions: string[];
  firstAt: string;
  lastAt: string;
}

interface RejectedEntry {
  claim: string;
  at: string;
  by?: string;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  page: StoredPage | null;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export class KnowledgeStore {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ignored = new Set<string>();
  /** `_evidence.json` / `_rejected.json` by path, with the stat stamp they were read at. */
  private readonly ledgers = new Map<string, { stamp: string; data: Record<string, unknown> }>();

  /** The project's shared wiki; every session of the project writes and reads here. */
  repoDir(scope: KnowledgeScope): string {
    return path.join(scope.projectRoot, KNOWLEDGE_DIR);
  }

  /**
   * Branch-scope pages live *inside* the project wiki, never in a worktree: a worktree is deleted
   * with its session, and knowledge must outlive it. They are keyed by branch name and only surface
   * for a session working on that branch.
   */
  branchDir(scope: KnowledgeScope): string | null {
    if (!scope.branch) return null;
    return path.join(this.repoDir(scope), KNOWLEDGE_BRANCHES_DIR, branchSlug(scope.branch));
  }

  proposalsDir(scope: KnowledgeScope): string {
    return path.join(this.repoDir(scope), KNOWLEDGE_PROPOSALS_DIR);
  }

  observationsDir(scope: KnowledgeScope): string {
    return path.join(this.repoDir(scope), KNOWLEDGE_OBSERVATIONS_DIR);
  }

  async hasWiki(scope: KnowledgeScope): Promise<boolean> {
    return exists(this.repoDir(scope));
  }

  /**
   * Creates the project's wiki directory. Until it exists the `vocs-memory` MCP server is not
   * injected and episodes are not recorded, so a project whose docs are too thin for bootstrap
   * needs a way to opt in that does not depend on a model.
   */
  async createWiki(scope: KnowledgeScope): Promise<string> {
    const dir = this.repoDir(scope);
    await this.ensureIgnored(scope);
    await ensureDir(dir);
    return dir;
  }

  /** Repo pages, then branch pages overriding same-id entries: the merged view a session sees. */
  async load(scope: KnowledgeScope): Promise<StoredPage[]> {
    const byId = new Map<string, StoredPage>();
    for (const page of await this.walkDir(this.repoDir(scope))) byId.set(page.meta.id, page);
    const branchDir = this.branchDir(scope);
    if (branchDir) for (const page of await this.walkDir(branchDir)) byId.set(page.meta.id, page);
    return [...byId.values()];
  }

  async read(scope: KnowledgeScope, id: string): Promise<StoredPage | null> {
    if (!isKnowledgeId(id)) return null;
    const all = await this.load(scope);
    return all.find((p) => p.meta.id === id) ?? null;
  }

  /** Writes a page into the scope it names, preserving `createdAt` on an update. */
  async write(scope: KnowledgeScope, meta: KnowledgePageMeta, body: string): Promise<StoredPage> {
    if (!isKnowledgeId(meta.id)) throw new Error('Invalid knowledge page id');
    const dir = meta.scope === 'branch' ? this.branchDir(scope) : this.repoDir(scope);
    if (!dir) throw new Error('Branch-scope pages need a branch name (only worktree sessions carry one)');
    await this.ensureIgnored(scope);
    const file = path.join(dir, `${meta.id}.md`);
    if (!isInside(dir, file)) throw new Error('Knowledge page path escapes the wiki');
    const previous = await this.read(scope, meta.id);
    const now = new Date().toISOString();
    const next: KnowledgePageMeta = {
      ...meta,
      createdAt: previous?.meta.createdAt ?? meta.createdAt ?? now,
      updatedAt: now
    };
    await ensureDir(path.dirname(file));
    await writeFileAtomic(file, serializeKnowledgeDocument(next, body));
    const page: StoredPage = { meta: next, body, path: `${meta.id}.md`, abs: file, scopeDir: dir, mtimeMs: Date.now() };
    this.cache.delete(file);
    return page;
  }

  /** Applies a patch to an existing page and writes it back; null when the page is gone. */
  async patch(scope: KnowledgeScope, id: string, patch: Partial<KnowledgePageMeta>): Promise<StoredPage | null> {
    const page = await this.read(scope, id);
    if (!page) return null;
    return this.write(scope, { ...page.meta, ...patch, id: page.meta.id }, page.body);
  }

  /**
   * Removes one page from whichever scope holds it; used when a draft is discarded. The unlink must
   * actually remove a file for the scope to count as the owner — `rm({ force: true })` resolves for
   * a missing path, which on a branch session reported success before the repo wiki was ever tried.
   */
  async deletePage(scope: KnowledgeScope, id: string): Promise<boolean> {
    if (!isKnowledgeId(id)) return false;
    for (const dir of [this.branchDir(scope), this.repoDir(scope)]) {
      if (!dir) continue;
      const file = path.join(dir, `${id}.md`);
      if (!isInside(dir, file)) continue;
      try {
        await fs.unlink(file);
      } catch {
        continue; // not in this scope (or unreadable): try the next one
      }
      this.cache.delete(file);
      return true;
    }
    return false;
  }

  async proposals(scope: KnowledgeScope): Promise<KnowledgePage[]> {
    const dir = this.proposalsDir(scope);
    const out: KnowledgePage[] = [];
    for (const abs of await this.mdFiles(dir)) {
      const page = await this.readFile(abs, dir);
      if (page) out.push({ meta: page.meta, body: page.body, path: page.path });
    }
    return out.sort((a, b) => (b.meta.updatedAt ?? b.meta.createdAt ?? '').localeCompare(a.meta.updatedAt ?? a.meta.createdAt ?? ''));
  }

  async writeProposal(scope: KnowledgeScope, record: { id: string; meta: KnowledgePageMeta; body: string }): Promise<KnowledgePage> {
    const dir = this.proposalsDir(scope);
    const file = path.join(dir, `${record.id}.md`);
    if (!isKnowledgeId(record.id) || !isInside(dir, file)) throw new Error('Invalid proposal id');
    await this.ensureIgnored(scope);
    await ensureDir(dir);
    await writeFileAtomic(file, serializeKnowledgeDocument(record.meta, record.body));
    return { meta: record.meta, body: record.body, path: `${record.id}.md` };
  }

  async removeProposal(scope: KnowledgeScope, id: string): Promise<void> {
    if (!isKnowledgeId(id)) return;
    const file = path.join(this.proposalsDir(scope), `${id}.md`);
    if (isInside(this.proposalsDir(scope), file)) await fs.rm(file, { force: true });
  }

  /* ------------------------------------------------------------------ */
  /* Claim ledger: evidence + rejection memory                          */
  /* ------------------------------------------------------------------ */

  private evidenceFileFor(scope: KnowledgeScope): string {
    return path.join(this.repoDir(scope), '_evidence.json');
  }

  private rejectedFileFor(scope: KnowledgeScope): string {
    return path.join(this.repoDir(scope), '_rejected.json');
  }

  /**
   * Both ledgers are re-read whenever the file on disk changed. The `vocs-memory` MCP server is a
   * separate process writing the same two files, so a cache keyed only by path would let the app
   * overwrite an agent's evidence (or miss a tombstone it just recorded).
   */
  private async ledger<T>(file: string): Promise<Record<string, T>> {
    let stamp = 'absent';
    try {
      const stat = await fs.stat(file);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      /* no ledger written yet */
    }
    const cached = this.ledgers.get(file);
    if (cached && cached.stamp === stamp) return cached.data as Record<string, T>;
    const data = await readJson<Record<string, T>>(file, {});
    this.ledgers.set(file, { stamp, data: data as Record<string, unknown> });
    return data;
  }

  private async writeLedger(scope: KnowledgeScope, file: string, data: Record<string, unknown>): Promise<void> {
    await ensureDir(this.repoDir(scope));
    await writeFileAtomic(file, JSON.stringify(data, null, 2));
    this.ledgers.delete(file); // the next read re-stats rather than trusting our own write
  }

  /** Records one sighting of a claim; returns the number of distinct sessions that have seen it. */
  async recordEvidence(scope: KnowledgeScope, claim: string, sessionId?: string): Promise<number> {
    const file = this.evidenceFileFor(scope);
    const evidence = await this.ledger<EvidenceEntry>(file);
    const key = claimKey(claim);
    const now = new Date().toISOString();
    const entry = evidence[key] ?? { count: 0, sessions: [], firstAt: now, lastAt: now };
    const sessions = sessionId && !entry.sessions.includes(sessionId) ? [...entry.sessions, sessionId] : entry.sessions;
    const next: EvidenceEntry = { count: sessions.length, sessions, firstAt: entry.firstAt, lastAt: now };
    await this.writeLedger(scope, file, { ...evidence, [key]: next });
    return next.count;
  }

  async evidenceFor(scope: KnowledgeScope, claim: string): Promise<number> {
    return (await this.ledger<EvidenceEntry>(this.evidenceFileFor(scope)))[claimKey(claim)]?.count ?? 0;
  }

  async reject(scope: KnowledgeScope, claim: string, by?: string): Promise<void> {
    const file = this.rejectedFileFor(scope);
    const rejected = await this.ledger<RejectedEntry>(file);
    await this.writeLedger(scope, file, { ...rejected, [claimKey(claim)]: { claim, at: new Date().toISOString(), ...(by ? { by } : {}) } });
  }

  async rejectedClaims(scope: KnowledgeScope): Promise<string[]> {
    return Object.values(await this.ledger<RejectedEntry>(this.rejectedFileFor(scope))).map((r) => r.claim);
  }

  async isRejected(scope: KnowledgeScope, claim: string): Promise<boolean> {
    return !!(await this.ledger<RejectedEntry>(this.rejectedFileFor(scope)))[claimKey(claim)];
  }

  /* ------------------------------------------------------------------ */
  /* Episodes (L3 evidence waiting for distillation)                    */
  /* ------------------------------------------------------------------ */

  async appendEpisode(scope: KnowledgeScope, episode: KnowledgeEpisode): Promise<void> {
    const dir = this.observationsDir(scope);
    await this.ensureIgnored(scope);
    await ensureDir(dir);
    const file = path.join(dir, `${episode.at.slice(0, 10)}.jsonl`);
    await fs.appendFile(file, `${JSON.stringify(episode)}\n`, 'utf8');
  }

  /**
   * Newest episode first. Both orderings matter: the daily files are read newest day first, and the
   * rows *inside* a file are reversed because episodes are appended oldest-first. Distillation reads
   * `[0]` as "the most recent outcome", so getting this backwards made it reason about the first
   * commit of the day for the rest of it.
   */
  async readEpisodes(scope: KnowledgeScope, limit = 40): Promise<KnowledgeEpisode[]> {
    const dir = this.observationsDir(scope);
    if (!(await exists(dir))) return [];
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    const out: KnowledgeEpisode[] = [];
    for (const file of files) {
      const rows: KnowledgeEpisode[] = [];
      for (const row of (await fs.readFile(path.join(dir, file), 'utf8')).split('\n')) {
        if (!row.trim()) continue;
        try {
          const parsed = JSON.parse(row) as KnowledgeEpisode;
          if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') rows.push(parsed);
        } catch {
          /* a torn line is not worth failing a distillation over */
        }
      }
      rows.reverse();
      for (const episode of rows) {
        out.push(episode);
        if (out.length >= limit) return sortEpisodes(out);
      }
    }
    return sortEpisodes(out);
  }

  /* ------------------------------------------------------------------ */
  /* Staleness                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * A page is stale when a file it cites is gone, or changed after the page was written. Anchors
   * are checked the same way: an anchor file that no longer exists is the cheapest possible signal
   * that GitNexus's view of the code moved on.
   */
  async staleness(scope: KnowledgeScope, page: KnowledgePage): Promise<{ stale: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const updated = page.meta.updatedAt ? Date.parse(page.meta.updatedAt) : 0;
    const checked = new Set<string>();
    const files: string[] = [
      ...page.meta.sources.filter((s) => s.type === 'file' || s.type === 'doc').map((s) => s.ref),
      ...page.meta.anchors.map((a) => a.file)
    ];
    for (const ref of files) {
      const rel = ref.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!rel || rel.startsWith('/') || rel.includes('..') || checked.has(rel)) continue;
      checked.add(rel);
      const abs = path.join(scope.projectRoot, rel);
      try {
        const stat = await fs.stat(abs);
        if (updated && stat.mtimeMs > updated) reasons.push(`${rel} changed after this page was written`);
      } catch {
        reasons.push(`${rel} no longer exists`);
      }
    }
    return { stale: reasons.length > 0, reasons: reasons.slice(0, 5) };
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  /** First write into a project makes sure `.vocs-code/` never shows up as untracked. */
  private async ensureIgnored(scope: KnowledgeScope): Promise<void> {
    if (this.ignored.has(scope.projectRoot)) return;
    this.ignored.add(scope.projectRoot);
    try {
      await excludeVocsCodeDir(scope.projectRoot);
    } catch {
      /* not a git repo, or unreadable: the wiki still works, it is just visible to git */
    }
  }

  private async walkDir(dir: string): Promise<StoredPage[]> {
    const out: StoredPage[] = [];
    for (const abs of await this.mdFiles(dir)) {
      const page = await this.readFile(abs, dir);
      if (page) out.push(page);
    }
    return out;
  }

  /** Every .md under a wiki directory except reserved `_` subdirectories. */
  private async mdFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        // `branches` holds other branches' pages; the caller loads its own via branchDir().
        if (entry.name.startsWith('_') || entry.name.startsWith('.') || entry.name === KNOWLEDGE_BRANCHES_DIR) continue;
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(abs, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.md')) out.push(abs);
      }
    };
    await walk(dir, 0);
    return out;
  }

  /** `scopeDir` is the wiki root the file was found under, so `path` stays the id-relative one. */
  private async readFile(abs: string, scopeDir: string): Promise<StoredPage | null> {
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(abs);
    } catch {
      return null;
    }
    const cached = this.cache.get(abs);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.page;
    let page: StoredPage | null = null;
    try {
      const text = await fs.readFile(abs, 'utf8');
      const parsed = parseKnowledgeDocument(text, path.relative(scopeDir, abs).replace(/\\/g, '/'));
      if (parsed) page = { ...parsed, abs, scopeDir, mtimeMs: stat.mtimeMs };
    } catch {
      page = null;
    }
    this.cache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, page });
    return page;
  }
}

/** Newest first, by the episode's own timestamp; a torn or back-dated row cannot reorder the list. */
function sortEpisodes(episodes: KnowledgeEpisode[]): KnowledgeEpisode[] {
  return [...episodes].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

/** Serializes only the pages the caller asked for, from a summary list; shared with publish. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

/** Builds a proposal record's meta from an input, on top of the page it may edit. */
export function proposalMeta(input: {
  id: string;
  title: string;
  claim: string;
  kind?: KnowledgeKind;
  status?: KnowledgeStatus;
  scope: KnowledgePageScope;
  branch?: string;
  keywords?: string[];
  sources?: KnowledgeSource[];
  anchors?: KnowledgePageMeta['anchors'];
  related?: string[];
  supersedes?: string[];
  contradicts?: string[];
  confidence?: KnowledgePageMeta['confidence'];
  targetPageId?: string;
  base?: KnowledgePageMeta;
}): KnowledgePageMeta {
  const existing = input.base;
  const now = new Date().toISOString();
  const meta: KnowledgePageMeta = {
    id: input.id,
    title: input.title,
    kind: input.kind ?? existing?.kind ?? 'concept',
    status: input.status ?? existing?.status ?? 'proposed',
    scope: input.scope,
    keywords: [...new Set([...(input.keywords ?? []), ...(existing?.keywords ?? [])])].slice(0, 24),
    sources: dedupeSources([...(input.sources ?? []), ...(existing?.sources ?? [])]),
    anchors: dedupeAnchors([...(input.anchors ?? []), ...(existing?.anchors ?? [])]),
    related: [...new Set([...(input.related ?? []), ...(existing?.related ?? [])])],
    supersedes: input.supersedes ?? existing?.supersedes ?? [],
    contradicts: input.contradicts ?? existing?.contradicts ?? [],
    claim: input.claim,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    evidenceCount: (existing?.evidenceCount ?? 0) + 1
  };
  if (input.branch) meta.branch = input.branch;
  if (input.targetPageId) meta.targetPageId = input.targetPageId;
  if (input.confidence ?? existing?.confidence) meta.confidence = input.confidence ?? existing?.confidence;
  if (input.supersedes?.length) meta.supersededBy = existing?.supersededBy;
  if (existing?.supersededBy && !input.supersedes?.length) meta.supersededBy = existing.supersededBy;
  return meta;
}

function dedupeSources(sources: KnowledgeSource[]): KnowledgeSource[] {
  const seen = new Set<string>();
  const out: KnowledgeSource[] = [];
  for (const s of sources) {
    const key = `${s.type}\u0000${s.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.slice(0, 40);
}

function dedupeAnchors(anchors: KnowledgePageMeta['anchors']): KnowledgePageMeta['anchors'] {
  const seen = new Set<string>();
  const out: KnowledgePageMeta['anchors'] = [];
  for (const a of anchors) {
    const key = `${a.file}\u0000${a.symbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out.slice(0, 40);
}

export { isSameClaim, pathForProposal, claimKey };
