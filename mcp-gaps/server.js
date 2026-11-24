'use strict';
// heroku-ops-gaps: stdio MCP server with the tools the official Heroku MCP does not cover.
const fs = require('node:fs');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createHandlers, validateConfig } = require('./lib/tools');
const { toolDefinitions } = require('./lib/schemas');

function loadConfig() {
  const file = process.env.HEROKU_OPS_CONFIG || path.join(__dirname, '..', 'config.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Configuración inválida: no se pudo leer ${file}: ${e.message}`);
    process.exit(1);
  }
  const problems = validateConfig(cfg);
  if (problems.length > 0) {
    console.error(`Configuración inválida en ${file}:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  return cfg;
}

async function main() {
  const cfg = loadConfig();
  const handlers = createHandlers({ cfg, env: process.env, gitExe: process.env.HEROKU_OPS_TEST_GIT || 'git.exe' });

  const server = new McpServer({ name: 'heroku-ops-gaps', version: '1.0.0' });
  for (const [name, def] of Object.entries(toolDefinitions(cfg))) {
    server.registerTool(name, def, async (input) => handlers[name](input ?? {}));
  }
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(`Error al iniciar heroku-ops-gaps: ${e?.message ?? e}`);
  process.exit(1);
});
