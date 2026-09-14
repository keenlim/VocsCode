/**
 * Offline tests for the project's definition files: the format the app writes, the git practice it
 * sets up, and the round-trip through the *runtime's* parser — the extension cannot import the app's
 * code, so this is what keeps the two from drifting.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_TOOL_NAMES, isValidAgentName, parseAgentFile, serializeAgentFile } from '../src/shared/agent-files';
import { AGENT_IGNORE_PATTERN, agentDir, deleteProjectAgent, listProjectAgents, readProjectAgent, saveProjectAgent, setProjectAgentTracked } from '../src/main/agent-files';
import { parseAgentFile as parseInRuntime } from '../resources/pi/subagent-agents';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-agent-files-'));
  tempDirs.push(dir);
  return dir;
}

const fields = {
  name: 'reviewer',
  description: 'Reviews a diff: checks the rules, cites lines',
  tools: ['read', 'grep'],
  promptMode: 'replace' as const,
  mcp: false,
};

describe('the file format', () => {
  it('round-trips through the app writer and the runtime parser', () => {
    const text = serializeAgentFile(fields, 'You review diffs.\nReport findings.');
    const inApp = parseAgentFile(text)!;
    const inRuntime = parseInRuntime(text)!;
    // Both readers see the same definition, which is the only reason writing files here is safe.
    // The app parses into { fields, prompt }; the runtime parses straight into its agent type.
    expect(inApp.fields).toMatchObject({ name: 'reviewer', description: fields.description, tools: ['read', 'grep'], promptMode: 'replace', mcp: false });
    expect(inApp.prompt).toBe('You review diffs.\nReport findings.');
    expect(inRuntime).toMatchObject({ name: 'reviewer', description: fields.description, tools: ['read', 'grep'], promptMode: 'replace', mcp: false, prompt: 'You review diffs.\nReport findings.' });
  });

  it('quotes values a parser could misread and omits an absent model', () => {
    const text = serializeAgentFile({ ...fields, description: "Checks: 'the' rules" }, 'body');
    expect(text).toContain("description: 'Checks: ''the'' rules'");
    expect(text).not.toContain('model:');
    expect(parseAgentFile(text)!.fields.description).toBe("Checks: 'the' rules");
  });

  it('keeps a pinned model when one is set', () => {
    const text = serializeAgentFile({ ...fields, model: 'anthropic/claude-opus-4-5' }, 'body');
    expect(parseAgentFile(text)!.fields.model).toBe('anthropic/claude-opus-4-5');
    // …and the runtime agrees, since a pin is respected there too.
    expect(parseInRuntime(text)!.model).toEqual({ provider: 'anthropic', model: 'claude-opus-4-5' });
  });

  it('treats every tool as allowed when the field is missing or a wildcard', () => {
    const noTools = ['---', 'name: x', '---', 'body'];
    expect(parseAgentFile(noTools.join('\n'))!.fields.tools).toEqual([...AGENT_TOOL_NAMES]);
    const wildcard = ['---', 'name: x', "tools: '*'", '---', 'body'];
    expect(parseAgentFile(wildcard.join('\n'))!.fields.tools).toEqual([...AGENT_TOOL_NAMES]);
  });

  it('rejects a file with no name and unsafe names', () => {
    expect(parseAgentFile('---\ndescription: nothing\n---\nbody')).toBeNull();
    expect(parseAgentFile('just a prompt')).toBeNull();
    for (const name of ['', '.hidden', '../escape', 'a/b', 'x'.repeat(65), 'name with space']) expect(isValidAgentName(name)).toBe(false);
    for (const name of ['reviewer', 'my-reviewer', 'harness_builder', 'pr2']) expect(isValidAgentName(name)).toBe(true);
  });
});

describe('the project set', () => {
  it('reports no definitions and no templates for a bare project', async () => {
    const dir = await tempDir();
    const info = await listProjectAgents(dir);
    expect(info.agents).toEqual([]);
    expect(info.templates).toEqual([]);
  });

  it('writes a definition, ignores new ones by default, and reads it back', async () => {
    const dir = await tempDir();
    const saved = await saveProjectAgent(dir, fields, 'You review diffs.');
    expect(saved.ok).toBe(true);
    expect(saved.path).toBe(path.join(agentDir(dir), 'reviewer.md'));

    const ignore = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(ignore).toContain(AGENT_IGNORE_PATTERN);
    expect(ignore).toContain('Vocs Code subagent definitions');

    const info = await listProjectAgents(dir);
    expect(info.ignored).toBe(true);
    expect(info.agents).toHaveLength(1);
    expect(info.agents[0]).toMatchObject({ name: 'reviewer', tools: ['read', 'grep'], promptMode: 'replace', mcp: false, tracked: false });

    const parsed = await readProjectAgent(dir, 'reviewer');
    expect(parsed!.prompt).toBe('You review diffs.');
  });

  it('appends the ignore rule to an existing .gitignore exactly once', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules\ndist', 'utf8');
    await saveProjectAgent(dir, fields, 'body');
    await saveProjectAgent(dir, { ...fields, name: 'other', description: 'Other' }, 'body');
    const ignore = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(ignore.startsWith('node_modules\ndist\n')).toBe(true);
    expect(ignore.split('\n').filter((line) => line.trim() === AGENT_IGNORE_PATTERN)).toHaveLength(1);
  });

  it('tracks one definition for the team and untracks it again', async () => {
    const dir = await tempDir();
    await saveProjectAgent(dir, fields, 'body');
    await setProjectAgentTracked(dir, 'reviewer', true);
    let ignore = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    // The negative rule only works because the pattern ignores files, not the directory.
    expect(ignore).toContain(`!.pi/agents/reviewer.md`);
    expect(ignore).toContain(AGENT_IGNORE_PATTERN);

    await setProjectAgentTracked(dir, 'reviewer', false);
    ignore = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(ignore).not.toContain('!.pi/agents/reviewer.md');
    expect(ignore).toContain(AGENT_IGNORE_PATTERN);
  });

  it('deletes a definition and its track rule', async () => {
    const dir = await tempDir();
    await saveProjectAgent(dir, fields, 'body');
    await setProjectAgentTracked(dir, 'reviewer', true);
    expect((await deleteProjectAgent(dir, 'reviewer')).ok).toBe(true);
    expect(await readProjectAgent(dir, 'reviewer')).toBeNull();
    expect((await listProjectAgents(dir)).agents).toEqual([]);
    expect(await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).not.toContain('!.pi/agents/reviewer.md');
  });

  it('refuses a definition without a description or tools, and never escapes the folder', async () => {
    const dir = await tempDir();
    expect(await saveProjectAgent(dir, { ...fields, description: '  ' }, 'body')).toMatchObject({ ok: false });
    expect(await saveProjectAgent(dir, { ...fields, tools: ['teleport'] }, 'body')).toMatchObject({ ok: false });
    expect(await saveProjectAgent(dir, { ...fields, name: '../escape' }, 'body')).toMatchObject({ ok: false });
    expect(await readProjectAgent(dir, '../escape')).toBeNull();
    expect(await deleteProjectAgent(dir, '../escape')).toMatchObject({ ok: false });
    expect(await setProjectAgentTracked(dir, '../escape', true)).toMatchObject({ ok: false });
    // A refused save leaves nothing behind: no file, and no .gitignore for a project with no agents.
    await expect(fs.readdir(agentDir(dir))).rejects.toThrow();
  });

  it('offers the shipped templates without copying them', async () => {
    const dir = await tempDir();
    const info = await listProjectAgents(dir, path.join(__dirname, '..', 'resources', 'pi', 'agents'));
    expect(info.templates.map((t) => t.name).sort()).toEqual(['Explore', 'Plan', 'general-purpose']);
    expect(info.templates.every((t) => t.prompt.length > 0)).toBe(true);
    expect(info.agents).toEqual([]);
  });
});
