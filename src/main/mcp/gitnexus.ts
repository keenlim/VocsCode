/**
 * GitNexus ships with Vocs Code as a built-in MCP server, scoped strictly to the session's repo.
 *
 * GitNexus keeps every index in one global registry (`~/.gitnexus/registry.json`) and its `mcp`
 * command serves all of them, so isolation is ours to build: for each session we write a private
 * `GITNEXUS_HOME` whose registry contains only the session repo — plus any repo the user has
 * promoted to global scope (`mcpProjectState[root].gitnexusGlobal`). A repo-scoped session can
 * then never reach another repo's graph. No Electron imports.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings, McpServerDef } from '../../shared/types';

export const GITNEXUS_SERVER_ID = 'gitnexus';

/** The one built-in server today; the id list is the shadow/exclusion key everywhere else. */
export function isBuiltinServerId(id: string): boolean {
  return id === GITNEXUS_SERVER_ID;
}

/** The built-in definition, before the per-session env is attached. */
export function gitnexusBaseDef(installedPath?: string | null): McpServerDef {
  return installedPath
    ? { id: GITNEXUS_SERVER_ID, transport: 'stdio', command: installedPath, args: ['mcp'], description: 'GitNexus code knowledge graph' }
    : { id: GITNEXUS_SERVER_ID, transport: 'stdio', command: 'npx', args: ['-y', 'gitnexus@latest', 'mcp'], description: 'GitNexus code knowledge graph' };
}

/** Where the per-project GitNexus homes live, inside the app's userData directory. */
export function gitnexusHomeBase(userData: string): string {
  return path.join(userData, 'gitnexus-homes');
}

/** GitNexus's own home resolution: `GITNEXUS_HOME`, else `~/.gitnexus`. */
export function realGitnexusHome(env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): string {
  return env.GITNEXUS_HOME || path.join(homedir, '.gitnexus');
}

/** One entry of GitNexus's global registry. */
export interface GitnexusRegistryEntry {
  name: string;
  path: string;
  [key: string]: unknown;
}

function normalize(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Reads `~/.gitnexus/registry.json`; a missing or malformed file yields no entries. */
export async function readGitnexusRegistry(realHome: string): Promise<GitnexusRegistryEntry[]> {
  try {
    const raw = await fs.readFile(path.join(realHome, 'registry.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is GitnexusRegistryEntry => !!e && typeof e === 'object' && typeof (e as { path?: unknown }).path === 'string' && typeof (e as { name?: unknown }).name === 'string');
  } catch {
    return [];
  }
}

/** Project roots the user has promoted to global scope. */
export function gitnexusSharedRoots(settings: AppSettings): string[] {
  const state = settings.mcpProjectState ?? {};
  return Object.entries(state)
    .filter(([, v]) => v?.gitnexusGlobal === true)
    .map(([root]) => root);
}

/** The registry entries a session in `projectRoot` / `cwd` may see, and nothing else. */
export function visibleGitnexusEntries(
  entries: GitnexusRegistryEntry[],
  opts: { projectRoot: string; cwd: string; sharedRoots: string[] }
): GitnexusRegistryEntry[] {
  const wanted = new Set<string>([normalize(opts.projectRoot), normalize(opts.cwd), ...opts.sharedRoots.map(normalize)]);
  return entries.filter((e) => wanted.has(normalize(e.path)));
}

/** Whether the session repo (or its worktree) has an index GitNexus can serve. */
export function isGitnexusIndexed(entries: GitnexusRegistryEntry[], opts: { projectRoot: string; cwd: string }): boolean {
  return visibleGitnexusEntries(entries, { ...opts, sharedRoots: [] }).length > 0;
}

/**
 * Writes the session's private GitNexus home and returns its path. The directory always exists
 * after this resolves, even with an empty registry, so the MCP server starts deterministically.
 */
export async function prepareGitnexusHome(opts: {
  baseDir: string;
  projectRoot: string;
  cwd: string;
  settings: AppSettings;
  realHome?: string;
}): Promise<string> {
  const home = path.join(opts.baseDir, createHash('sha1').update(normalize(opts.projectRoot)).digest('hex').slice(0, 16));
  const entries = await readGitnexusRegistry(opts.realHome ?? realGitnexusHome());
  const visible = visibleGitnexusEntries(entries, { projectRoot: opts.projectRoot, cwd: opts.cwd, sharedRoots: gitnexusSharedRoots(opts.settings) });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'registry.json'), JSON.stringify(visible, null, 2) + '\n', 'utf8');
  return home;
}
