/**
 * Outcome classification fixtures: one per failure mode the reliability analytics must tell apart.
 * Each fixture mirrors what a real harness put in the transcript, so a rule change that flips one
 * of these flips a dashboard number and is caught here first.
 */
import { describe, expect, it } from 'vitest';
import { analyzeCommand, exitOwner, parseSegment, splitSegments, unwrapCommand } from '../src/shared/analytics/command';
import { classifyExecution, deriveOutcome, extractFacts, physicalToolOf, signatureOf, type ExecutionInput } from '../src/shared/analytics/classify';
import { classifyProcessOutcome, registeredExecutables } from '../src/shared/analytics/exit-semantics';
import { OUTCOME_CLASSIFIER_VERSION } from '../src/shared/analytics/taxonomy';
import { commandPreview, errorExcerpt, extractExitCode, normalizeForSignature, redactSecrets } from '../src/shared/analytics/text';

const PS = '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command ';

function pi(command: string, output: string | undefined, status: ExecutionInput['status'] = 'error'): ExecutionInput {
  return { harness: 'pi', tool: 'bash', hint: 'execute', status, output, input: { command }, platform: 'win32' };
}
function claude(command: string, output: string | undefined, status: ExecutionInput['status'] = 'error'): ExecutionInput {
  return { harness: 'claude', tool: 'Bash', hint: 'execute', status, output, input: { command }, platform: 'win32' };
}
function codex(inner: string, output: string, exitCode: number, status: ExecutionInput['status'] = exitCode === 0 ? 'done' : 'error'): ExecutionInput {
  return { harness: 'codex', tool: 'shell', hint: 'execute', status, output, exitCode, input: { command: `${PS}'${inner}'`, cwd: 'G:\\repo' }, durationMs: 120, platform: 'win32' };
}

