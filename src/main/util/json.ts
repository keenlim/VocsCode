/**
 * JSON helpers for model and tool replies.
 */

/**
 * Parses the first complete JSON object in `text`, ignoring prose before or after it. A reply that
 * appends advice after the payload (`{...}\n\n---\n**Next:** …`) is common, and scanning the
 * braces (rather than taking the first `{` to the last `}`) keeps that advice out of the parse.
 */
export function parseLeadingJson<T = unknown>(text: string | null | undefined): T | null {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
