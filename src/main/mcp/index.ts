/**
 * Ties the two MCP stores together: what a session actually gets, and what the two UI surfaces
 * need to show. The one place that knows about settings, the repo file and the secret store at
 * the same time; adapters only ever see the resolved list through `ctx.mcpServers()`.
 */
import type { AppSettings, HarnessId, McpBuiltinInfo, McpProjectInfo, McpProjectState, McpServerDef } from '../../shared/types';
import { HARNESS_BY_ID } from '../../shared/harness-meta';
import { which } from '../runtime';
import { builtinEntries, effectiveEntries, effectiveServers, normalizeStdio, resolveVars, type ResolvedServer } from './effective';
import { globalStores, projectStores, readProjectMcp, readStores } from './file';
import { GITNEXUS_SERVER_ID, gitnexusBaseDef, gitnexusSharedRoots, isBuiltinServerId, isGitnexusIndexed, readGitnexusRegistry, realGitnexusHome, visibleGitnexusEntries } from './gitnexus';

export * from './effective';
export * from './file';
export * from './gitnexus';
export { inspectServer, type InspectOptions } from './client';

/** Keychain id for a variable referenced as `${NAME}` in an MCP definition. */
export function secretKeyFor(varName: string): string {
  return `mcp:${varName}`;
}

export interface McpHostDeps {
  getSecret: (id: string) => Promise<string | undefined>;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** The shared GitNexus MCP endpoint, started lazily. Null when unavailable. */
  sharedGitnexus?: () => Promise<string | null>;
  /** Path to the scope proxy the harness spawns in place of the GitNexus binary. */
  gitnexusProxyPath?: string;
}

export interface SessionScope {
  settings: AppSettings;
  /** Where the session runs; a worktree has its own checkout of the repo file. */
  cwd: string;
  /** The key the per-repo switches are stored under, shared with the main checkout. */
  projectRoot: string;
  harness: HarnessId;
}

function stateFor(settings: AppSettings, projectRoot: string): McpProjectState {
  return settings.mcpProjectState?.[projectRoot] ?? {};
}

/** The app-shipped built-in servers, with the installed binary preferred over `npx`. */
function builtinDefs(): McpServerDef[] {
  return [gitnexusBaseDef(which(GITNEXUS_SERVER_ID))];
}

/**
 * The harness spawns the scope proxy, which talks to the one shared server and pins every call to
 * the repos this session is allowed to see. Null when the repo is not indexed or the shared server
 * cannot start, so we inject nothing rather than a broken server.
 */
