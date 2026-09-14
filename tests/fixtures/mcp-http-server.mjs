/**
 * A stand-in for `gitnexus serve`: an MCP endpoint over Streamable HTTP that answers the single
 * request SharedGitnexusServer uses to decide the server is up. Offline, no dependencies, and no
 * behaviour beyond `--port` / `--host`, so the only thing under test is how it was spawned.
 */
import http from 'node:http';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const port = Number(flag('--port') ?? 0);
const host = flag('--host') ?? '127.0.0.1';

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    let id = null;
    try {
      id = JSON.parse(body).id ?? null;
    } catch {
      /* answer with a null id rather than dying */
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture-serve', version: '1.0.0' } }
      })
    );
  });
});

server.listen(port, host, () => {
  console.log(`fixture serving MCP on http://${host}:${port}/api/mcp`);
});
