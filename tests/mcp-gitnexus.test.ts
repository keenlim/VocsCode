import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppSettings, McpServerDef } from '../src/shared/types';
import { builtinEntries, effectiveEntries, effectiveServers } from '../src/main/mcp/effective';
import {
  GITNEXUS_SERVER_ID,
  gitnexusBaseDef,
  gitnexusSharedRoots,
  isBuiltinServerId,
  isGitnexusIndexed,
  prepareGitnexusHome,
  readGitnexusRegistry,
  realGitnexusHome,
  visibleGitnexusEntries
} from '../src/main/mcp/gitnexus';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const entry = (name: string, p: string) => ({ name, path: p, storagePath: path.join(p, '.gitnexus') });

describe('GitNexus registry reading', () => {
  it('treats a missing or malformed registry as empty', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gn-'));
    dirs.push(dir);
    expect(await readGitnexusRegistry(dir)).toEqual([]);
    await writeFile(path.join(dir, 'registry.json'), '{ not json', 'utf8');
    expect(await readGitnexusRegistry(dir)).toEqual([]);
    await writeFile(path.join(dir, 'registry.json'), '{"not":"an array"}', 'utf8');
    expect(await readGitnexusRegistry(dir)).toEqual([]);
  });

  it('honours GITNEXUS_HOME over the default home', () => {
    expect(realGitnexusHome({ GITNEXUS_HOME: '/custom/gn' } as NodeJS.ProcessEnv, '/home/u')).toBe('/custom/gn');
    expect(realGitnexusHome({} as NodeJS.ProcessEnv, '/home/u')).toBe(path.join('/home/u', '.gitnexus'));
  });
});

describe('GitNexus visibility is strict', () => {
  const entries = [entry('Y', 'G:/work/y'), entry('X', 'G:/work/x'), entry('Z', 'D:/other/z')];

  it('shows only the session repo when nothing is shared', () => {
    const visible = visibleGitnexusEntries(entries, { projectRoot: 'G:/work/y', cwd: 'G:/work/y', sharedRoots: [] });
    expect(visible.map((e) => e.name)).toEqual(['Y']);
  });

  it('shows a shared repo alongside the session repo, and nothing else', () => {
    const visible = visibleGitnexusEntries(entries, { projectRoot: 'G:/work/y', cwd: 'G:/work/y', sharedRoots: ['G:/work/x'] });
    expect(visible.map((e) => e.name).sort()).toEqual(['X', 'Y']);
  });

  it('matches a worktree cwd to its own index without leaking others', () => {
    const visible = visibleGitnexusEntries(entries, { projectRoot: 'G:/work/y', cwd: 'G:/work/y/.vocs-code/worktrees/wt', sharedRoots: [] });
    expect(visible.map((e) => e.name)).toEqual(['Y']);
  });

  it('normalises separators and case so Windows paths match', () => {
    const visible = visibleGitnexusEntries(entries, { projectRoot: 'g:\\work\\Y', cwd: 'g:/work/y/', sharedRoots: [] });
    expect(visible.map((e) => e.name)).toEqual(['Y']);
  });

  it('reports indexed only for the session repo', () => {
    expect(isGitnexusIndexed(entries, { projectRoot: 'G:/work/y', cwd: 'G:/work/y' })).toBe(true);
    expect(isGitnexusIndexed(entries, { projectRoot: 'G:/work/missing', cwd: 'G:/work/missing' })).toBe(false);
  });
});

describe('per-project GitNexus home', () => {
  it('writes a filtered registry and stays stable per project', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'gn-base-'));
    const real = await mkdtemp(path.join(tmpdir(), 'gn-real-'));
    dirs.push(base, real);
    await mkdir(real, { recursive: true });
    await writeFile(path.join(real, 'registry.json'), JSON.stringify([entry('Y', 'G:/work/y'), entry('X', 'G:/work/x'), entry('Z', 'D:/other/z')]), 'utf8');

    const settings = { mcpProjectState: { 'G:/work/x': { gitnexusGlobal: true } } } as unknown as AppSettings;
    const home = await prepareGitnexusHome({ baseDir: base, projectRoot: 'G:/work/y', cwd: 'G:/work/y', settings, realHome: real });
    const home2 = await prepareGitnexusHome({ baseDir: base, projectRoot: 'G:/work/y', cwd: 'G:/work/y', settings, realHome: real });
    expect(home2).toBe(home);

    const written = JSON.parse(await readFile(path.join(home, 'registry.json'), 'utf8')) as { name: string }[];
    expect(written.map((e) => e.name).sort()).toEqual(['X', 'Y']);

    const isolated = await prepareGitnexusHome({ baseDir: base, projectRoot: 'G:/work/y', cwd: 'G:/work/y', settings: { mcpProjectState: {} } as unknown as AppSettings, realHome: real });
    const isolatedWritten = JSON.parse(await readFile(path.join(isolated, 'registry.json'), 'utf8')) as { name: string }[];
    expect(isolatedWritten.map((e) => e.name)).toEqual(['Y']);
  });

  it('creates the home with an empty registry when nothing is indexed', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'gn-base-'));
    dirs.push(base);
    const home = await prepareGitnexusHome({ baseDir: base, projectRoot: 'G:/work/y', cwd: 'G:/work/y', settings: { mcpProjectState: {} } as unknown as AppSettings, realHome: path.join(base, 'nope') });
    expect(JSON.parse(await readFile(path.join(home, 'registry.json'), 'utf8'))).toEqual([]);
  });
});

describe('built-in GitNexus in the effective set', () => {
  const def = gitnexusBaseDef();
  const none: McpServerDef[] = [];

  it('is enabled by default for inject harnesses and shadowed by no user entry', () => {
    const entries = builtinEntries({ builtin: [def], state: {}, harness: 'claude', support: 'inject' });
    expect(entries).toEqual([{ def, scope: 'builtin', enabled: true }]);
  });

  it('is off when the repo switched it off', () => {
    const [e] = builtinEntries({ builtin: [def], state: { disabledBuiltin: [GITNEXUS_SERVER_ID] }, harness: 'claude', support: 'inject' });
    expect(e.enabled).toBe(false);
    expect(e.reason).toBe('disabled');
  });

  it('is not injected into harnesses that read their own store or take nothing', () => {
    for (const support of ['none', 'inherit'] as const) {
      const [e] = builtinEntries({ builtin: [def], state: {}, harness: 'cursor', support });
      expect(e.enabled).toBe(false);
      expect(e.reason).toBe('not-injected');
    }
  });

  it('shadows a user server with the same id instead of injecting it twice', () => {
    const user = { id: GITNEXUS_SERVER_ID, transport: 'stdio' as const, command: 'npx', args: ['-y', 'gitnexus@latest', 'mcp'] };
    const input = { global: [user], repo: none, state: {}, harness: 'claude' as const, support: 'inject' as const, builtin: [def] };
    expect(effectiveServers(input)).toEqual([]);
    expect(effectiveEntries(input)[0].reason).toBe('shadowed');
  });

  it('exposes the shared roots the UI toggles', () => {
    const settings = { mcpProjectState: { a: { gitnexusGlobal: true }, b: { gitnexusGlobal: false }, c: {} } } as unknown as AppSettings;
    expect(gitnexusSharedRoots(settings)).toEqual(['a']);
  });

  it('knows its own id', () => {
    expect(isBuiltinServerId(GITNEXUS_SERVER_ID)).toBe(true);
    expect(isBuiltinServerId('github')).toBe(false);
  });
});
