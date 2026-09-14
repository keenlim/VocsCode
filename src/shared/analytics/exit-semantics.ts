/**
 * Exit-semantics registry: what a non-zero exit status means for programs whose documentation says
 * so. `rg` returning 1 found nothing, `test` returning 1 evaluated false, `git diff --quiet`
 * returning 1 saw differences. Anything the registry does not know stays unclassified here so a
 * caller falls back conservatively instead of calling every unknown exit a mistake.
 *
 * Rules are keyed by normalized executable (see command.ts) and evaluated with the arguments, so
 * `git diff --quiet` and `git push` can differ. Bump OUTCOME_CLASSIFIER_VERSION when a rule's
 * meaning changes.
 */
import type { ClassificationConfidence, ErrorCategory, ErrorSource, LogicalOperation } from './taxonomy';

export interface ExitVerdict {
  category: ErrorCategory;
  confidence: ClassificationConfidence;
  /** Overrides the category's default source when the program identifies the party (curl 22 is the server). */
  source?: ErrorSource;
  note?: string;
}

export interface ExitRuleInput {
  exe: string;
  args: string[];
  exitCode: number;
  operation: LogicalOperation;
  /** True when the output had lines that read like an error; a silent exit 1 from rg is a no-match. */
  outputHasErrorText: boolean;
  outputEmpty: boolean;
}

type ExitRule = (input: ExitRuleInput) => ExitVerdict | null;

const SEARCH = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'ugrep', 'findstr', 'git-grep']);

function has(args: string[], ...flags: string[]): boolean {
  return args.some((a) => flags.includes(a));
}

const rules: Record<string, ExitRule> = {};

for (const exe of SEARCH) {
  rules[exe] = ({ exitCode, outputHasErrorText }) => {
    if (exitCode === 1 && !outputHasErrorText) return { category: 'search_no_match', confidence: 'high' };
    if (exitCode === 1) return { category: 'search_no_match', confidence: 'medium', note: 'exit 1 with error-like text' };
    return null; // 2 = real error; the stderr rules name it
  };
}
rules.fd = ({ exitCode }) => (exitCode === 1 ? { category: 'search_no_match', confidence: 'medium' } : null);
rules.fdfind = rules.fd;
rules['select-string'] = () => null;

for (const exe of ['test', '[', '[[']) rules[exe] = ({ exitCode }) => (exitCode === 1 ? { category: 'predicate_false', confidence: 'high' } : null);

for (const exe of ['which', 'where', 'command', 'type', 'hash', 'get-command', 'gcm']) rules[exe] = ({ exitCode }) => (exitCode === 1 ? { category: 'probe_negative', confidence: 'high' } : null);

for (const exe of ['cmp', 'diff', 'diff3', 'colordiff', 'delta']) rules[exe] = ({ exitCode }) => (exitCode === 1 ? { category: 'differences_detected', confidence: 'high' } : null);

rules.git = ({ args, exitCode, operation }) => {
  const sub = args.find((a) => !a.startsWith('-'));
  if (sub === 'grep') return exitCode === 1 ? { category: 'search_no_match', confidence: 'high' } : null;
  if ((sub === 'diff' || sub === 'diff-index' || sub === 'diff-files' || sub === 'diff-tree') && (has(args, '--quiet', '--exit-code') || exitCode === 1) && exitCode === 1) return { category: 'differences_detected', confidence: has(args, '--quiet', '--exit-code') ? 'high' : 'medium' };
  if (sub === 'diff' && has(args, '--check') && exitCode === 2) return { category: 'differences_detected', confidence: 'medium', note: 'whitespace problems reported' };
  if (sub === 'ls-files' && has(args, '--error-unmatch') && exitCode === 1) return { category: 'probe_negative', confidence: 'high' };
  if (sub === 'rev-parse' && (has(args, '--verify') || has(args, '-q', '--quiet')) && exitCode === 1) return { category: 'probe_negative', confidence: 'high' };
  if ((sub === 'show-ref' || sub === 'cat-file' || sub === 'merge-base' || sub === 'ls-remote') && exitCode === 1) return { category: 'probe_negative', confidence: 'high' };
  if (sub === 'ls-remote' && has(args, '--exit-code') && exitCode === 2) return { category: 'probe_negative', confidence: 'high' };
  if (exitCode === 128) return { category: 'vcs_failure', confidence: 'low', note: 'git fatal without a recognized message' };
  void operation;
  return null;
};

rules.gh = ({ args, exitCode }) => {
  const sub = args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ');
  if (sub === 'pr checks' && exitCode === 8) return { category: 'probe_negative', confidence: 'high', note: 'checks still pending' };
  if (sub === 'pr checks' && exitCode === 1) return { category: 'probe_negative', confidence: 'medium', note: 'some checks failed' };
  if (exitCode === 1 && (sub === 'pr view' || sub === 'pr status' || sub === 'run view' || sub === 'issue view' || sub === 'release view')) return { category: 'probe_negative', confidence: 'low', note: 'gh exits 1 both for "none found" and for API errors' };
  if (exitCode === 4) return { category: 'missing_credentials', confidence: 'high', source: 'environment' };
  return null;
};

