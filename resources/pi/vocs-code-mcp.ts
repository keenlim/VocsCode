/**
 * Vocs Code MCP bridge extension for pi (loaded with `pi -e <this file>`).
 *
 * pi has no MCP support, so this extension reads a JSON config path from
 * VOCS_CODE_MCP_CONFIG, connects to each server with the dependency-free client in
 * ./mcp-client, and registers every MCP tool with pi as `mcp__<server>__<tool>`. A server
 * that fails to connect or list tools is skipped with a line on stderr (the app surfaces pi
 * stderr); the remaining servers still load.
 *
 * Config shape: { "servers": PiMcpServerConfig[] }
 */

import { readFileSync } from 'node:fs';
import { PiMcpConnection, type PiMcpServerConfig, type PiMcpTool } from './mcp-client';

interface PiToolResult {
  content: { type: string; text?: string }[];
  details?: Record<string, unknown>;
}

interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: object;
  execute(id: string, params: Record<string, unknown>): Promise<PiToolResult>;
}

interface PiLike {
  registerTool(def: PiToolDefinition): void;
  on(event: string, handler: (event: any, ctx: any) => unknown): void;
}

/** A pi/OpenAI-safe name segment: lowercase, `[a-z0-9_]` only, no leading digit. */
export function sanitizeToolName(name: string): string {
  const mapped = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_');
  const body = mapped || '_';
  return /^[0-9]/.test(body) ? '_' + body : body;
}

export function toolNameFor(serverId: string, toolName: string): string {
  return 'mcp__' + sanitizeToolName(serverId) + '__' + sanitizeToolName(toolName);
}

/** Normalizes an untrusted parsed config, dropping anything missing its transport's required fields. */
export function parseMcpConfig(json: unknown): PiMcpServerConfig[] {
  if (!json || typeof json !== 'object') return [];
  const raw = (json as { servers?: unknown }).servers;
  if (!Array.isArray(raw)) return [];
  const servers: PiMcpServerConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined;
    const transport = item.transport;
    if (!id) continue;
    if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') continue;
    const command = typeof item.command === 'string' && item.command.trim() ? item.command : undefined;
    const url = typeof item.url === 'string' && item.url.trim() ? item.url : undefined;
    if (transport === 'stdio' && !command) continue;
    if (transport !== 'stdio' && !url) continue;
    const cfg: PiMcpServerConfig = { id, transport };
    if (command) cfg.command = command;
    if (url) cfg.url = url;
    const args = stringArray(item.args);
    if (args) cfg.args = args;
    const env = stringRecord(item.env);
    if (env) cfg.env = env;
    const headers = stringRecord(item.headers);
    if (headers) cfg.headers = headers;
    if (typeof item.timeoutMs === 'number' && Number.isFinite(item.timeoutMs) && item.timeoutMs > 0) cfg.timeoutMs = item.timeoutMs;
    servers.push(cfg);
  }
  return servers;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function vocsCodeMcp(pi: PiLike): Promise<void> {
  const configPath = process.env.VOCS_CODE_MCP_CONFIG;
  if (!configPath) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error(`[vocs-code-mcp] cannot read MCP config at ${configPath}: ${errorText(error)}`);
    return;
  }

  const connections: PiMcpConnection[] = [];
  for (const cfg of parseMcpConfig(parsed)) {
    let connection: PiMcpConnection;
    try {
      connection = await PiMcpConnection.connect(cfg);
    } catch (error) {
      console.error(`[vocs-code-mcp] skipping MCP server "${cfg.id}": ${errorText(error)}`);
      continue;
    }
    connections.push(connection);

    let tools: PiMcpTool[];
    try {
      tools = await connection.listTools();
    } catch (error) {
      console.error(`[vocs-code-mcp] listing tools for MCP server "${cfg.id}" failed: ${errorText(error)}`);
      continue;
    }

    for (const tool of tools) {
      pi.registerTool({
        name: toolNameFor(cfg.id, tool.name),
        label: cfg.id + ': ' + tool.name,
        description: tool.description ?? 'MCP tool ' + tool.name + ' from ' + cfg.id,
        parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
        async execute(_id, params) {
          const result = await connection.callTool(tool.name, params ?? {});
          if (result.isError) {
            const text = result.content.map((part) => part.text ?? '').filter(Boolean).join('\n') || 'MCP tool ' + tool.name + ' failed';
            throw new Error(text);
          }
          return { content: result.content, details: { server: cfg.id, tool: tool.name } };
        }
      });
    }
  }

  pi.on('session_shutdown', () => {
    for (const connection of connections) {
      try {
        connection.close();
      } catch {
        /* a connection that already exited is fine */
      }
    }
  });
}
