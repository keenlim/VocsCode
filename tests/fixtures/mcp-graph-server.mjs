// A minimal MCP server over Streamable HTTP for tests/knowledge-anchors.test.ts. It answers the
// one GitNexus tool the anchor resolver calls (`context`) with the same JSON shape GitNexus returns,
// and prints `READY:<port>` plus one `CALL:context:<name>:<file>` line per call so a test can count
// round trips. Stateless: a fresh server+transport per request.
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const FOUND = {
  buildContext: { uid: 'Method:src/main/session-manager.ts:SessionManager.buildContext#2', name: 'buildContext', filePath: 'src/main/session-manager.ts', startLine: 520, endLine: 562 },
  movedSymbol: { uid: 'Function:src/main/elsewhere.ts:movedSymbol', name: 'movedSymbol', filePath: 'src/main/elsewhere.ts', startLine: 3, endLine: 9 }
};

function buildServer() {
  const server = new McpServer({ name: 'graph-fixture', version: '1.0.0' });
  server.registerTool(
    'context',
    { description: 'Resolve one symbol', inputSchema: { repo: z.string().optional(), name: z.string(), file: z.string().optional() } },
    async ({ name, file }) => {
      console.log(`CALL:context:${name}:${file ?? ''}`);
      const symbol = FOUND[name];
      if (symbol) return { content: [{ type: 'text', text: JSON.stringify({ status: 'found', symbol }) }] };
      return { content: [{ type: 'text', text: `${JSON.stringify({ error: `Symbol '${name}' not found` })}\n\n---\n**Next:** use context({name: "${name}"})` }] };
    }
  );
  return server;
}

const http = createServer(async (req, res) => {
  if (req.url !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});

http.listen(0, '127.0.0.1', () => {
  const address = http.address();
  console.log(`READY:${typeof address === 'object' && address ? address.port : 0}`);
});