rules.curl = ({ exitCode }) => {
  if (exitCode === 22) return { category: 'network_failure', confidence: 'high', source: 'external_service', note: 'HTTP error status (curl -f)' };
  if (exitCode === 28) return { category: 'timeout', confidence: 'high' };
  if ([5, 6, 7, 35, 52, 55, 56, 60].includes(exitCode)) return { category: 'network_failure', confidence: 'high' };
  if (exitCode === 2 || exitCode === 3) return { category: 'invalid_argument', confidence: 'high' };
  return null;
};
rules.wget = ({ exitCode }) => {
  if (exitCode === 4) return { category: 'network_failure', confidence: 'high' };
  if (exitCode === 8) return { category: 'network_failure', confidence: 'high', source: 'external_service' };
  if (exitCode === 2) return { category: 'invalid_argument', confidence: 'high' };
  return null;
};

rules.npm = ({ args, exitCode }) => {
  const sub = args.find((a) => !a.startsWith('-'));
  if ((sub === 'ls' || sub === 'll' || sub === 'la' || sub === 'outdated' || sub === 'audit') && exitCode === 1) return { category: 'probe_negative', confidence: 'high', note: `npm ${sub} exits 1 when it has findings` };
  return null;
};
rules.pnpm = rules.npm;
rules.pip = ({ args, exitCode }) => {
  const sub = args.find((a) => !a.startsWith('-'));
  if ((sub === 'show' || sub === 'check') && exitCode === 1) return { category: 'probe_negative', confidence: 'high' };
  return null;
};
rules.pip3 = rules.pip;

rules.timeout = ({ exitCode }) => (exitCode === 124 ? { category: 'timeout', confidence: 'high' } : null);
rules.gtimeout = rules.timeout;

rules.pytest = ({ exitCode }) => {
  if (exitCode === 1) return { category: 'test_failures_reported', confidence: 'high' };
  if (exitCode === 2) return { category: 'cancelled', confidence: 'medium', note: 'pytest interrupted' };
  if (exitCode === 3) return { category: 'program_error', confidence: 'medium', note: 'pytest internal error' };
  if (exitCode === 4) return { category: 'invalid_argument', confidence: 'high' };
  if (exitCode === 5) return { category: 'invalid_argument', confidence: 'medium', note: 'no tests collected' };
  return null;
};
rules['py.test'] = rules.pytest;
rules.cargo = ({ args, exitCode }) => {
  const sub = args.find((a) => !a.startsWith('-') && !a.startsWith('+'));
  if (sub === 'test' && exitCode === 101) return { category: 'test_failures_reported', confidence: 'medium', note: 'cargo exits 101 for failed tests and for panics' };
  if ((sub === 'build' || sub === 'check' || sub === 'clippy') && exitCode === 101) return { category: sub === 'build' ? 'build_failed' : 'check_failures_reported', confidence: 'high' };
  return null;
};
rules.tsc = ({ exitCode }) => (exitCode === 1 || exitCode === 2 ? { category: 'check_failures_reported', confidence: 'high' } : null);
rules.eslint = ({ exitCode }) => (exitCode === 1 ? { category: 'check_failures_reported', confidence: 'high' } : null);
rules.prettier = ({ args, exitCode }) => (exitCode === 1 && has(args, '--check', '-c', '--list-different', '-l') ? { category: 'check_failures_reported', confidence: 'high' } : null);
rules.ls = ({ exitCode }) => (exitCode === 2 ? { category: 'invalid_path', confidence: 'medium', note: 'ls exits 2 for a missing operand path' } : null);
rules.dir = rules.ls;
rules.cat = ({ exitCode }) => (exitCode === 1 ? { category: 'invalid_path', confidence: 'low' } : null);

/** Signals and shell conventions that mean the same whatever program ran. */
function genericExit(exitCode: number): ExitVerdict | null {
  switch (exitCode) {
    case 124:
      return { category: 'timeout', confidence: 'medium', note: 'timeout(1) convention' };
    case 126:
      return { category: 'permission_denied', confidence: 'medium', note: 'command found but not executable' };
    case 127:
      return { category: 'command_not_found', confidence: 'high' };
    case 130:
      return { category: 'cancelled', confidence: 'high', note: 'SIGINT' };
    case 137:
      return { category: 'killed', confidence: 'high', note: 'SIGKILL' };
    case 143:
      return { category: 'cancelled', confidence: 'medium', note: 'SIGTERM' };
    case -1073741510:
    case 3221225786:
      return { category: 'cancelled', confidence: 'high', note: 'STATUS_CONTROL_C_EXIT' };
    case -1073741819:
    case 3221225477:
      return { category: 'killed', confidence: 'high', note: 'STATUS_ACCESS_VIOLATION' };
    default:
      return null;
  }
}

/** Operation-level fallbacks when the executable itself has no entry. */
function operationExit(input: ExitRuleInput): ExitVerdict | null {
  if (input.exitCode <= 0) return null;
  switch (input.operation) {
    case 'run_tests':
      return { category: 'test_failures_reported', confidence: 'medium', note: 'non-zero exit of a test runner' };
    case 'check':
      return { category: 'check_failures_reported', confidence: 'medium' };
    case 'build':
      return { category: 'build_failed', confidence: 'medium' };
    default:
      return null;
  }
}

/**
 * Classifies a non-zero exit of `exe` from documented exit semantics alone. Returns null when the
 * registry has nothing to say, so the caller can consult the output or fall back to "unknown".
 */
export function classifyProcessOutcome(input: ExitRuleInput): ExitVerdict | null {
  if (input.exitCode === 0) return null;
  const rule = rules[input.exe];
  const own = rule ? rule(input) : null;
  if (own) return own;
  const generic = genericExit(input.exitCode);
  if (generic) return generic;
  return operationExit(input);
}

/** Executables with a registry entry, for tests and documentation. */
export function registeredExecutables(): string[] {
  return Object.keys(rules).sort();
}
