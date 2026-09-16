/**
 * Worktree isolation at session creation. `git worktree add` only works inside a repository, so a
 * request that asks for isolation on a plain folder (a freshly created one, a remembered default, a
 * spawned agent's `use_worktree`) must lose the isolation, not the session: creation used to fail
 * with "Worktrees require a git repository."
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import { defaultSettings } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import type { SessionManagerDeps } from '../src/main/session-manager';
import { SessionManager } from '../src/main/session-manager';

vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (id: string, ctx: HarnessContext) =>
    ({
      id,
      get busy() {
        return false;
      },
      start: async () => undefined,
      send: async () => undefined,
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setEffort: async () => undefined,
      setPermissionMode: async () => undefined,
      dispose: async () => undefined,
      _ctx: ctx
    }) as unknown as HarnessAdapter
}));

let tmpRoot = '';
let counter = 0;
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-worktree-'));
});
afterAll(async () => {
  // Worktrees keep read-only files under .git; force the removal so a failed run cannot wedge the next.
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

const logs: string[] = [];

async function makeManager(): Promise<SessionManager> {
  const store = new SessionStore(path.join(tmpRoot, `store${++counter}`));
  await store.load();
  const settings = { ...defaultSettings(), providers: [] };
  const deps: SessionManagerDeps = {
    store,
    settings: { get: () => settings, update: vi.fn(async () => settings) } as never,
    runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordToolCall: vi.fn(), recordUsage: vi.fn(), recordTurn: vi.fn(), recordUserMessage: vi.fn() } as never,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log: (_level, msg) => void logs.push(msg)
  };
  return new SessionManager(deps);
}

/** A folder with a repository and one commit — what isolation actually needs. */
async function repoFolder(): Promise<string> {
  const dir = path.join(tmpRoot, `repo${++counter}`);
  await fs.mkdir(dir, { recursive: true });
  const run = async (args: string[]) => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  await run(['init', '--initial-branch=main', '.']);
  await run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init']);
  return dir;
}

describe('worktree isolation at session creation', () => {
  it('drops isolation for a folder that is not a git repository', async () => {
    const projectRoot = path.join(tmpRoot, `plain${++counter}`);
    await fs.mkdir(projectRoot, { recursive: true });
    logs.length = 0;
    const manager = await makeManager();

    const meta = await manager.create({ config: { harness: 'native', projectRoot, permissionMode: 'ask', useWorktree: true } } as never);

    expect(meta.cwd).toBe(projectRoot);
    expect(meta.worktreeBranch).toBeUndefined();
    // The session must not claim an isolation it does not have; the Changes panel reads this.
    expect(meta.config.useWorktree).toBe(false);
    expect(logs.some((l) => l.includes('worktree isolation skipped'))).toBe(true);
    // Nothing was written into the folder.
    expect(await fs.readdir(projectRoot)).toEqual([]);
  });

  it('still isolates a folder that is a git repository', async () => {
    const projectRoot = await repoFolder();
    const manager = await makeManager();

    const meta = await manager.create({ config: { harness: 'native', projectRoot, permissionMode: 'ask', useWorktree: true }, title: 'isolate me' } as never);

    expect(meta.worktreeBranch).toBe('vocscode/isolate-me');
    expect(meta.cwd).toBe(path.join(projectRoot, '.vocs-code', 'worktrees', 'isolate-me'));
    expect(meta.config.useWorktree).toBe(true);
  });
});
