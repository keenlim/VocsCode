/**
 * Live anchor resolution against a real MCP server over Streamable HTTP: the fixture answers the
 * same `context` shape GitNexus does, so this covers the JSON parsing, the caching and every
 * degraded path without needing an index.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitnexusAnchorResolver } from '../src/main/knowledge/anchors';
import type { KnowledgeScope } from '../src/shared/knowledge';

const fixture = path.resolve('tests/fixtures/mcp-graph-server.mjs');

let root: string;
let server: ChildProcess | null = null;
let calls = 0;

/** Starts the graph fixture and waits for the port it announces. */
async function startGraph(): Promise<string> {
  const child = spawn(process.execPath, [fixture], { stdio: ['ignore', 'pipe', 'pipe'] });
  server = child;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('graph fixture did not start')), 20_000);
    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        if (line.startsWith('CALL:context:')) calls++;
        if (line.startsWith('READY:')) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${line.slice('READY:'.length).trim()}/mcp`);
        }
      }
    });
    child.on('error', reject);
  });
}

function resolver(url: string | null, repo: string | null = 'Vocs-Code') {
  return createGitnexusAnchorResolver({
    url: async () => url,
    repoName: async () => repo,
    log: () => undefined
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-anchors-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'present.ts'), 'export const x = 1;\n', 'utf8');
  calls = 0;
});

afterEach(async () => {
  server?.kill();
  server = null;
  await new Promise((resolve) => setTimeout(resolve, 150));
  await fs.rm(root, { recursive: true, force: true });
});

const scope = (): KnowledgeScope => ({ projectRoot: root, cwd: root });

describe('anchor resolution', () => {
  it('reports found symbols with their location, and moved ones with a note', async () => {
    const url = await startGraph();
    const [found, moved] = await resolver(url).resolve(scope(), [
      { file: 'src/main/session-manager.ts', symbol: 'buildContext' },
      { file: 'src/main/session-manager.ts', symbol: 'movedSymbol' }
    ]);
    expect(found).toMatchObject({ status: 'resolved', foundName: 'buildContext', uid: 'Method:src/main/session-manager.ts:SessionManager.buildContext#2' });
    expect(found.lines).toEqual({ start: 520, end: 562 });
    expect(found.note).toBeUndefined();
    expect(moved).toMatchObject({ status: 'resolved', foundFile: 'src/main/elsewhere.ts' });
    expect(moved.note).toContain('src/main/elsewhere.ts');
  });

  it('reports a symbol the index does not have as unresolved, including the advice line GitNexus appends', async () => {
    const url = await startGraph();
    const [gone] = await resolver(url).resolve(scope(), [{ file: 'src/main/gone.ts', symbol: 'NeverExisted' }]);
    expect(gone.status).toBe('unresolved');
    expect(gone.note).toContain("Symbol 'NeverExisted' not found");
  });

  it('caches a resolution instead of asking again', async () => {
    const url = await startGraph();
    // One resolver instance is what the app holds; the cache lives with it.
    const resolve = resolver(url);
    const anchors = [{ file: 'src/main/session-manager.ts', symbol: 'buildContext' }];
    await resolve.resolve(scope(), anchors);
    await resolve.resolve(scope(), anchors);
    expect(calls).toBe(1);
  });

  it('answers file-only anchors from disk, without calling the graph', async () => {
    const url = await startGraph();
    const [present, missing] = await resolver(url).resolve(scope(), [{ file: 'src/present.ts' }, { file: 'src/absent.ts' }]);
    expect(present.status).toBe('resolved');
    expect(missing).toMatchObject({ status: 'unresolved', note: 'File not found.' });
    expect(calls).toBe(0);
  });

  it('degrades to unavailable when GitNexus is down or the project is not indexed', async () => {
    const off = await resolver(null).resolve(scope(), [{ file: 'src/main/x.ts', symbol: 'x' }]);
    expect(off[0]).toMatchObject({ status: 'unavailable', note: 'GitNexus is not running.' });
    const unindexed = await resolver('http://127.0.0.1:1/mcp', null).resolve(scope(), [{ file: 'src/main/x.ts', symbol: 'x' }]);
    expect(unindexed[0]).toMatchObject({ status: 'unavailable', note: 'This project is not indexed by GitNexus.' });
    const refused = await resolver('http://127.0.0.1:1/mcp').resolve(scope(), [{ file: 'src/main/x.ts', symbol: 'x' }]);
    expect(refused[0].status).toBe('unavailable');
  });

  it('keeps the page order when only some anchors resolve', async () => {
    const url = await startGraph();
    const out = await resolver(url).resolve(scope(), [
      { file: 'src/present.ts' },
      { file: 'src/main/session-manager.ts', symbol: 'buildContext' },
      { file: 'src/absent.ts' }
    ]);
    expect(out.map((a) => a.status)).toEqual(['resolved', 'resolved', 'unresolved']);
  });
});
