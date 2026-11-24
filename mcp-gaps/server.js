'use strict';
// heroku-ops-gaps: stdio MCP server with the tools the official Heroku MCP does not cover.
// It starts even when the project config is missing or invalid: every tool is registered and the
// ones that need the config answer with the problems and the setup hint instead.
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createHandlers } = require('./lib/tools');
const { toolDefinitions } = require('./lib/schemas');
const { loadProjectConfig } = require('../lib/config');

async function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
  const loaded = loadProjectConfig(projectDir);
  if (!loaded.ok) console.error(`Project config problems:\n- ${loaded.problems.join('\n- ')}`);
  const handlers = createHandlers({
    projectDir, pluginRoot, env: process.env, gitExe: process.env.HEROKU_OPS_TEST_GIT || 'git',
  });

  const server = new McpServer({ name: 'heroku-ops-gaps', version: '1.0.0' });
  for (const [name, def] of Object.entries(toolDefinitions(loaded.ok ? loaded.config : null))) {
    server.registerTool(name, def, async (input) => handlers[name](input ?? {}));
  }
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(`Failed to start heroku-ops-gaps: ${e?.message ?? e}`);
  process.exit(1);
});
