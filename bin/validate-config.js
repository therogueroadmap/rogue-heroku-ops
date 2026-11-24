#!/usr/bin/env node
'use strict';
// Usage: node bin/validate-config.js <projectDir>
// Prints "OK <file>" (exit 0) or "INVALID <file>" plus one problem per line (exit 1).
const { loadProjectConfig } = require('../lib/config');

const r = loadProjectConfig(process.argv[2]);
if (r.ok) {
  console.log(`OK ${r.file}`);
} else {
  console.log(`INVALID ${r.file ?? '(no project directory)'}`);
  for (const p of r.problems) console.log(p);
  process.exitCode = 1;
}
