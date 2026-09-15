/**
 * The system prompt additions a session runs with: what the user configured, plus the project's
 * knowledge digest. The digest is kept beside the config (`SessionMeta.knowledgeDigest`) rather than
 * folded into it, so a session whose config was copied — a fork, a duplicated session — does not
 * inherit a stale digest only to have a second one appended on top of it.
 *
 * Harnesses that have no system prompt to add to (`capabilities.systemPrompt` false) are primed
 * through the first message instead; see `SessionManager.dispatchInput`.
 */
import type { SessionMeta } from '../../shared/types';

export function sessionAppendPrompt(meta: Pick<SessionMeta, 'config' | 'knowledgeDigest'>): string | undefined {
  const parts = [meta.config.appendSystemPrompt?.trim(), meta.knowledgeDigest?.trim()].filter(Boolean);
  return parts.length ? parts.join('\n\n') : undefined;
}
