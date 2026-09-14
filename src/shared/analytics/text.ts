/**
 * Text hygiene for analytics: what may be kept from a command line or a tool's output, and how it is
 * normalized so equal failures produce equal signatures. Everything stored for the dashboard goes
 * through here; full stdout/stderr never does.
 */

/** Longest command preview and error excerpt retained per execution. */
export const PREVIEW_LIMIT = 200;
export const EXCERPT_LIMIT = 400;

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<private-key>'],
  [/\b(sk|rk|pk)-(?:[a-z]+-)?[A-Za-z0-9_-]{16,}\b/g, '<secret>'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g, '<secret>'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '<secret>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<secret>'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '<secret>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<jwt>'],
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1<credentials>@'],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 <secret>'],
  [/\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|credential|auth(?:orization)?|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*)\s*([:=]+)\s*(["']?)(?!<)[^\s"',;&|]{4,}\3/gi, '$1$2<redacted>'],
  [/(--?(?:token|password|passwd|secret|api-?key|key|auth|access-token|client-secret)(?:[=\s]+))(["']?)[^\s"']{4,}\2/gi, '$1<redacted>']
];

/** Replaces credential-looking material with placeholders; never throws, never lengthens the text much. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Strips ANSI escapes and normalizes line endings and whitespace runs. */
export function cleanText(text: string): string {
  return text
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ');
}

/** A bounded, redacted preview of a command line, one line, for drill-down rows. */
export function commandPreview(command: string, limit = PREVIEW_LIMIT): string {
  const one = cleanText(redactSecrets(command)).replace(/\n+/g, ' ⏎ ').trim();
  return one.length > limit ? `${one.slice(0, limit - 1)}…` : one;
}

const ERRORISH = /\b(error|fatal|failed|failure|cannot|can't|could not|couldn't|not found|not recognized|no such|denied|refused|invalid|unexpected|missing|unknown|exception|traceback|panic|unable|timed? ?out|aborted|killed|exit code|exited with|syntax|unterminated|conflict|rejected|unauthorized|forbidden|enoent|eacces|eperm|econn|etimedout|enotfound|ebusy|enospc|enomem|usage:)\b/i;

/**
 * `path:12:text` (grep -n), `12: text` (nl, sed) and diff lines are a program's output, not the
 * program complaining; a compiler's `path:12:3: error: …` still counts as a complaint.
 */
export function isContentLine(line: string): boolean {
  if (/^[+-](?![+-])\s?\S/.test(line)) return true;
  if (/^\d+[:|]\s/.test(line)) return true;
  if (/^[^\s:]+(?::\d+){1,2}[:-]/.test(line)) return !/(?::\d+)+[:-]\s*(?:error|fatal|warning)\b/i.test(line);
  return false;
}

/**
 * The lines of a tool output that identify a failure: the harness's own status line, the first
 * lines that read like an error, and the first and last non-empty lines for context. Redacted and
 * bounded so a record never carries a program's output wholesale.
 */
export function errorExcerpt(output: string | undefined, limit = EXCERPT_LIMIT): string | undefined {
  if (!output) return undefined;
  const lines = cleanText(output)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[-=─⎯~+*_ ]{3,}$/.test(l));
  if (lines.length === 0) return undefined;
  const picked: string[] = [];
  const seen = new Set<string>();
  const take = (l: string) => {
    if (seen.has(l)) return;
    seen.add(l);
    picked.push(l.length > 160 ? `${l.slice(0, 159)}…` : l);
  };
  // Status lines the tool wrappers append (exit code, timeout, abort) lead, so extraction is stable.
  for (const l of lines) if (/^(?:exit code \d+|command (?:exited with code|timed out|aborted)|\[exit code:|\[interrupted|\[timed out)/i.test(l)) take(l);
  let errorish = 0;
  for (const l of lines) {
    if (errorish >= 4) break;
    if (isContentLine(l)) continue;
    if (ERRORISH.test(l) && !seen.has(l)) {
      take(l);
      errorish++;
    }
  }
  take(lines[0]);
  take(lines[lines.length - 1]);
  let out = redactSecrets(picked.join('\n'));
  if (out.length > limit) out = `${out.slice(0, limit - 1)}…`;
  return out;
}

/**
 * Exit code embedded as text by tool wrappers that do not report it structurally: pi
 * (`Command exited with code 2`), Claude (`Exit code 1` on the first line), native (`[exit code: 7]`).
 */
export function extractExitCode(output: string | undefined): number | undefined {
  if (!output) return undefined;
  const m = /(?:^|\n)\s*(?:Command exited with code|Exit code|\[exit code:|exit status|exited with (?:exit )?code)\s*(-?\d+)/i.exec(output) ?? /\bexit code[:=]?\s*(-?\d+)\b/i.exec(output.slice(-400));
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Collapses the variable parts of an error line so identical failures share one signature: paths,
 * numbers, ids, quoted names and hashes become placeholders.
 */
export function normalizeForSignature(line: string): string {
  return cleanText(redactSecrets(line))
    .replace(/[A-Za-z]:[\\/](?:[^\\/\s"'`]+[\\/])*[^\\/\s"'`]*/g, '<path>')
    .replace(/(?<=^|[\s"'`(=:])(?:\/[^/\s"'`)]+){2,}\/?/g, '<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{7,64}\b/gi, '<hex>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<time>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 120);
}
