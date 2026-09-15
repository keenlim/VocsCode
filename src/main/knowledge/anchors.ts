/**
 * Live anchor resolution: a wiki page names a file and a symbol, and GitNexus says whether that
 * symbol still exists and where it moved to. Pages never store structure — this is how a pointer
 * becomes checkable without copying any.
 *
 * The app talks to the one shared GitNexus server directly (not through the session scope proxy),
 * so it passes the repo name explicitly, exactly as the proxy does for a harness. A project that is
 * not indexed, a server that is not running, and a call that fails all resolve to `unavailable`
 * rather than an error: the panel must render a page whose anchors cannot be checked.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { KnowledgeAnchor, KnowledgeAnchorResolution, KnowledgeScope } from '../../shared/knowledge';
import { connectServer, type ConnectedMcpServer } from '../mcp/client';
import { errorMessage } from '../util/async';
import { parseLeadingJson } from '../util/json';

export interface AnchorResolver {
  /** One resolution per anchor, in the same order; never throws. */
  resolve(scope: KnowledgeScope, anchors: KnowledgeAnchor[]): Promise<KnowledgeAnchorResolution[]>;
}

export interface GitnexusAnchorDeps {
  /** The shared GitNexus endpoint, started lazily; null when it cannot start. */
  url: () => Promise<string | null>;
  /** The registry name of the index covering this project, or null when it is not indexed. */
  repoName: (scope: KnowledgeScope) => Promise<string | null>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** How long a resolution stays fresh. Default 5 minutes. */
  ttlMs?: number;
  /** Total wall-clock budget for one `resolve()` call, however many anchors it covers. Default 8s. */
  budgetMs?: number;
  now?: () => number;
}

/** How many `context` calls are in flight at once; a wiki page names a handful of symbols. */
const ANCHOR_CONCURRENCY = 4;

interface ContextReply {
  status?: string;
  error?: string;
  symbol?: { uid?: string; name?: string; filePath?: string; startLine?: number; endLine?: number };
}

const anchorKey = (a: KnowledgeAnchor): string => `${a.file}\u0000${a.symbol ?? ''}`;
const cacheKey = (repo: string, a: KnowledgeAnchor): string => `${repo}\u0000${a.file}\u0000${a.symbol ?? ''}`;

/** Reads the leading JSON object GitNexus prints, tolerating the advice line it appends. */
export function parseContextReply(text: string, anchor: KnowledgeAnchor): KnowledgeAnchorResolution {
  const parsed = parseLeadingJson<ContextReply>(text);
  if (!parsed) return { ...anchor, status: 'unresolved', note: 'GitNexus returned no symbol data.' };
  if (parsed.error || parsed.status !== 'found' || !parsed.symbol) {
    return { ...anchor, status: 'unresolved', note: parsed.error ?? 'Not in GitNexus\u2019 index.' };
  }
  const symbol = parsed.symbol;
  const normalize = (p: string) => p.replace(/\\/g, '/');
  const moved = !!symbol.filePath && normalize(symbol.filePath) !== normalize(anchor.file);
  const lines = typeof symbol.startLine === 'number' && typeof symbol.endLine === 'number' ? { start: symbol.startLine, end: symbol.endLine } : undefined;
  return {
    ...anchor,
    status: 'resolved',
    ...(symbol.filePath ? { foundFile: symbol.filePath } : {}),
    ...(symbol.name ? { foundName: symbol.name } : {}),
    ...(symbol.uid ? { uid: symbol.uid } : {}),
    ...(lines ? { lines } : {}),
    ...(moved ? { note: `Now in ${symbol.filePath}.` } : {})
  };
}

export function createGitnexusAnchorResolver(deps: GitnexusAnchorDeps): AnchorResolver {
  const cache = new Map<string, { at: number; value: KnowledgeAnchorResolution }>();

  return {
    async resolve(scope, anchors) {
      if (!anchors.length) return [];
      // Ask the registry first: an unindexed project must not start the GitNexus server at all (on a
      // machine without the binary that is a slow npx attempt the panel would visibly wait on).
      const repo = await deps.repoName(scope);
      if (!repo) return anchors.map((a) => ({ ...a, status: 'unavailable' as const, note: 'This project is not indexed by GitNexus.' }));
      const url = await deps.url();
      if (!url) return anchors.map((a) => ({ ...a, status: 'unavailable' as const, note: 'GitNexus is not running.' }));

      const now = (deps.now ?? Date.now)();
      const ttl = deps.ttlMs ?? 300_000;
      const resolved = new Map<string, KnowledgeAnchorResolution>();
      const pending: KnowledgeAnchor[] = [];
      for (const anchor of anchors) {
        if (!anchor.symbol) continue;
        const hit = cache.get(cacheKey(repo, anchor));
        if (hit && now - hit.at < ttl) resolved.set(anchorKey(anchor), hit.value);
        else pending.push(anchor);
      }

      if (pending.length) {
        // One overall deadline, not one per anchor: a page naming a dozen symbols against a wedged
        // server used to hold the detail view for minutes, since every call had its own 10s budget.
        const deadline = Date.now() + (deps.budgetMs ?? 8_000);
        const queue = [...pending];
        let client: ConnectedMcpServer | null = null;
        try {
          // The connect is inside the budget too; a hanging handshake is the slowest failure here.
          client = await connectServer({ id: 'gitnexus', transport: 'http', url }, { timeoutMs: Math.max(500, deadline - Date.now()) });
          const worker = async (): Promise<void> => {
            for (;;) {
              const anchor = queue.shift();
              if (!anchor) return;
              const left = deadline - Date.now();
              if (left <= 0) return; // the fallback below answers whatever is left
              const result = await client!.call('context', { repo, name: anchor.symbol, file: anchor.file }, { timeoutMs: Math.min(10_000, left) });
              const value = parseContextReply(result.output, anchor);
              resolved.set(anchorKey(anchor), value);
              cache.set(cacheKey(repo, anchor), { at: now, value });
            }
          };
          await Promise.all(Array.from({ length: Math.min(ANCHOR_CONCURRENCY, queue.length) }, worker));
        } catch (e) {
          deps.log('warn', `knowledge: anchor resolution failed: ${errorMessage(e)}`);
        } finally {
          await client?.close();
        }
        // Anything the budget or a failure left over is reported as unchecked, never cached.
        for (const anchor of pending) {
          if (!resolved.has(anchorKey(anchor))) resolved.set(anchorKey(anchor), { ...anchor, status: 'unavailable', note: 'GitNexus did not answer in time.' });
        }
      }

      // A file-only anchor has no symbol to look up; presence on disk is the honest answer.
      for (const anchor of anchors) {
        if (anchor.symbol || resolved.has(anchorKey(anchor))) continue;
        const exists = await fs
          .stat(path.join(scope.projectRoot, anchor.file))
          .then(() => true)
          .catch(() => false);
        resolved.set(anchorKey(anchor), { ...anchor, status: exists ? 'resolved' : 'unresolved', ...(exists ? {} : { note: 'File not found.' }) });
      }

      return anchors.map((a) => resolved.get(anchorKey(a)) ?? { ...a, status: 'unavailable' as const, note: 'Not checked.' });
    }
  };
}
