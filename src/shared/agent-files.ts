/**
 * The on-disk format of a subagent definition, shared by the app that edits them.
 *
 * The runtime reads the same format in `resources/pi/subagent-agents.ts` (it cannot import from here:
 * it is copied into the packaged app and loaded by pi). `tests/agent-files.test.ts` round-trips a
 * file through both so the two parsers cannot drift apart silently.
 */

/** Built-in tool names a definition may allow. `bash` stays permission-gated at run time. */
export const AGENT_TOOL_NAMES = ['read', 'write', 'edit', 'bash', 'powershell', 'grep', 'find', 'ls'] as const;

export interface AgentFileFields {
  name: string;
  description: string;
  tools: string[];
  /** `provider/model-id`; absent means the child inherits the session model. */
  model?: string;
  promptMode: 'append' | 'replace';
  /** Whether the child inherits the session's MCP servers. */
  mcp: boolean;
}

export interface ParsedAgentFile {
  fields: AgentFileFields;
  prompt: string;
}

/** A file name that can safely be turned into `<name>.md` inside the agents directory. */
export function isValidAgentName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && !name.includes('..');
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"');
  return v;
}

/** Quote a value for a single-line frontmatter field, preferring the style agent files use. */
function quote(value: string): string {
  if (!/[#:'"{}[\],&*?|<>=!%@`]/.test(value) && value.trim() === value && value !== '') return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Parse a definition file. Tolerant by design: unknown keys are ignored and a missing body is an
 * empty prompt, so a hand-edited file still opens in the editor. Returns null when it has no name.
 */
export function parseAgentFile(text: string): ParsedAgentFile | null {
  const fields: Record<string, string> = {};
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const firstLineEnd = normalized.indexOf('\n');
  if (firstLineEnd === -1 || normalized.slice(0, firstLineEnd).trim() !== '---') {
    return null; // a definition has to declare itself; a bare prompt is not one
  }
  const lines = normalized.split('\n');
  let index = 1;
  for (; index < lines.length; index++) {
    const line = lines[index] as string;
    if (line.trim() === '---') break;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    const raw = line.slice(colon + 1).trim();
    if (raw === '>' || raw === '>-' || raw === '|' || raw === '|-') {
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] as string;
        if (next.trim() !== '' && !/^\s/.test(next)) break;
        block.push(next.replace(/^\s{1,}/, ''));
        index++;
      }
      fields[key] = (raw.startsWith('|') ? block.join('\n') : block.join(' ')).trim();
      continue;
    }
    fields[key] = unquote(raw);
  }
  const name = (fields.name ?? '').trim();
  if (!name) return null;
  const declared = (fields.tools ?? '').trim();
  return {
    fields: {
      name,
      description: (fields.description ?? '').trim(),
      tools: !declared || declared === '*' ? [...AGENT_TOOL_NAMES] : declared.split(',').map((t) => t.trim()).filter(Boolean),
      ...(fields.model?.trim() ? { model: fields.model.trim() } : {}),
      promptMode: fields.prompt_mode?.trim().toLowerCase() === 'replace' ? 'replace' : 'append',
      mcp: fields.mcp?.trim().toLowerCase() !== 'false',
    },
    prompt: lines.slice(index + 1).join('\n').trim(),
  };
}

/** Write a definition back out. Field order matches the shipped templates, so diffs stay small. */
export function serializeAgentFile(fields: AgentFileFields, prompt: string, header?: string): string {
  const lines = ['---'];
  if (header) for (const line of header.split('\n')) lines.push(`# ${line}`);
  lines.push(`name: ${quote(fields.name)}`);
  lines.push(`description: ${quote(fields.description)}`);
  lines.push(`tools: ${fields.tools.join(', ')}`);
  if (fields.model) lines.push(`model: ${quote(fields.model)}`);
  lines.push(`prompt_mode: ${fields.promptMode}`);
  if (!fields.mcp) lines.push('mcp: false');
  lines.push('---', '');
  return `${lines.join('\n')}${prompt.trim()}\n`;
}
