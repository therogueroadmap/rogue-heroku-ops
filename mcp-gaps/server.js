'use strict';
// heroku-ops-gaps: stdio MCP server with the tools the official Heroku MCP does not cover.
// It starts even when the project config is missing or invalid: every tool is registered and the
// ones that need the config answer with the problems and the setup hint instead.
const fs = require('node:fs');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createHandlers } = require('./lib/tools');
const { toolDefinitions } = require('./lib/schemas');
const { loadProjectConfig } = require('../lib/config');

async function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  // Claude Code may pass no value or an unexpanded literal "${CLAUDE_PLUGIN_ROOT}", so trust the
  // variable only when it points at a real plugin root; otherwise use the root this code lives in.
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const pluginRoot = envRoot && fs.existsSync(path.join(envRoot, 'procedures')) ? envRoot : path.join(__dirname, '..');
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
