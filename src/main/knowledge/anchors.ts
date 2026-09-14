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
  now?: () => number;
}

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
        let client: ConnectedMcpServer | null = null;
        try {
          client = await connectServer({ id: 'gitnexus', transport: 'http', url });
          for (const anchor of pending) {
            const result = await client.call('context', { repo, name: anchor.symbol, file: anchor.file }, { timeoutMs: 10_000 });
            const value = parseContextReply(result.output, anchor);
            resolved.set(anchorKey(anchor), value);
            cache.set(cacheKey(repo, anchor), { at: now, value });
          }
        } catch (e) {
          deps.log('warn', `knowledge: anchor resolution failed: ${errorMessage(e)}`);
          for (const anchor of pending) {
            if (!resolved.has(anchorKey(anchor))) resolved.set(anchorKey(anchor), { ...anchor, status: 'unavailable', note: 'GitNexus did not answer.' });
          }
        } finally {
          await client?.close();
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
