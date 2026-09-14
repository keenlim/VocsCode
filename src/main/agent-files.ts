/**
 * The project's subagent definitions: reading, writing, and the git practice around them.
 *
 * Definitions are project knowledge, but they are also personal workflow, so Vocs Code writes them
 * into the repo and asks git to ignore them: `.pi/agents/*` goes into the repo's `.gitignore` once,
 * and a single definition can be un-ignored ("track it") when the whole team should share it.
 * Nothing here touches the network or a harness; the project root comes from the session.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { AGENT_TOOL_NAMES, isValidAgentName, parseAgentFile, serializeAgentFile, type AgentFileFields, type ParsedAgentFile } from '../shared/agent-files';
import type { AgentTemplate, ProjectAgent, ProjectAgentInfo } from '../shared/agent-info';

export const AGENT_DIR = path.join('.pi', 'agents');
/** The ignore line: files, not the directory, so `!.pi/agents/<name>.md` can re-include one. */
export const AGENT_IGNORE_PATTERN = '.pi/agents/*';
const IGNORE_HEADER = '# Vocs Code subagent definitions (local; remove a line below to commit that agent)';


export function agentDir(projectRoot: string): string {
  return path.join(projectRoot, AGENT_DIR);
}

function agentFile(projectRoot: string, name: string): string | null {
  if (!isValidAgentName(name)) return null;
  const dir = agentDir(projectRoot);
  const file = path.join(dir, `${name}.md`);
  // Defence in depth: the name is already a safe file name, and the path must stay inside the folder.
  return path.dirname(path.resolve(file)) === path.resolve(dir) ? file : null;
}

function git(projectRoot: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: projectRoot, timeout: 5_000, windowsHide: true }, (error, stdout) => {
      resolve({ code: error ? 1 : 0, stdout: String(stdout ?? '') });
    });
  });
}

async function readGitFile(projectRoot: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');
  } catch {
    return null;
  }
}

/** Every definition in the project, with the git state the UI shows next to it. */
export async function listProjectAgents(projectRoot: string, templateDir?: string): Promise<ProjectAgentInfo> {
  const dir = agentDir(projectRoot);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    entries = [];
  }
  const ignoreFile = await readGitFile(projectRoot);
  const ignored = ignoreFile?.split('\n').some((line) => line.trim() === AGENT_IGNORE_PATTERN) ?? false;
  const inRepo = (await git(projectRoot, ['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true';
  const agents: ProjectAgent[] = [];
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith('.md')) continue;
    const file = path.join(dir, entry);
    let parsed: ParsedAgentFile | null = null;
    try {
      parsed = parseAgentFile(await fs.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (!parsed) continue;
    const relative = `${AGENT_DIR.replace(/\\/g, '/')}/${entry}`;
    const [trackedResult, ignoredResult] = inRepo
      ? await Promise.all([git(projectRoot, ['ls-files', '--error-unmatch', relative]), git(projectRoot, ['check-ignore', '-q', relative])])
      : [{ code: 1 }, { code: 1 }];
    agents.push({ ...parsed.fields, path: file, tracked: trackedResult.code === 0, ignored: ignoredResult.code === 0 });
  }
  return { agents, templates: await readTemplates(templateDir), git: inRepo, ignored };
}

/** The definitions Vocs Code ships, offered as starting points rather than as project files. */
export async function readTemplates(templateDir: string | undefined): Promise<AgentTemplate[]> {
  if (!templateDir) return [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(templateDir);
  } catch {
    return [];
  }
  const templates: AgentTemplate[] = [];
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith('.md')) continue;
    const file = path.join(templateDir, entry);
    try {
      const parsed = parseAgentFile(await fs.readFile(file, 'utf8'));
      if (parsed) templates.push({ ...parsed.fields, prompt: parsed.prompt, source: file });
    } catch {
      /* unreadable template: skip it */
    }
  }
  return templates;
}

