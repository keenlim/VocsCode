/**
 * Ties the two MCP stores together: what a session actually gets, and what the two UI surfaces
 * need to show. The one place that knows about settings, the repo file and the secret store at
 * the same time; adapters only ever see the resolved list through `ctx.mcpServers()`.
 */
import type { AppSettings, HarnessId, McpBuiltinInfo, McpProjectInfo, McpProjectState, McpServerDef } from '../../shared/types';
import os from 'node:os';
import path from 'node:path';
import { HARNESS_BY_ID } from '../../shared/harness-meta';
import { which } from '../runtime';
import { builtinEntries, effectiveEntries, effectiveServers, normalizeStdio, resolveVars, type ResolvedServer } from './effective';
import { globalStores, projectStores, readProjectMcp, readStores } from './file';
import { GITNEXUS_SERVER_ID, gitnexusBaseDef, isBuiltinServerId, isGitnexusIndexed, prepareGitnexusHome, readGitnexusRegistry, realGitnexusHome } from './gitnexus';

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
}

export interface SessionScope {
  settings: AppSettings;
  /** Where the session runs; a worktree has its own checkout of the repo file. */
  cwd: string;
  /** The key the per-repo switches are stored under, shared with the main checkout. */
  projectRoot: string;
  harness: HarnessId;
  /** Where per-project GitNexus homes are written (the app's userData dir). */
  gitnexusHomeBase?: string;
}

function stateFor(settings: AppSettings, projectRoot: string): McpProjectState {
  return settings.mcpProjectState?.[projectRoot] ?? {};
}

/** The app-shipped built-in servers, with the installed binary preferred over `npx`. */
function builtinDefs(): McpServerDef[] {
  return [gitnexusBaseDef(which(GITNEXUS_SERVER_ID))];
}

/** Built-ins the session actually gets, with the per-repo GitNexus home attached. */
async function resolveBuiltins(scope: SessionScope, state: McpProjectState, deps: McpHostDeps): Promise<ResolvedServer[]> {
  const support = HARNESS_BY_ID[scope.harness].capabilities.mcp;
  const defs = builtinDefs();
  const chosen = builtinEntries({ builtin: defs, state, harness: scope.harness, support }).filter((e) => e.enabled);
  const out: ResolvedServer[] = [];
  for (const { def } of chosen) {
    let materialized = def;
    if (def.id === GITNEXUS_SERVER_ID) {
      const base = scope.gitnexusHomeBase ?? path.join(os.tmpdir(), 'vocs-code-gitnexus-homes');
      const home = await prepareGitnexusHome({ baseDir: base, projectRoot: scope.projectRoot, cwd: scope.cwd, settings: scope.settings });
      materialized = { ...def, env: { ...(def.env ?? {}), GITNEXUS_HOME: home } };
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
