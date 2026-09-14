/** Unit tests for the offline mirror builder (src/main/remote/mirror.ts): debounced snapshot
 *  uploads, index refresh, size capping and clearing when the policy is turned off. The builder
 *  talks to a stub host, so no relay is involved. */
import { describe, expect, it } from 'vitest';
import { RemoteMirror } from '../src/main/remote/mirror';
import { importAesKey, openBlob, randomKeyB64 } from '../src/shared/crypto';
import type { MirrorIndex, MirrorSnapshot } from '../src/shared/mirror';
import type { RemoteHost } from '../src/main/remote/host';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function session(id: string, updatedAt: number): SessionMeta {
  return { id, title: `Title ${id}`, status: 'idle', updatedAt, config: { harness: 'native', projectRoot: '/repo' } } as unknown as SessionMeta;
}

function item(id: string, text = `text ${id}`): TranscriptItem {
  return { id, kind: 'user', ts: 1, text } as TranscriptItem;
}

interface Put {
  kind: 'index' | 'session';
  id?: string;
  blob: { iv: string; ct: string };
}

function harness(opts: { secret: string; puts: Put[]; cleared: () => void }) {
  return {
    mirrorSecret: () => opts.secret,
    putMirror: async (kind: 'index' | 'session', id: string | undefined, blob: { iv: string; ct: string }) => {
      opts.puts.push({ kind, id, blob });
      return true;
    },
    clearMirror: async () => opts.cleared()
  } as unknown as RemoteHost;
}

describe('offline mirror builder', () => {
  it('debounces a session snapshot and seals it under the host key', async () => {
    const secret = randomKeyB64();
    const puts: Put[] = [];
    const metas = [session('s1', 5)];
    const items = [item('m1'), item('m2')];
    const mirror = new RemoteMirror({
      host: () => harness({ secret, puts, cleared: () => undefined }),
      sessions: () => metas,
      transcript: async () => items,
      enabled: () => true,
      debounceMs: 5,
      log: () => undefined
    });

    mirror.notify('s1');
    mirror.notify('s1'); // second edit inside the window must not double-upload
    expect(puts).toHaveLength(0);
    await sleep(40);
    const sessionPuts = puts.filter((p) => p.kind === 'session');
    expect(sessionPuts).toHaveLength(1);

    const key = await importAesKey(secret);
    const snapshot = await openBlob<MirrorSnapshot>(key, sessionPuts[0].blob);
    expect(snapshot.title).toBe('Title s1');
    expect(snapshot.items).toEqual(items);
    expect(snapshot.truncated).toBeUndefined();

    // The index rides alongside the snapshot so the sidebar can render offline.
    const index = await openBlob<MirrorIndex>(key, puts.find((p) => p.kind === 'index')!.blob);
    expect(index.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('keeps a bounded tail when the transcript is too large', async () => {
    const secret = randomKeyB64();
    const puts: Put[] = [];
    const big = Array.from({ length: 40 }, (_, i) => item(`m${i}`, 'x'.repeat(100_000)));
    const mirror = new RemoteMirror({
      host: () => harness({ secret, puts, cleared: () => undefined }),
      sessions: () => [session('s1', 1)],
      transcript: async () => big,
      enabled: () => true,
      debounceMs: 5,
      log: () => undefined
    });
    mirror.notify('s1');
    await sleep(500);

    const key = await importAesKey(secret);
    const snapshot = await openBlob<MirrorSnapshot>(key, puts.find((p) => p.kind === 'session')!.blob);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.items.at(-1)?.id).toBe('m39');
    expect(JSON.stringify(snapshot.items).length).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('does nothing while disabled and clears the relay copy when turned off', async () => {
    const secret = randomKeyB64();
    const puts: Put[] = [];
    let cleared = 0;
    let enabled = false;
    const mirror = new RemoteMirror({
      host: () => harness({ secret, puts, cleared: () => cleared++ }),
      sessions: () => [session('s1', 1)],
      transcript: async () => [item('m1')],
      enabled: () => enabled,
      debounceMs: 5,
      log: () => undefined
    });

    mirror.notify('s1');
    mirror.sync();
    await sleep(30);
    expect(puts).toHaveLength(0);

    enabled = true;
    mirror.sync();
    await sleep(40);
    expect(puts.length).toBeGreaterThan(0);

    await mirror.disable();
    expect(cleared).toBe(1);
  });
});