export async function readProjectAgent(projectRoot: string, name: string): Promise<ParsedAgentFile | null> {
  const file = agentFile(projectRoot, name);
  if (!file) return null;
  try {
    return parseAgentFile(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Writes or overwrites a definition, and puts the project's ignore rule in place the first time. */
export async function saveProjectAgent(projectRoot: string, fields: AgentFileFields, prompt: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!isValidAgentName(fields.name)) return { ok: false, error: 'A definition needs a name of letters, digits, dot, dash or underscore.' };
  if (!fields.description.trim()) return { ok: false, error: 'A description is required: the model chooses a subagent by it.' };
  const file = agentFile(projectRoot, fields.name);
  if (!file) return { ok: false, error: 'Invalid definition name.' };
  const tools = fields.tools.filter((tool) => (AGENT_TOOL_NAMES as readonly string[]).includes(tool));
  if (!tools.length) return { ok: false, error: 'A definition needs at least one tool.' };
  try {
    await fs.mkdir(agentDir(projectRoot), { recursive: true });
    await fs.writeFile(file, serializeAgentFile({ ...fields, tools }, prompt, 'Managed by Vocs Code — edit it here or in the Subagents panel.'), 'utf8');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // Keep what is not shared out of everyone else's `git status`.
  const tracked = (await listTrackedLine(projectRoot, fields.name)) !== null;
  if (!tracked) await ensureIgnored(projectRoot);
  return { ok: true, path: file };
}

export async function deleteProjectAgent(projectRoot: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const file = agentFile(projectRoot, name);
  if (!file) return { ok: false, error: 'Invalid definition name.' };
  try {
    await fs.unlink(file);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  await removeTrackLine(projectRoot, name);
  return { ok: true };
}

/**
 * Share one definition with the repo, or keep it local again. Tracking un-ignores the single file and
 * stages nothing: committing stays the user's call, visible in the Changes panel like any other file.
 */
export async function setProjectAgentTracked(projectRoot: string, name: string, tracked: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!isValidAgentName(name)) return { ok: false, error: 'Invalid definition name.' };
  if (tracked) {
    const removed = await removeTrackLine(projectRoot, name);
    await ensureIgnored(projectRoot); // the negative rule only works inside an ignored folder
    await appendIgnoreLine(projectRoot, `!${AGENT_DIR.replace(/\\/g, '/')}/${name}.md`);
    void removed;
  } else {
    await removeTrackLine(projectRoot, name);
    await ensureIgnored(projectRoot);
  }
  return { ok: true };
}

async function listTrackedLine(projectRoot: string, name: string): Promise<string | null> {
  const text = await readGitFile(projectRoot);
  if (!text) return null;
  const wanted = `!${AGENT_DIR.replace(/\\/g, '/')}/${name}.md`;
  return text.split('\n').some((line) => line.trim() === wanted) ? wanted : null;
}

async function ensureIgnored(projectRoot: string): Promise<void> {
  const text = await readGitFile(projectRoot);
  if (text === null) {
    await fs.writeFile(path.join(projectRoot, '.gitignore'), `${IGNORE_HEADER}\n${AGENT_IGNORE_PATTERN}\n`, 'utf8');
    return;
  }
  if (text.split('\n').some((line) => line.trim() === AGENT_IGNORE_PATTERN)) return;
  const suffix = text.endsWith('\n') || text === '' ? '' : '\n';
  await fs.writeFile(path.join(projectRoot, '.gitignore'), `${text}${suffix}\n${IGNORE_HEADER}\n${AGENT_IGNORE_PATTERN}\n`, 'utf8');
}

async function appendIgnoreLine(projectRoot: string, line: string): Promise<void> {
  const text = (await readGitFile(projectRoot)) ?? '';
  if (text.split('\n').some((existing) => existing.trim() === line)) return;
  const suffix = text.endsWith('\n') || text === '' ? '' : '\n';
  await fs.writeFile(path.join(projectRoot, '.gitignore'), `${text}${suffix}${line}\n`, 'utf8');
}

async function removeTrackLine(projectRoot: string, name: string): Promise<boolean> {
  const text = await readGitFile(projectRoot);
  if (!text) return false;
  const wanted = `!${AGENT_DIR.replace(/\\/g, '/')}/${name}.md`;
  if (!text.split('\n').some((line) => line.trim() === wanted)) return false;
  const next = text.split('\n').filter((line) => line.trim() !== wanted).join('\n');
  await fs.writeFile(path.join(projectRoot, '.gitignore'), next, 'utf8');
  return true;
}
