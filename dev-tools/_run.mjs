// Single entry that prints the combined report plus an honest total.
// runAll() returns the report text; the "(library within)" echoes repeat checks
// already counted by their own section, so they are excluded from the sum.
import { runAll } from './run-all.mjs';

const report = await runAll();
console.log(report);

let passed = 0;
let total = 0;
let threw = 0;
for (const line of report.split('\n')) {
  if (/^\s*\(library within/.test(line)) continue;
  const match = /^(\d+)\/(\d+) passed/.exec(line);
  if (match) { passed += Number(match[1]); total += Number(match[2]); }
  if (/^!! THREW/.test(line)) threw += 1;
}
console.log(threw
  ? `SUITE: ${threw} section(s) threw — not green`
  : `SUITE: ${passed}/${total} passed`);
