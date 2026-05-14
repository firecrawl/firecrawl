import { startHttpServer, startStdioServer } from '../src/server.js';

const useHttp = process.env.MCP_HTTP === 'true';

const start = useHttp ? startHttpServer : startStdioServer;

start().catch((err) => {
  console.error('[fire-enrich-mcp] Fatal error:', err);
  process.exit(1);
});
