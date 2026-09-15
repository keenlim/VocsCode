/**
 * The project's Claude Code agent definitions: reading them, and setting the one field this app owns.
 *
 * Claude Code reads `<projectRoot>/.claude/agents/*.md`, and a definition whose `name:` matches a
 * built-in (`Explore`, `Plan`) *replaces* that built-in — the built-in's own instructions are gone,
 * verified against the bundled CLI. So this module never creates a definition: it lists what the
 * project has and rewrites the `model:` line of one that is already there, leaving every other byte
 * as its author left it. Pinning a model is the user's deliberate act, not something the app does
 * on their behalf.
 *
 * The `model:` line is also what the adapter reads back: a project that pins a model anywhere cannot
 * be overridden wholesale by `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (the CLI lets FORCE outrank a
 * definition), so the harness withholds FORCE for as long as a pin exists.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { isValidAgentName } from '../shared/agent-files';
import { parseClaudeAgentFile, withClaudeAgentModel, type ClaudeAgentFileInfo } from '../shared/claude-agent-files';

export const CLAUDE_AGENT_DIR = path.join('.claude', 'agents');

export function claudeAgentDir(projectRoot: string): string {
  return path.join(projectRoot, CLAUDE_AGENT_DIR);
}

/** One definition file resolved to what the panel and the adapter need from it. */
interface ResolvedAgentFile extends ClaudeAgentFileInfo {
  text: string;
}

async function readAgentFiles(projectRoot: string): Promise<ResolvedAgentFile[]> {
  const dir = claudeAgentDir(projectRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return []; // no directory is the ordinary case: the project defines nothing
  }
  const files: ResolvedAgentFile[] = [];
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith('.md')) continue;
    const file = path.join(dir, entry);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseClaudeAgentFile(text);
    // A file with no frontmatter is not a definition; the CLI ignores it too, so the panel does.
    if (!parsed) continue;
    files.push({ ...parsed.fields, path: file, text });
  }
  return files;
}

/** Every Claude agent definition the project has, for the panel's rows. */
export async function listClaudeAgents(projectRoot: string): Promise<ClaudeAgentFileInfo[]> {
  return (await readAgentFiles(projectRoot)).map(({ text: _text, ...info }) => info);
}

/**
 * Whether the project pins a model for any agent. A pin is a concrete model id — `inherit` restates
 * the default and asks for nothing, so it does not count.
 */
export async function hasClaudeAgentPins(projectRoot: string): Promise<boolean> {
  return (await readAgentFiles(projectRoot)).some((info) => isPinnedModel(info.model));
}

export function isPinnedModel(model: string | undefined): boolean {
  const value = model?.trim();
  return Boolean(value) && value !== 'inherit';
}

/**
 * Set (or with `undefined`, clear) the model one definition pins. Only an existing file is touched:
 * creating one would silently replace a built-in and take its instructions with it.
 */
export async function setClaudeAgentModel(projectRoot: string, name: string, model: string | undefined): Promise<{ ok: boolean; error?: string }> {
  if (!isValidAgentName(name)) return { ok: false, error: 'Invalid agent type.' };
  const file = (await readAgentFiles(projectRoot)).find((info) => info.name === name);
  if (!file) return { ok: false, error: `This project has no ${name} definition to change.` };
  const next = withClaudeAgentModel(file.text, model?.trim() || undefined);
  if (next === null) return { ok: false, error: `${name} has no frontmatter to edit.` };
  if (next === file.text) return { ok: true };
  try {
    await fs.writeFile(file.path, next, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
