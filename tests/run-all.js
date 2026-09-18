#!/usr/bin/env node
// Lance toutes les suites de tests/ les unes après les autres.
// Usage : node tests/run-all.js
// Code de sortie non-nul si au moins un test échoue (utilisable en CI).

const { execFileSync } = require('child_process');
const path = require('path');

const suites = [
  'test-agenda.js',
  'test-food-recipe.js',
  'test-security.js',
  'test-import-export.js',
];

let anyFailed = false;

for(const suite of suites){
  console.log(`\n--- ${suite} ---`);
  try {
    const output = execFileSync('node', [path.join(__dirname, suite)], { encoding: 'utf-8' });
    process.stdout.write(output);
  } catch(e){
    anyFailed = true;
    process.stdout.write(e.stdout || '');
    process.stderr.write(e.stderr || String(e));
  }
}

console.log(anyFailed ? '\n❌ Au moins une suite a échoué.' : '\n✅ Toutes les suites sont passées.');
process.exit(anyFailed ? 1 : 0);
