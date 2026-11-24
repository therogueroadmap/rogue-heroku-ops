'use strict';
// PostToolUse hook: appends one JSON line per tool call to audit/audit-YYYY-MM.jsonl (UTC month).
// Auditing never blocks: always exit 0, never write to stdout.
// HEROKU_OPS_AUDIT_DIR overrides the output directory (used by tests).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

try {
  // Inside the try: a missing lib/ must not crash the hook.
  const { buildAuditEntry } = require('./lib/audit-entry.js');
  const raw = fs.readFileSync(0, 'utf8');
  const input = JSON.parse(raw);
  // --only-agent <name>: ignore calls from any other agent.
  // A missing or flag-like value disables the filter (audit everything).
  const i = process.argv.indexOf('--only-agent');
  const only = i === -1 ? undefined : process.argv[i + 1];
  if (only && !only.startsWith('--') && (!input || input.agent_type !== only)) process.exit(0);
  const entry = buildAuditEntry(input, new Date());
  const dir = process.env.HEROKU_OPS_AUDIT_DIR || path.join(ROOT, 'audit');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `audit-${entry.ts.slice(0, 7)}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
} catch (_e) {
  // swallowed on purpose: the audit must never block the agent
}
process.exit(0);