describe('command analysis', () => {
  it('unwraps harness shell launchers and names the shell they ran', () => {
    expect(unwrapCommand(`${PS}"rg -n \\"foo\\" src"`)).toEqual({ inner: 'rg -n "foo" src', shell: 'powershell', wrapper: 'powershell' });
    expect(unwrapCommand('"C:\\\\Users\\\\x\\\\.cache\\\\codex-runtimes\\\\pwsh.exe" -Command \'npm test\'')).toEqual({ inner: 'npm test', shell: 'powershell', wrapper: 'powershell' });
    expect(unwrapCommand('"C:\\\\Users\\\\vocs\\\\AppData\\\\Local\\\\Microsoft\\\\WindowsApps\\\\bash.exe" -lc "cd /g/repo && ls"')).toEqual({ inner: 'cd /g/repo && ls', shell: 'bash', wrapper: 'bash' });
    expect(unwrapCommand('cmd.exe /c dir')).toEqual({ inner: 'dir', shell: 'cmd', wrapper: 'cmd' });
    expect(unwrapCommand('rg foo')).toEqual({ inner: 'rg foo' });
  });

  it('splits at unquoted operators only and normalizes executables', () => {
    const segs = splitSegments('cd "a && b" && FOO=1 sudo npm test 2>&1 | tail -20; echo "done|ok"', 'bash');
    expect(segs.map((s) => [s.text, s.joinedBy])).toEqual([
      ['cd "a && b"', undefined],
      ['FOO=1 sudo npm test 2>&1', '&&'],
      ['tail -20', '|'],
      ['echo "done|ok"', ';']
    ]);
    expect(parseSegment('FOO=1 sudo npm test 2>&1')).toEqual({ exe: 'npm', args: ['test', '2>&1'], elevated: true });
    expect(parseSegment('"C:\\Program Files\\nodejs\\node.exe" -e "1"')).toEqual({ exe: 'node', args: ['-e', '1'], elevated: false });
    expect(parseSegment('./scripts/run.sh --fast').exe).toBe('(script)');
    expect(parseSegment('timeout 20 ./node_modules/.bin/electron main.js').exe).toBe('electron');
  });

  it('names the exit owner as the last non-filter stage of the last pipeline', () => {
    const shape = analyzeCommand('cd /repo && npm run typecheck && npm test 2>&1 | tail -20', 'pi', 'bash', 'win32');
    expect(shape.executables).toEqual(['npm', 'npm', 'tail']);
    expect(shape.primary).toBe('npm');
    expect(shape.last).toBe('npm');
    expect(exitOwner(splitSegments('rg -n foo src | head -5', 'bash').map((s) => ({ ...parseSegment(s.text), joinedBy: s.joinedBy })))).toBe('rg');
    expect(analyzeCommand('gh run view 1 --log-failed 2>&1 | grep -iE "error|fail" | head -20', 'pi', 'bash', 'win32').last).toBe('grep');
    expect(analyzeCommand('rg -n "x" src | Select-Object -First 20', 'codex', 'shell', 'win32').last).toBe('rg');
  });

  it('measures complexity, tolerance and shell mismatch', () => {
    const simple = analyzeCommand('rg -n foo src', 'pi', 'bash', 'linux');
    expect(simple).toMatchObject({ complexity: 'simple', pipes: 0, ands: 0, tolerant: false, shellMismatch: false, shell: 'bash', operation: 'search' });
    expect(analyzeCommand('rg foo | head', 'pi', 'bash', 'linux').complexity).toBe('pipeline');
    expect(analyzeCommand('npm run build && npm test', 'pi', 'bash', 'linux')).toMatchObject({ complexity: 'compound', operation: 'run_tests' });
    expect(analyzeCommand("python - <<'PY'\nprint(1)\nPY", 'pi', 'bash', 'linux')).toMatchObject({ complexity: 'script', heredoc: true, multiline: true, operation: 'execute_program' });
    expect(analyzeCommand('ls src/x 2>/dev/null', 'pi', 'bash', 'linux').tolerant).toBe(true);
    expect(analyzeCommand('cat a || true', 'pi', 'bash', 'linux').tolerant).toBe(true);
    expect(analyzeCommand(`${PS}"rg -n foo src | head -20"`, 'codex', 'shell', 'win32')).toMatchObject({ shell: 'powershell', shellMismatch: true, wrapper: 'powershell' });
    expect(analyzeCommand(`${PS}"rg -n foo src/*.ts"`, 'codex', 'shell', 'win32').globUnderPowershell).toBe(true);
    expect(analyzeCommand('Get-ChildItem Env:NODE_ENV | Format-Table', 'pi', 'bash', 'win32').shellMismatch).toBe(true);
    expect(analyzeCommand('sudo apt-get install -y ripgrep', 'pi', 'bash', 'linux')).toMatchObject({ elevated: true, operation: 'install_dependency' });
  });

  it('assigns logical operations from the executable and its arguments', () => {
    const op = (c: string) => analyzeCommand(c, 'pi', 'bash', 'linux').operation;
    expect(op('npm test')).toBe('run_tests');
    expect(op('npx vitest run tests/a.test.ts')).toBe('run_tests');
    expect(op('python -m pytest -q')).toBe('run_tests');
    expect(op('npm run typecheck')).toBe('check');
    expect(op('npx tsc --noEmit -p tsconfig.json')).toBe('check');
    expect(op('npm run build')).toBe('build');
    expect(op('cargo build --release')).toBe('build');
    expect(op('npm install --include=dev')).toBe('install_dependency');
    expect(op('git status --short')).toBe('git_operation');
    expect(op('git grep -n foo')).toBe('search');
    expect(op('ls -la src')).toBe('inspect_repository');
    expect(op('cat package.json | jq .version')).toBe('read_file');
    expect(op('sed -i "s/a/b/" file.ts')).toBe('edit_file');
    expect(op('echo hi > out.txt')).toBe('write_file');
    expect(op('curl -sS https://example.com')).toBe('network_operation');
    expect(op('which rg')).toBe('environment_probe');
    expect(op('node --version')).toBe('environment_probe');
    expect(op('mkdir -p out && cp a b')).toBe('filesystem_operation');
    expect(op('node scripts/probe.mjs')).toBe('execute_program');
    expect(op('cd /repo')).toBe('other');
  });
});