async function sharedGitnexusDef(scope: SessionScope, def: McpServerDef, deps: McpHostDeps): Promise<McpServerDef | null> {
  if (!deps.sharedGitnexus || !deps.gitnexusProxyPath) return null;
  const registry = await readGitnexusRegistry(realGitnexusHome());
  if (!isGitnexusIndexed(registry, { projectRoot: scope.projectRoot, cwd: scope.cwd })) return null;
  const allow = visibleGitnexusEntries(registry, { projectRoot: scope.projectRoot, cwd: scope.cwd, sharedRoots: gitnexusSharedRoots(scope.settings) }).map((e) => ({ name: e.name, path: e.path }));
  const url = await deps.sharedGitnexus();
  if (!url) return null;
  const node = which('node');
  return {
    ...def,
    transport: 'stdio',
    command: node ?? process.execPath,
    args: [deps.gitnexusProxyPath],
    env: {
      ...(node ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
      VOCS_GITNEXUS_URL: url,
      VOCS_GITNEXUS_PRIMARY: scope.projectRoot,
      VOCS_GITNEXUS_ALLOW: JSON.stringify(allow)
    }
  };
}

/** Built-ins the session actually gets, materialized against the shared server. */
async function resolveBuiltins(scope: SessionScope, state: McpProjectState, deps: McpHostDeps): Promise<ResolvedServer[]> {
  const support = HARNESS_BY_ID[scope.harness].capabilities.mcp;
  const defs = builtinDefs();
  const chosen = builtinEntries({ builtin: defs, state, harness: scope.harness, support }).filter((e) => e.enabled);
  const out: ResolvedServer[] = [];
  for (const { def } of chosen) {
    let materialized: McpServerDef | null = def;
    if (def.id === GITNEXUS_SERVER_ID) {
      materialized = await sharedGitnexusDef(scope, def, deps);
      if (!materialized) continue;
    }
    const resolved = await resolveVars(materialized, { env: process.env, secret: (name) => deps.getSecret(secretKeyFor(name)) });
    if (resolved.missing.length) deps.log?.('warn', `mcp ${def.id}: no value for ${resolved.missing.join(', ')}`);
    out.push({ ...resolved, def: normalizeStdio(resolved.def, { which: (cmd) => which(cmd) }) });
  }
  return out;
}

/**
 * The servers one session should be started with: merged, switched, `${VAR}`-resolved and with
 * stdio commands normalized for the platform.
 */
export async function resolveForSession(scope: SessionScope, deps: McpHostDeps): Promise<ResolvedServer[]> {
  const support = HARNESS_BY_ID[scope.harness].capabilities.mcp;
  if (support !== 'inject' && support !== 'client') return [];
  const state = stateFor(scope.settings, scope.projectRoot);
  const globals = (scope.settings.mcpServers ?? []).filter((d) => !isBuiltinServerId(d.id));
  const repo = await readProjectMcp(scope.cwd);
  const repoDefs = repo.servers.filter((d) => !isBuiltinServerId(d.id));
  const chosen = effectiveServers({ global: globals, repo: repoDefs, state, harness: scope.harness, support, builtin: builtinDefs() });
  if (repo.error) deps.log?.('warn', `mcp: ${repo.file} could not be used: ${repo.error}`);
  const out: ResolvedServer[] = await resolveBuiltins(scope, state, deps);
  for (const def of chosen) {
    const resolved = await resolveVars(def, { env: process.env, secret: (name) => deps.getSecret(secretKeyFor(name)) });
    if (resolved.missing.length) deps.log?.('warn', `mcp ${def.id}: no value for ${resolved.missing.join(', ')}`);
    out.push({ ...resolved, def: normalizeStdio(resolved.def, { which: (cmd) => which(cmd) }) });
  }
  if (out.length) deps.log?.('debug', `mcp: ${out.length} server(s) for ${scope.harness} (${support}): ${out.map((r) => r.def.id).join(', ')}`);
  return out;
}

/** Everything the right-panel tab renders for one session. */
export async function projectInfo(scope: SessionScope): Promise<McpProjectInfo> {
  const support = HARNESS_BY_ID[scope.harness].capabilities.mcp;
  const globals = (scope.settings.mcpServers ?? []).filter((d) => !isBuiltinServerId(d.id));
  const repo = await readProjectMcp(scope.cwd);
  const repoDefs = repo.servers.filter((d) => !isBuiltinServerId(d.id));
  const state = stateFor(scope.settings, scope.projectRoot);
  const detected = (await readStores(projectStores(scope.cwd))).filter((s) => s.exists);
  const defs = builtinDefs();
  const injectable = support === 'inject' || support === 'client';
  const registry = await readGitnexusRegistry(realGitnexusHome());
  const indexed = isGitnexusIndexed(registry, { projectRoot: scope.projectRoot, cwd: scope.cwd });
  const builtin: McpBuiltinInfo[] = defs.map((def) => ({
    def,
    // The one shared server is on by default; this switch keeps a repo out of it.
    enabled: injectable && !(state.disabledBuiltin ?? []).includes(def.id),
    shared: state.gitnexusGlobal === true,
    indexed
  }));
  return {
    projectRoot: scope.projectRoot,
    file: repo.file,
    display: repo.file.replace(/\\/g, '/'),
    exists: repo.exists,
    repo: repoDefs,
    error: repo.error,
    global: globals,
    state,
    builtin,
    detected,
    effective: [
      ...builtinEntries({ builtin: defs, state, harness: scope.harness, support }),
      ...effectiveEntries({ global: globals, repo: repoDefs, state, harness: scope.harness, support, builtin: defs })
    ],
    harness: scope.harness,
    support
  };
}

/** The harness-native global stores, for the MCP page's read-only tabs. */
export async function globalStoreInfo() {
  return readStores(globalStores());
}

/** Merges `servers` into a list by id, replacing same-id entries. */
export function mergeById(into: McpServerDef[], servers: McpServerDef[]): McpServerDef[] {
  const out = into.slice();
  for (const s of servers) {
    const at = out.findIndex((x) => x.id === s.id);
    if (at >= 0) out[at] = s;
    else out.push(s);
  }
  return out;
}
