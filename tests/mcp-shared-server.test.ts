/**
 * The one shared GitNexus server (`src/main/mcp/shared-server.ts`), against the stand-in server in
 * tests/fixtures rather than a real index: the point is how the process is spawned and torn down.
 *
 * The `.cmd` case is the regression this suite exists for. `which('gitnexus')` resolves to the npm
 * shim `%APPDATA%\npm\gitnexus.cmd` on Windows, and `child_process.spawn` throws EINVAL for a `.cmd`
 * without a shell, so every session silently lost its GitNexus server.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SharedGitnexusServer } from '../src/main/mcp/shared-server';

const FIXTURE = path.resolve('tests/fixtures/mcp-http-server.mjs');
const isWin = process.platform === 'win32';

const live: SharedGitnexusServer[] = [];

function start(command: string, baseArgs: string[], startupTimeoutMs = 30_000): SharedGitnexusServer {
  const server = new SharedGitnexusServer({ command, baseArgs, startupTimeoutMs, log: () => {} });
  live.push(server);
  return server;
}

/** One readiness probe, exactly what the server itself sends. */
async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    await res.arrayBuffer();
    return res.status < 500;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(live.splice(0).map((server) => server.stop()));
});

describe('SharedGitnexusServer', () => {
  it('serves MCP and stops the process it started', async () => {
    const server = start(process.execPath, [FIXTURE]);
    const url = await server.ensure();
    expect(url).not.toBeNull();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/mcp$/);
    expect(await answers(url!)).toBe(true);

    await server.stop();
    // Nothing keeps listening once the tree is killed; a surviving child would keep answering.
    await expect.poll(() => answers(url!), { timeout: 15_000, interval: 250 }).toBe(false);

    // A stopped server does not hand out an endpoint again.
    expect(await server.ensure()).toBeNull();
  }, 60_000);

  // The npm-installed shape of `gitnexus` on Windows, and the form `which()` actually returns.
  it.runIf(isWin)('serves MCP through a .cmd shim', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vocs-gitnexus-shim-'));
    try {
      const shim = path.join(dir, 'gitnexus.cmd');
      await writeFile(shim, `@echo off\r\n"${process.execPath}" "${FIXTURE}" %*\r\n`, 'utf8');
      const server = start(shim, ['serve']);
      const url = await server.ensure();
      expect(url).not.toBeNull();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/mcp$/);
      expect(await answers(url!)).toBe(true);

      await server.stop();
      await expect.poll(() => answers(url!), { timeout: 15_000, interval: 250 }).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('reports no endpoint instead of a broken one when the command cannot run', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vocs-gitnexus-missing-'));
    try {
      const server = start(path.join(dir, 'not-a-program'), ['serve'], 1_000);
      await expect(server.ensure()).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
