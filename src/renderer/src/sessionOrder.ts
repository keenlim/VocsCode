/**
 * Canonical sidebar row order for one folder's sessions. It lives outside the Sidebar component
 * because the store needs the same order to pick the row below a session that just left the list —
 * and the store cannot import a component that imports the store.
 */
import type { SessionMeta } from '../../shared/types';

/** Pinned rows sort to the top by pin stamp (first pin on top); the rest stay in recency order. */
function pinRank(s: SessionMeta): number {
  return s.pinned ? (s.pinnedAt ?? s.createdAt) : Number.POSITIVE_INFINITY;
}

/**
 * What a row's recency is measured from: the user's own last message here. Agent activity keeps
 * `updatedAt` moving, so ordering by that let a long turn in the background pull a session the user
 * was not working in over the one they were. Rows written before the stamp existed (or never sent a
 * prompt) fall back to `updatedAt`, so the upgrade does not reshuffle every folder at once.
 */
export function recencyAt(s: SessionMeta): number {
  return s.lastUserMessageAt ?? s.updatedAt;
}

/** Canonical display order for one folder's session list. */
export function sortSessionRows(list: SessionMeta[]): SessionMeta[] {
  return [...list].sort((a, b) => pinRank(a) - pinRank(b) || recencyAt(b) - recencyAt(a) || a.id.localeCompare(b.id));
}
