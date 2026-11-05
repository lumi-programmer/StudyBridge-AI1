// Syntax gate for the browser modules: node --check each file as ESM and print
// the parser's own line + caret output so unbalanced calls are easy to find.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'web/js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jssyntax-'));
const files = [];
const walk = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
};
walk(root);
let failures = 0;
for (const file of files.sort()) {
  const copy = path.join(tmp, `${path.basename(file, '.js')}_${files.indexOf(file)}.mjs`);
  fs.copyFileSync(file, copy);
  try {
    execFileSync(process.execPath, ['--check', copy], { stdio: ['ignore', 'ignore', 'pipe'] });
    console.log(`OK   ${path.relative(root, file)}`);
  } catch (error) {
    failures += 1;
    const lines = String(error.stderr || error.message).split('\n');
    const head = lines.findIndex(l => l.endsWith(':'));
    const slice = lines.slice(Math.max(0, head), head + 4);
    console.log(`FAIL ${path.relative(root, file)}\n${slice.join('\n').split(copy).join(path.relative(root, file))}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
