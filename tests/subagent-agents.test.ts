/**
 * Offline tests for subagent type discovery. The rules that matter: a project file beats a global
 * file beats a built-in, Claude Code's directory is honored, and a bad file can never take the whole
 * discovery down (a subagent spawn must not fail because one file is malformed).
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_AGENTS,
  buildSystemPrompt,
  discoverAgents,
  findAgent,
  parseAgentFile,
  parseFrontmatter,
  resolveAgentDir,
  toolNamesFor
} from '../resources/pi/subagent-agents';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-subagents-'));
  tempDirs.push(dir);
  return dir;
}

async function writeFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

describe('frontmatter parsing', () => {
  it('reads quoted values containing colons and skips comments', () => {
    const { fields, body } = parseFrontmatter(["---", "# managed", "name: Explore", "description: 'Find code: fast'", "---", "Body line"].join('\n'));
    expect(fields.name).toBe('Explore');
    expect(fields.description).toBe('Find code: fast');
    expect(body).toBe('Body line');
  });

  it('joins folded and literal blocks', () => {
    const folded = parseFrontmatter(['---', 'description: >', '  first part', '  second part', '---', ''].join('\n'));
    expect(folded.fields.description).toBe('first part second part');
    const literal = parseFrontmatter(['---', 'description: |', '  line one', '  line two', '---', ''].join('\n'));
    expect(literal.fields.description).toBe('line one\nline two');
  });

  it('treats a file without frontmatter as all body', () => {
    const parsed = parseFrontmatter('Just a prompt');
    expect(parsed.fields).toEqual({});
    expect(parsed.body).toBe('Just a prompt');
  });
});

describe('agent files', () => {
  it('parses tools, model, prompt mode, mcp and body', () => {
    const agent = parseAgentFile(
      [
        '---',
        'name: reviewer',
        'description: Reviews diffs',
        'tools: read, grep, bash, teleport',
        'model: openai/gpt-5.1-codex',
        'prompt_mode: replace',
        'mcp: false',
        '---',
        'You review diffs.',
      ].join('\n'),
      '/repo/.pi/agents/reviewer.md'
    );
    expect(agent).toMatchObject({
      name: 'reviewer',
      description: 'Reviews diffs',
      tools: ['read', 'grep', 'bash', 'teleport'],
      promptMode: 'replace',
      model: { provider: 'openai', model: 'gpt-5.1-codex' },
      mcp: false,
      source: '/repo/.pi/agents/reviewer.md',
    });
    expect(agent?.prompt).toBe('You review diffs.');
  });

  it('defaults to inherit-the-model, append mode and every tool', () => {
    const agent = parseAgentFile(['---', 'name: helper', '---', 'Help out.'].join('\n'));
    expect(agent).toMatchObject({ name: 'helper', promptMode: 'append', mcp: true });
    expect(agent?.model).toBeUndefined();
    expect(agent?.tools).toContain('edit');
    if (process.platform !== 'win32') expect(agent?.tools).not.toContain('powershell');
  });

  it('rejects a file with no name', () => {
    expect(parseAgentFile('---\ndescription: nothing\n---\nbody')).toBeNull();
  });

  it('filters tools to what pi actually has on this platform', () => {
    const agent = parseAgentFile('---\nname: x\ntools: read, teleport, powershell\n---\nbody');
    const tools = toolNamesFor(agent!);
    expect(tools).toContain('read');
    expect(tools).not.toContain('teleport');
    if (process.platform !== 'win32') expect(tools).not.toContain('powershell');
  });

  it('falls back to a read-only set when a file names no usable tool', () => {
    const agent = parseAgentFile('---\nname: x\ntools: teleport, hover\n---\nbody');
    expect(toolNamesFor(agent!)).toEqual(['read', 'grep', 'find', 'ls']);
  });
});

describe('discovery precedence', () => {
  it('prefers project over global over built-in, and .pi over .claude', async () => {
    const dir = await tempDir();
    const cwd = path.join(dir, 'repo');
    const home = path.join(dir, 'home');
    const agentDir = path.join(home, '.pi', 'agent');
    await writeFile(path.join(cwd, '.pi', 'agents', 'Explore.md'), '---\nname: Explore\n---\nPROJECT_PI');
    await writeFile(path.join(cwd, '.claude', 'agents', 'Explore.md'), '---\nname: Explore\n---\nPROJECT_CLAUDE');
    await writeFile(path.join(agentDir, 'agents', 'Explore.md'), '---\nname: Explore\n---\nGLOBAL_PI');
    await writeFile(path.join(home, '.claude', 'agents', 'Explore.md'), '---\nname: Explore\n---\nGLOBAL_CLAUDE');
    await writeFile(path.join(cwd, '.pi', 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nREVIEW');
    const agents = await discoverAgents({ cwd, agentDir, home });
    expect(findAgent(agents, 'Explore')?.prompt).toBe('PROJECT_PI');
    expect(findAgent(agents, 'reviewer')?.prompt).toBe('REVIEW');
    expect(findAgent(agents, 'general-purpose')?.source).toBe('builtin');
    expect(findAgent(agents, 'EXPLORE')?.prompt).toBe('PROJECT_PI');
  });

  it('falls back to each lower-precedence directory in turn', async () => {
    const dir = await tempDir();
    const cwd = path.join(dir, 'repo');
    const home = path.join(dir, 'home');
    const agentDir = path.join(home, '.pi', 'agent');
    await writeFile(path.join(cwd, '.claude', 'agents', 'Explore.md'), '---\nname: Explore\n---\nPROJECT_CLAUDE');
    await writeFile(path.join(home, '.claude', 'agents', 'Explore.md'), '---\nname: Explore\n---\nGLOBAL_CLAUDE');
    let agents = await discoverAgents({ cwd, agentDir, home });
    expect(findAgent(agents, 'Explore')?.prompt).toBe('PROJECT_CLAUDE');
    await fs.rm(path.join(cwd, '.claude'), { recursive: true, force: true });
    agents = await discoverAgents({ cwd, agentDir, home });
    expect(findAgent(agents, 'Explore')?.prompt).toBe('GLOBAL_CLAUDE');
    await fs.rm(path.join(home, '.claude'), { recursive: true, force: true });
    agents = await discoverAgents({ cwd, agentDir, home });
    expect(findAgent(agents, 'Explore')?.source).toBe('builtin');
  });

  it('ships the three Claude Code agents and survives an unreadable file', async () => {
    const dir = await tempDir();
    const cwd = path.join(dir, 'repo');
    const home = path.join(dir, 'home');
    await writeFile(path.join(cwd, '.pi', 'agents', 'broken.md'), 'not frontmatter at all');
    await fs.mkdir(path.join(cwd, '.pi', 'agents', 'dir.md'), { recursive: true }); // readdir entry that is not a file
    const agents = await discoverAgents({ cwd, agentDir: path.join(home, '.pi', 'agent'), home });
    expect(agents.map((a) => a.name).sort()).toEqual(['Explore', 'Plan', 'general-purpose']);
    expect(BUILTIN_AGENTS).toHaveLength(3);
  });

  it('keeps Explore read-only and Plan write-free', async () => {
    const dir = await tempDir();
    const agents = await discoverAgents({ cwd: path.join(dir, 'repo'), agentDir: path.join(dir, 'agent'), home: dir });
    const explore = findAgent(agents, 'Explore')!;
    expect(explore.tools).not.toContain('edit');
    expect(explore.tools).not.toContain('write');
    expect(explore.mcp).toBe(false);
    const plan = findAgent(agents, 'Plan')!;
    expect(plan.tools).not.toContain('edit');
  });

  it('honors PI_CODING_AGENT_DIR for the global agent directory', () => {
    const home = path.join(os.tmpdir(), 'vocs-home');
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: '~/custom' }, home)).toBe(path.join(home, 'custom'));
    expect(resolveAgentDir({}, home)).toBe(path.join(home, '.pi', 'agent'));
  });
});

describe('system prompt assembly', () => {
  it('replaces the parent prompt for replace-mode agents', () => {
    const agent = { ...BUILTIN_AGENTS[1]!, promptMode: 'replace' as const, prompt: 'ROLE' };
    expect(buildSystemPrompt(agent, 'PARENT')).toBe('ROLE');
  });

  it('extends the parent prompt for append-mode agents', () => {
    const agent = { ...BUILTIN_AGENTS[0]!, promptMode: 'append' as const, prompt: 'ROLE' };
    expect(buildSystemPrompt(agent, 'PARENT')).toBe('PARENT\n\n# Your role\nROLE');
    expect(buildSystemPrompt(agent, '  ')).toBe('ROLE');
  });
});
