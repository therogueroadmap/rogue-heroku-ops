'use strict';
// PostToolUse hook: appends one JSON line per tool call to
// ${CLAUDE_PLUGIN_DATA}/audit/audit-YYYY-MM.jsonl (UTC month).
// Auditing never blocks: always exit 0, never write to stdout. Without CLAUDE_PLUGIN_DATA nothing is written.

const fs = require('node:fs');
const path = require('node:path');

try {
  // Inside the try: a missing lib/ must not crash the hook.
  const { buildAuditEntry, auditFile } = require('./lib/audit-entry.js');
  const raw = fs.readFileSync(0, 'utf8');
  const input = JSON.parse(raw);
  const entry = buildAuditEntry(input, new Date());
  const file = auditFile(process.env, entry.ts);
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  }
} catch (_e) {
  // swallowed on purpose: the audit must never block the agent
}
process.exit(0);
