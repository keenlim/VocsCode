/** Builds and uploads the encrypted offline transcript mirror (docs/REMOTE-ACCESS.md P4). The
 *  desktop is the only writer: it seals an index plus per-session snapshots with the shared mirror
 *  key and PUTs them to the relay. Streaming turns would hammer the relay, so uploads are debounced
 *  per session; turning the policy off drops the relay-side copy. Nothing here reads the key from
 *  settings — it comes from the host's secret-store credentials. */
import os from 'node:os';
import { importAesKey, sealBlob } from '../../shared/crypto';
import type { MirrorIndex, MirrorSnapshot } from '../../shared/mirror';
import type { SessionMeta, TranscriptItem } from '../../shared/types';
import type { Logger } from '../log';
import type { RemoteHost } from './host';

const DEBOUNCE_MS = 4_000;
const MAX_INDEX_SESSIONS = 50;
const MAX_SNAPSHOT_ITEMS = 800;
/** Stay well under the relay's 8 MB per-blob cap; the plaintext JSON is bigger than the ciphertext. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export class RemoteMirror {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private indexTimer: ReturnType<typeof setTimeout> | null = null;
  private key: { secret: string; value: CryptoKey } | null = null;
  private stopped = false;

  constructor(
    private readonly deps: {
      host: () => RemoteHost | null;
      sessions: () => SessionMeta[];
      transcript: (id: string) => Promise<TranscriptItem[]>;
      enabled: () => boolean;
      log: Logger;
      /** Quiet period before an upload; tests shrink it. */
      debounceMs?: number;
    }
  ) {}

  /** Turns mirroring off: cancel pending work and drop the relay-side copy. */
  async disable(): Promise<void> {
    this.clearTimers();
    await this.deps.host()?.clearMirror();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
  }

  /** A session's transcript or status changed: re-upload it (and the index) after a quiet beat. */
  notify(sessionId: string): void {
    if (this.stopped || !this.deps.enabled()) return;
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        void this.uploadSession(sessionId);
      }, this.deps.debounceMs ?? DEBOUNCE_MS)
    );
    this.notifyIndex();
  }

  /** The session list changed (create/rename/archive): refresh the sealed index. */
  notifyIndex(): void {
    if (this.stopped || !this.deps.enabled()) return;
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      void this.uploadIndex();
    }, this.deps.debounceMs ?? DEBOUNCE_MS);
  }

  /** Full sync — used right after the user turns mirroring on. */
  sync(): void {
    if (this.stopped || !this.deps.enabled()) return;
    for (const s of this.recentSessions()) this.notify(s.id);
    this.notifyIndex();
  }

  // --- internals ---

  private recentSessions(): SessionMeta[] {
    return [...this.deps.sessions()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_INDEX_SESSIONS);
  }

  /** Caches the imported key so a burst of uploads does not re-import it every time. */
  private async mirrorKey(): Promise<CryptoKey | null> {
    const secret = this.deps.host()?.mirrorSecret();
    if (!secret) return null;
    if (this.key?.secret === secret) return this.key.value;
    const value = await importAesKey(secret);
    this.key = { secret, value };
    return value;
  }

  private async uploadIndex(): Promise<void> {
    const host = this.deps.host();
    const key = await this.mirrorKey();
    if (!host || !key || !this.deps.enabled()) return;
    const index: MirrorIndex = {
      hostName: os.hostname(),
      updatedAt: Date.now(),
      sessions: this.recentSessions().map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        harness: s.config.harness,
        projectRoot: s.config.projectRoot,
        updatedAt: s.updatedAt
      }))
    };
    try {
      await host.putMirror('index', undefined, await sealBlob(key, index));
    } catch (e) {
      this.deps.log('warn', `remote: mirror index upload failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async uploadSession(sessionId: string): Promise<void> {
    const host = this.deps.host();
    const key = await this.mirrorKey();
    const meta = this.deps.sessions().find((s) => s.id === sessionId);
    if (!host || !key || !meta || !this.deps.enabled()) return;
    try {
      const { items, truncated } = capItems(await this.deps.transcript(sessionId));
      const snapshot: MirrorSnapshot = {
        id: meta.id,
        title: meta.title,
        status: meta.status,
        harness: meta.config.harness,
        updatedAt: meta.updatedAt,
        truncated: truncated || undefined,
        items
      };
      await host.putMirror('session', sessionId, await sealBlob(key, snapshot));
    } catch (e) {
      this.deps.log('warn', `remote: mirror snapshot upload failed for ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private clearTimers(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexTimer = null;
  }
}

/** Keeps the newest items that fit the byte cap; reports whether anything was dropped. */
function capItems(items: TranscriptItem[]): { items: TranscriptItem[]; truncated: boolean } {
  if (items.length <= MAX_SNAPSHOT_ITEMS && JSON.stringify(items).length <= MAX_SNAPSHOT_BYTES) {
    return { items, truncated: false };
  }
  const tail = items.slice(-MAX_SNAPSHOT_ITEMS);
  let start = 0;
  while (start < tail.length && JSON.stringify(tail.slice(start)).length > MAX_SNAPSHOT_BYTES) start++;
  return { items: tail.slice(start), truncated: true };
}