describe('text hygiene', () => {
  it('redacts credentials in previews and excerpts', () => {
    expect(commandPreview('curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" https://api.example.com')).not.toContain('abcdefghij');
    expect(commandPreview('gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123')).not.toContain('ghp_abcdef');
    expect(redactSecrets('OPENAI_API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz node x.js')).toMatch(/^OPENAI_API_KEY=<(?:secret|redacted)> node x\.js$/);
    expect(redactSecrets('DB_PASSWORD=hunter2hunter2 node x.js')).toBe('DB_PASSWORD=<redacted> node x.js');
    expect(redactSecrets('https://user:hunter22@host/repo.git')).toBe('https://<credentials>@host/repo.git');
    expect(errorExcerpt('token=abcd1234efgh5678\nError: failed')).not.toContain('abcd1234efgh5678');
  });

  it('keeps the wrapper status line, error lines and bounds the excerpt', () => {
    const out = Array.from({ length: 200 }, (_, i) => `line ${i} of ordinary output`).join('\n') + '\nsrc/a.ts(12,3): error TS2345: bad\n\nCommand exited with code 2';
    const ex = errorExcerpt(out)!;
    expect(ex.split('\n')[0]).toBe('Command exited with code 2');
    expect(ex).toContain('error TS2345');
    expect(ex.length).toBeLessThanOrEqual(400);
    expect(extractExitCode(out)).toBe(2);
    expect(extractExitCode('Exit code 1\nbash: foo: command not found')).toBe(1);
    expect(extractExitCode('(no output)\n[exit code: 7]')).toBe(7);
    expect(extractExitCode('plain output')).toBeUndefined();
    // grep -n style result lines are content, not complaints.
    expect(errorExcerpt('src/a.ts:3:  // unknown option handling\nCommand exited with code 1')!.split('\n')).toEqual(['Command exited with code 1', 'src/a.ts:3: // unknown option handling']);
  });

  it('normalizes variable parts for signatures', () => {
    expect(normalizeForSignature("fatal: 'develop' is already used by worktree at 'G:/Vocs-Code/.vocs-code/worktrees/s-mtvlsb2fxkzwk'")).toBe("fatal: 'develop' is already used by worktree at '<path>'");
    expect(normalizeForSignature('Error: Cannot find module C:\\Users\\vocs\\x\\probe2.mjs at 2026-09-14T10:00:00Z id 3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe('error: cannot find module <path> at <time> id <uuid>');
  });
});

describe('exit-semantics registry', () => {
  const base = { args: [] as string[], operation: 'other' as const, outputHasErrorText: false, outputEmpty: true };
  it('knows the documented meanings and stays silent otherwise', () => {
    expect(classifyProcessOutcome({ ...base, exe: 'rg', exitCode: 1 })).toMatchObject({ category: 'search_no_match', confidence: 'high' });
    expect(classifyProcessOutcome({ ...base, exe: 'rg', exitCode: 2 })).toBeNull();
    expect(classifyProcessOutcome({ ...base, exe: 'grep', exitCode: 1 })).toMatchObject({ category: 'search_no_match' });
    expect(classifyProcessOutcome({ ...base, exe: 'test', exitCode: 1 })).toMatchObject({ category: 'predicate_false' });
    expect(classifyProcessOutcome({ ...base, exe: 'git', args: ['diff', '--quiet'], exitCode: 1 })).toMatchObject({ category: 'differences_detected', confidence: 'high' });
    expect(classifyProcessOutcome({ ...base, exe: 'git', args: ['push'], exitCode: 1 })).toBeNull();
    expect(classifyProcessOutcome({ ...base, exe: 'git', args: ['checkout', 'x'], exitCode: 128 })).toMatchObject({ category: 'vcs_failure', confidence: 'low' });
    expect(classifyProcessOutcome({ ...base, exe: 'cmp', exitCode: 1 })).toMatchObject({ category: 'differences_detected' });
    expect(classifyProcessOutcome({ ...base, exe: 'which', exitCode: 1 })).toMatchObject({ category: 'probe_negative' });
    expect(classifyProcessOutcome({ ...base, exe: 'curl', exitCode: 22 })).toMatchObject({ category: 'network_failure', source: 'external_service' });
    expect(classifyProcessOutcome({ ...base, exe: 'gh', args: ['pr', 'checks', '12'], exitCode: 8 })).toMatchObject({ category: 'probe_negative' });
    expect(classifyProcessOutcome({ ...base, exe: 'unknown-thing', exitCode: 3 })).toBeNull();
    expect(classifyProcessOutcome({ ...base, exe: 'unknown-thing', exitCode: 127 })).toMatchObject({ category: 'command_not_found' });
    expect(classifyProcessOutcome({ ...base, exe: 'unknown-thing', exitCode: 130 })).toMatchObject({ category: 'cancelled' });
    // Forced termination and signals: never the program's own status, so never a result or a failure.
    expect(classifyProcessOutcome({ ...base, exe: 'npm', exitCode: 0xffffffff })).toMatchObject({ category: 'process_terminated', confidence: 'high' });
    expect(classifyProcessOutcome({ ...base, exe: 'npm', exitCode: -1 })).toMatchObject({ category: 'process_terminated' });
    expect(classifyProcessOutcome({ ...base, exe: 'node', exitCode: -9 })).toMatchObject({ category: 'killed', confidence: 'high' });
    expect(classifyProcessOutcome({ ...base, exe: 'node', exitCode: -15 })).toMatchObject({ category: 'cancelled' });
    // A killed test runner is not a failing test run: the termination beats the operation fallback.
    expect(classifyProcessOutcome({ ...base, exe: 'npx', exitCode: 0xffffffff, operation: 'run_tests' })).toMatchObject({ category: 'process_terminated' });
    expect(classifyProcessOutcome({ ...base, exe: 'anything', exitCode: 0 })).toBeNull();
    expect(classifyProcessOutcome({ ...base, exe: 'npx', exitCode: 1, operation: 'run_tests' })).toMatchObject({ category: 'test_failures_reported', confidence: 'medium' });
    expect(registeredExecutables()).toContain('rg');
  });
});

describe('outcome classification fixtures', () => {
  const run = (input: ExecutionInput) => classifyExecution(input);

  it('1 · a successful shell command is a success with no signature', () => {
    const { facts, derived } = run(pi('ls -la', 'total 4\n.\n..', 'done'));
    expect(facts).toMatchObject({ physical: 'shell', toolKey: 'bash', shell: 'bash', exitSource: 'none', operation: 'inspect_repository' });
    expect(derived).toMatchObject({ outcome: 'success', signature: '', classifier: OUTCOME_CLASSIFIER_VERSION });
  });

  it('2 · a program the agent ran that raised is a failure of ambiguous source', () => {
    const { derived } = run(pi('node scripts/probe.mjs', "file:///G:/repo/scripts/probe.mjs:7\n    at x\nTypeError: Cannot read properties of undefined (reading 'map')\n\nCommand exited with code 1"));
    expect(derived).toMatchObject({ outcome: 'failure', category: 'program_error', source: 'ambiguous', signature: 'bash | program_error | node' });
  });

  it('3 · command-not-found is charged to nobody without evidence, and carries the name', () => {
    const { facts, derived } = run(pi('foo --bar', '/usr/bin/bash: line 1: foo: command not found\n\nCommand exited with code 127'));
    expect(facts).toMatchObject({ exitCode: 127, exitSource: 'output' });
    expect(derived).toMatchObject({ outcome: 'failure', category: 'command_not_found', source: 'ambiguous', method: 'stderr_signature', signature: 'bash | command_not_found | foo' });
  });

  it('4 · rg with matches is a success', () => {
    expect(run(pi('rg -n needle src', 'src/a.ts:1:needle', 'done')).derived.outcome).toBe('success');
  });

  it('5 · rg exit 1 is a search that found nothing, not an error', () => {
    const { derived } = run(pi('rg -n needle src', 'Command exited with code 1'));
    expect(derived).toMatchObject({ outcome: 'informational', category: 'search_no_match', method: 'exit_semantics', confidence: 'high', signature: 'bash | search_no_match | rg' });
    // Matched lines containing the word "error" do not turn a no-match into an argument error.
    expect(run(pi('grep -rn "unknown option" src; grep -rn zzz src', 'src/cli.ts:4: throw new Error("unknown option")\n\nCommand exited with code 1')).derived.category).toBe('search_no_match');
  });

  it('6 · rg exit 2 with a regex parse error is an invalid argument by the model', () => {
    const { derived } = run(pi('rg -n "(" src', 'rg: regex parse error:\n    (?:()\n    ^\nerror: unclosed group\n\nCommand exited with code 2'));
    expect(derived).toMatchObject({ outcome: 'failure', category: 'invalid_argument', source: 'model', method: 'stderr_signature' });
  });

  it('7 · grep no-match under Claude reads the exit code from the first line', () => {
    const { facts, derived } = run(claude('grep -rn foo src', 'Exit code 1'));
    expect(facts).toMatchObject({ exitCode: 1, exitSource: 'output', toolKey: 'bash' });
    expect(derived).toMatchObject({ outcome: 'informational', category: 'search_no_match' });
  });

  it('8 · a false test predicate is informational', () => {
    expect(run(pi('test -f missing.txt', 'Command exited with code 1')).derived).toMatchObject({ outcome: 'informational', category: 'predicate_false' });
    expect(run(pi('[ -d out ] && echo yes', 'Command exited with code 1')).derived).toMatchObject({ outcome: 'informational', category: 'predicate_false' });
  });

  it('9 · git diff --quiet exit 1 means differences exist', () => {
    expect(run(pi('git diff --quiet', 'Command exited with code 1')).derived).toMatchObject({ outcome: 'informational', category: 'differences_detected', confidence: 'high' });
    expect(run(codex('git diff --quiet -- src', '', 1)).derived).toMatchObject({ outcome: 'informational', category: 'differences_detected' });
  });

  it('10 · a real git failure is a repository-state conflict', () => {
    const { derived } = run(pi('git checkout develop', "fatal: 'develop' is already used by worktree at 'G:/Vocs-Code/.vocs-code/worktrees/s-mtvlsb2fxkzwk'\n\nCommand exited with code 128"));
    expect(derived).toMatchObject({ outcome: 'failure', category: 'vcs_state_conflict', source: 'repository', signature: 'bash | vcs_state_conflict | git' });
    expect(run(pi('git merge origin/develop', 'CONFLICT (content): Merge conflict in package.json\nAutomatic merge failed; fix conflicts and then commit the result.\n\nCommand exited with code 1')).derived.category).toBe('vcs_state_conflict');
  });

  it('11 · a test run that reports failing tests is diagnostic, not an agent failure', () => {
    const { derived } = run(pi('npx vitest run tests/x.test.ts', ' ❯ tests/x.test.ts (3 tests | 1 failed)\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n\nCommand exited with code 1'));
    expect(derived).toMatchObject({ outcome: 'diagnostic', category: 'test_failures_reported', source: 'repository', confidence: 'high' });
    expect(run(pi('npm run typecheck', "src/a.ts(3,1): error TS2304: Cannot find name 'x'.\n\nCommand exited with code 2")).derived).toMatchObject({ outcome: 'diagnostic', category: 'check_failures_reported' });
    expect(run(codex('npm test 2>&1 | Select-Object -Last 60', ' FAIL  tests/a.test.ts > case\n Tests  1 failed | 28 passed (29)', 1)).derived).toMatchObject({ outcome: 'diagnostic', category: 'test_failures_reported' });
  });

  it('12 · a test runner pointed at a missing file is a wrong-path failure, not a test result', () => {
    const { derived } = run(pi('npx vitest run tests/missing.test.ts', 'No test files found, exiting with code 1\nfilter: tests/missing.test.ts\n\nCommand exited with code 1'));
    expect(derived).toMatchObject({ outcome: 'failure', category: 'invalid_path', source: 'model' });
  });

  it('13 · a timeout is control flow', () => {
    const { facts, derived } = run(pi('npx vitest run tests/slow.test.ts 2>&1 | tail -40', 'Command timed out after 300 seconds'));
    expect(facts.timedOut).toBe(true);
    expect(derived).toMatchObject({ outcome: 'control', category: 'timeout', method: 'harness_signal', signature: 'bash | timeout | npx' });
  });

  it('14 · a cancellation is control flow', () => {
    expect(run(pi('npm run deploy:staging 2>&1 | tail -15', 'Command aborted')).derived).toMatchObject({ outcome: 'control', category: 'cancelled', source: 'user' });
    expect(run(claude('sleep 100', 'Exit code 130\nRequest interrupted by user')).derived.category).toBe('cancelled');
  });

  it('14b · a forced termination is control flow, not a failure or a test result', () => {
    const killed = (command: string, exitCode: number, output = ''): ExecutionInput => ({ harness: 'pi', tool: 'bash', hint: 'execute', status: 'error', output, exitCode, input: { command }, platform: 'win32' });
    // 0xFFFFFFFF and its signed twin -1 mean the process never returned a status of its own.
    expect(run(killed('npm test', 0xffffffff)).derived).toMatchObject({ outcome: 'control', category: 'process_terminated', source: 'unknown' });
    expect(run(killed('npm test', -1)).derived.category).toBe('process_terminated');
    expect(run(killed('node server.js', -9)).derived).toMatchObject({ outcome: 'control', category: 'killed', confidence: 'high' });
    expect(run(killed('npm run dev', -15)).derived).toMatchObject({ outcome: 'control', category: 'cancelled' });
    // The command being a test runner must not turn a killed run into reported test failures.
    expect(run(killed('npm test', 0xffffffff)).derived.category).not.toBe('test_failures_reported');
    // Output that names a cause still wins: the termination is how it ended, the error is why.
    expect(run(killed('node server.js', 0xffffffff, 'TypeError: x is not a function')).derived).toMatchObject({ outcome: 'failure', category: 'program_error' });
    // A harness control signal is more specific than the bare termination code.
    expect(run(killed('npm test', 0xffffffff, 'command timed out after 30s')).derived.category).toBe('timeout');
    expect(run(killed('npm run dev', 0xffffffff, 'Command aborted')).derived.category).toBe('cancelled');
  });

  it('15 · a declined tool call is control flow attributed to the user', () => {
    const { facts, derived } = run({ ...pi('rm -rf node_modules', 'Denied by user'), status: 'declined' });
    expect(facts.status).toBe('declined');
    expect(derived).toMatchObject({ outcome: 'control', category: 'declined', source: 'user' });
  });

  it('16 · a shell that failed to start is a harness failure', () => {
    const { derived } = run({ harness: 'native', tool: 'bash', hint: 'execute', status: 'error', exitCode: null, output: '(no output)\n[exit code: unavailable; Failed to start shell: spawn bash ENOENT]', input: { command: 'ls' }, platform: 'linux' });
    expect(derived).toMatchObject({ outcome: 'failure', category: 'tool_spawn_failure', source: 'harness' });
  });

  it('17 · a missing toolchain executable is an environment failure', () => {
    const { derived } = run(pi('pnpm install', '/usr/bin/bash: line 1: pnpm: command not found\n\nCommand exited with code 127'));
    expect(derived).toMatchObject({ outcome: 'failure', category: 'missing_dependency', source: 'environment', signature: 'bash | missing_dependency | pnpm' });
    expect(run(pi('node probe2.mjs', "node:internal/modules/cjs/loader:1433\nError: Cannot find module 'C:\\Users\\vocs\\AppData\\Local\\Temp\\vocs-audit\\probe2.mjs'\n\nCommand exited with code 1")).derived.category).toBe('invalid_path');
    expect(run(pi('node -e "require(\'left-pad\')"', "Error: Cannot find module 'left-pad'\n\nCommand exited with code 1")).derived).toMatchObject({ category: 'missing_dependency', signature: 'bash | missing_dependency | node | left-pad' });
  });

  it('18 · permission denied is an environment failure', () => {
    expect(run(pi('rm -rf /etc/x', "rm: cannot remove '/etc/x': Permission denied\n\nCommand exited with code 1")).derived).toMatchObject({ outcome: 'failure', category: 'permission_denied', source: 'environment' });
  });

  it('24 · aliases and casing collapse onto one physical tool and the right shell', () => {
    expect(physicalToolOf('Bash')).toBe('shell');
    expect(physicalToolOf('bash')).toBe('shell');
    expect(physicalToolOf('shell')).toBe('shell');
    expect(physicalToolOf('PowerShell')).toBe('shell');
    expect(physicalToolOf('Read')).toBe('read');
    expect(physicalToolOf('read_file')).toBe('read');
    expect(physicalToolOf('apply_patch')).toBe('patch');
    expect(physicalToolOf('mcp__gitnexus__query')).toBe('mcp');
    expect(physicalToolOf('gitnexus.list_repos')).toBe('mcp');
    expect(physicalToolOf('get_subagent_result')).toBe('agent');
    expect(physicalToolOf('agent.spawn', 'agent')).toBe('agent');
    expect(physicalToolOf('other', 'execute', { command: 'ls' })).toBe('shell');
    expect(run({ ...claude('Get-ChildItem', 'Exit code 1\nx'), tool: 'PowerShell' }).facts.shell).toBe('powershell');
    expect(run(codex('rg -n foo src', '', 1)).facts).toMatchObject({ shell: 'powershell', exitCollapsed: true, exitSource: 'harness', toolKey: 'shell' });
  });

  it('25 · a legacy record with neither output nor exit code is marked, never guessed', () => {
    const { facts, derived } = run(pi('some command', undefined));
    expect(facts.exitSource).toBe('none');
    expect(derived).toMatchObject({ outcome: 'unknown', category: 'legacy_unclassified', method: 'unknown', confidence: 'low' });
    expect(run(pi('some command', undefined, 'done')).derived.outcome).toBe('success');
    expect(run({ harness: 'pi', tool: 'edit', status: 'error', platform: 'win32' }).derived.category).toBe('legacy_unclassified');
  });

  it('reads Codex wrapper exits by what ran: silent search exit 1 is no-match, unreadable exit 1 stays unknown', () => {
    expect(run(codex('rg -n "Vocs-Code|left nav" C:\\Users\\vocs\\.codex', '', 1)).derived).toMatchObject({ outcome: 'informational', category: 'search_no_match', confidence: 'high' });
    expect(run(codex('rg -n -i "model" src | Select-Object -First 20', '', 1)).derived).toMatchObject({ outcome: 'informational', category: 'search_no_match' });
    expect(run(codex('$p = Join-Path $env:TEMP x; Get-Content $p', '', 1)).derived).toMatchObject({ outcome: 'unknown', category: 'process_nonzero_unknown', confidence: 'low' });
    expect(run(codex('rg -n foo src', 'src/a.ts:1:foo', 0)).derived.outcome).toBe('success');
  });

  it('charges bash idioms run by PowerShell to the model and flags the shell mismatch', () => {
    const { facts, derived } = run(codex('rg -n "CUSTOM" src | head -20', "head : The term 'head' is not recognized as the name of a cmdlet, function, script file, or operable program.\n    + FullyQualifiedErrorId : CommandNotFoundException", 1));
    expect(facts.cmd?.shellMismatch).toBe(true);
    expect(derived).toMatchObject({ outcome: 'failure', category: 'wrong_shell_syntax', source: 'model', confidence: 'high', signature: 'powershell | wrong_shell_syntax | rg | head' });
    expect(run(codex('rg -n "label" tests\\analytics*.test.ts', 'rg: tests\\analytics*.test.ts: The filename, directory name, or volume label syntax is incorrect. (os error 123)', 1)).derived).toMatchObject({ category: 'wrong_shell_syntax', signature: 'powershell | wrong_shell_syntax | rg | unexpanded-glob' });
    expect(run(codex("apply_patch <<'PATCH'\n*** Begin Patch\n*** End Patch\nPATCH", 'ParserError: \nLine |\n   2 |  apply_patch <<\'PATCH\'\n     | Missing file specification after redirection operator.', 1)).derived).toMatchObject({ category: 'wrong_shell_syntax' });
    expect(run(pi('Get-ChildItem Env:NODE_ENV | Format-Table -AutoSize', '/usr/bin/bash: line 1: Get-ChildItem: command not found\n/usr/bin/bash: line 1: Format-Table: command not found\n\nCommand exited with code 127')).derived).toMatchObject({ category: 'wrong_shell_syntax', source: 'model', signature: 'bash | wrong_shell_syntax | get-childitem' });
  });

  it('names malformed patches and PowerShell stderr artifacts', () => {
    expect(run(codex("$patch = @'\n*** Begin Patch\n'@; apply_patch $patch", "Invalid patch: The last line of the patch must be '*** End Patch'", 1)).derived).toMatchObject({ outcome: 'failure', category: 'malformed_patch', source: 'model' });
    expect(run(codex('git checkout master 2>&1', "node.exe : Switched to branch 'master'\nAt line:1 char:1\n+ & \"C:\\Program Files\\nodejs/node.exe\" ...\n    + CategoryInfo          : NotSpecified: (Switched to branch 'master':String) [], RemoteException", 1)).derived).toMatchObject({ outcome: 'unknown', category: 'shell_stderr_artifact', source: 'harness' });
  });

  it('treats a failure the command line tolerated as a negative probe', () => {
    expect(run(pi('ls src/renderer src/renderer/components 2>/dev/null', 'src/renderer:\nindex.html\nsrc\n\nCommand exited with code 2')).derived).toMatchObject({ outcome: 'informational', category: 'probe_negative', method: 'heuristic' });
    // Tolerance never hides a test result or a crash.
    expect(run(pi('npm test 2>/dev/null', 'Tests  2 failed | 5 passed (7)\n\nCommand exited with code 1')).derived.category).toBe('test_failures_reported');
  });

  it('classifies file, patch, MCP and unknown-tool errors from their messages', () => {
    const tool = (harness: string, name: string, output: string, input?: unknown): ExecutionInput => ({ harness, tool: name, status: 'error', output, input, platform: 'win32' });
    expect(run(tool('pi', 'edit', 'Could not find edits[0] in tests/pr.test.ts. The oldText must match exactly including all whitespace and newlines.', { path: 'tests/pr.test.ts' })).derived).toMatchObject({ outcome: 'failure', category: 'edit_target_not_found', source: 'model', signature: 'edit | edit_target_not_found | edit' });
    expect(run(tool('claude', 'Edit', '<tool_use_error>String to replace not found in file.\nString: foo</tool_use_error>')).derived.category).toBe('edit_target_not_found');
    expect(run(tool('pi', 'edit', 'Found 3 occurrences of the text in package.json. The text must be unique.')).derived.category).toBe('incorrect_tool_usage');
    expect(run(tool('pi', 'edit', 'Validation failed for tool "edit":\n  - edits.0: must be object')).derived.category).toBe('invalid_tool_arguments');
    expect(run(tool('pi', 'read', "ENOENT: no such file or directory, access 'G:\\repo\\tests\\artifacts\\x.png'", { path: 'tests/artifacts/x.png' })).derived).toMatchObject({ category: 'invalid_path', source: 'model' });
    expect(run(tool('pi', 'read', 'Offset 500 is beyond end of file (120 lines total)')).derived.category).toBe('invalid_argument');
    expect(run(tool('codex', 'apply_patch', "Invalid patch: The last line of the patch must be '*** End Patch'")).derived.category).toBe('malformed_patch');
    expect(run(tool('pi', 'mcp__gitnexus__query', 'Error: No indexed repositories. Run: gitnexus analyze')).derived).toMatchObject({ category: 'tool_unavailable', source: 'environment' });
    expect(run(tool('pi', '', 'Tool  not found')).derived).toMatchObject({ category: 'unknown_tool_called', source: 'model' });
    expect(run(tool('native', 'bash', 'Tool-call arguments failed to parse; the tool did not run. Raw arguments: {', undefined)).derived.category).toBe('invalid_tool_arguments');
    expect(run(tool('pi', 'Agent', 'Subagent failed: model refused')).derived).toMatchObject({ category: 'subagent_failed', source: 'ambiguous' });
  });

  it('derives the same outcome from stored facts alone, so records can be reclassified', () => {
    const input = codex('rg -n "CUSTOM" src | head -20', "head : The term 'head' is not recognized as the name of a cmdlet, function, script file, or operable program.", 1);
    const facts = extractFacts(input);
    const roundTrip = JSON.parse(JSON.stringify(facts));
    expect(deriveOutcome(roundTrip)).toEqual(deriveOutcome(facts));
    expect(signatureOf(facts, 'wrong_shell_syntax', 'head')).toBe('powershell | wrong_shell_syntax | rg | head');
  });

  it('never stores raw output, only a bounded redacted excerpt and byte count', () => {
    const big = 'x'.repeat(50_000) + '\nError: SECRET_TOKEN=abcdefgh12345678\n\nCommand exited with code 1';
    const { facts } = run(pi('node x.js', big));
    expect(facts.outputBytes).toBe(big.length);
    expect(facts.excerpt!.length).toBeLessThanOrEqual(400);
    expect(facts.excerpt).not.toContain('abcdefgh12345678');
    expect(JSON.stringify(facts)).not.toContain('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });
});
