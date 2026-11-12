// Proves the Supabase migrations carry the source schemas exactly: every
// CREATE TABLE block and CREATE INDEX statement in schema/*.sql must appear
// byte-for-byte (modulo whitespace) in the matching migration. Read-only.
// Run: node dev-tools/check-supabase-migrations.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

const stripComments = sql => sql.replace(/--[^\n]*/g, '');

function tables(sql) {
  const out = new Map();
  for (const m of sql.matchAll(/CREATE TABLE (app\.\w+) \(([\s\S]*?)\n\);/g)) {
    out.set(m[1], m[2].replace(/\s+/g, ' ').trim());
  }
  return out;
}

function indexes(sql) {
  const out = new Map();
  for (const m of sql.matchAll(/CREATE INDEX (\w+) ON (app\.\w+) \(([^)]*)\);/g)) {
    out.set(m[1], `${m[2]} (${m[3].replace(/\s+/g, ' ').trim()})`);
  }
  return out;
}

const pairs = [
  ['schema/studybridge.sql', 'supabase/migrations/20261110000001_studybridge_core_schema.sql'],
  ['schema/central-gateway.sql', 'supabase/migrations/20261110000002_central_gateway_schema.sql'],
];

let failures = 0;
let tableCount = 0;
let indexCount = 0;

for (const [source, migration] of pairs) {
  const srcTables = tables(stripComments(read(source)));
  const migTables = tables(stripComments(read(migration)));
  const srcIndexes = indexes(stripComments(read(source)));
  const migIndexes = indexes(stripComments(read(migration)));

  for (const [name, body] of srcTables) {
    tableCount += 1;
    if (!migTables.has(name)) {
      failures += 1;
      console.error(`MISSING TABLE in ${migration}: ${name}`);
    } else if (migTables.get(name) !== body) {
      failures += 1;
      console.error(`TABLE DIFFERS: ${name}\n  source:    ${body}\n  migration: ${migTables.get(name)}`);
    }
  }
  for (const name of migTables.keys()) {
    if (!srcTables.has(name)) {
      failures += 1;
      console.error(`EXTRA TABLE in ${migration}: ${name}`);
    }
  }
  for (const [name, body] of srcIndexes) {
    indexCount += 1;
    if (!migIndexes.has(name)) {
      failures += 1;
      console.error(`MISSING INDEX in ${migration}: ${name}`);
    } else if (migIndexes.get(name) !== body) {
      failures += 1;
      console.error(`INDEX DIFFERS: ${name}\n  source:    ${body}\n  migration: ${migIndexes.get(name)}`);
    }
  }
  for (const name of migIndexes.keys()) {
    if (!srcIndexes.has(name)) {
      failures += 1;
      console.error(`EXTRA INDEX in ${migration}: ${name}`);
    }
  }
}

if (failures) {
  console.error(`FAIL: ${failures} difference(s) across ${tableCount} tables and ${indexCount} indexes.`);
  process.exit(1);
}
console.log(`OK: all ${tableCount} tables and ${indexCount} indexes in schema/*.sql are reproduced exactly in the migrations.`);
