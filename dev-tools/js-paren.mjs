// Finds the first bracket whose closer does not match the opener on its stack,
// and prints the enclosing open call sites. Handles strings, template literals
// with ${} nesting, comments and (heuristically) regex literals.
import fs from 'node:fs';

let src = fs.readFileSync(process.argv[2], 'utf8');
let line = 1, col = 0, i = 0;
const stack = [];
const mark = () => ({ line, col, text: src.slice(Math.max(0, i - 1), i + 60).split('\n')[0] });
const advance = n => { for (let k = 0; k < n; k += 1) { if (src[i] === '\n') { line += 1; col = 0; } else col += 1; i += 1; } };
const prevCode = () => { for (let k = i - 1; k >= 0; k -= 1) if (!/\s/.test(src[k])) return src[k]; return ''; };
const regexAllowed = () => !/[\w)\]}'"`]/.test(prevCode());

while (i < src.length) {
  const c = src[i];
  const n = src[i + 1];
  if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') advance(1); continue; }
  if (c === '/' && n === '*') { advance(2); while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) advance(1); advance(2); continue; }
  if ((c === '"' || c === "'") ) { advance(1); while (i < src.length && src[i] !== c) { if (src[i] === '\\') advance(1); advance(1); } advance(1); continue; }
  if (c === '`') {
    advance(1);
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { advance(2); continue; }
      if (src[i] === '$' && src[i + 1] === '{') { stack.push({ ...mark(), k: '{', template: true }); advance(2); let depth = 1; while (i < src.length && depth > 0) { if (src[i] === '{') depth += 1; else if (src[i] === '}') { depth -= 1; if (!depth) break; } advance(1); } stack.pop(); advance(1); continue; }
      advance(1);
    }
    advance(1); continue;
  }
  if (c === '/' && regexAllowed()) { advance(1); while (i < src.length && src[i] !== '/' && src[i] !== '\n') { if (src[i] === '\\') advance(1); advance(1); } advance(1); continue; }
  if (c === '(' || c === '[' || c === '{') { stack.push({ ...mark(), k: c }); advance(1); continue; }
  if (c === ')' || c === ']' || c === '}') {
    const want = { '(': ')', '[': ']', '{': '}' }[stack[stack.length - 1]?.k];
    const here = mark();
    if (!stack.length) { console.log(`EXTRA closer '${c}' at line ${line} col ${col}\n  ${src.split('\n')[line - 1].trim()}`); process.exit(0); }
    if (want !== c) {
      const top = stack[stack.length - 1];
      console.log(`MISMATCH closer '${c}' at line ${line} col ${col} — expected '${want}' for opener '${top.k}' at line ${top.line}`);
      console.log(`  closer line: ${src.split('\n')[line - 1].trim().slice(0, 160)}`);
      console.log(`  opener line: ${src.split('\n')[top.line - 1].trim().slice(0, 160)}`);
      console.log(`  stack: ${stack.slice(-6).map(s => `${s.k}@${s.line}`).join(' ')}`);
      process.exit(0);
    }
    stack.pop(); advance(1); continue;
  }
  advance(1);
}
console.log(`unclosed at end: ${stack.slice(-8).map(s => `${s.k}@${s.line} (${src.split('\n')[s.line - 1].trim().slice(0, 90)})`).join('\n  ') || 'balanced'}`);
