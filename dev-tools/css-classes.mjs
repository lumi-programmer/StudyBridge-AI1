// Reports class names used in web/js and web/index.html that no stylesheet defines.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] || 'web';
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(js|css|html)$/.test(name)) files.push(full);
  }
})(root);

const defined = new Set();
for (const file of files.filter(f => f.endsWith('.css'))) {
  const css = readFileSync(file, 'utf8');
  for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1]);
}

const used = new Map();
for (const file of files.filter(f => f.endsWith('.js') || f.endsWith('.html'))) {
  const src = readFileSync(file, 'utf8');
  // class: 'a b c' / class="a b c" / classList.add('x') / `tag ${cond ? 'a' : 'b'}`
  const patterns = [
    /class\s*:\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g,
    /class\s*=\s*"([^"]*)"/g,
    /classList\.(?:add|remove|toggle)\((['"`])([^'"`]*)\1/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const raw = (m[2] !== undefined ? m[2] : m[1]).replace(/\$\{[^}]*\}/g, ' ');
      for (const token of raw.split(/[\s,]+/)) {
        if (!/^[A-Za-z][\w-]*$/.test(token)) continue;
        if (!used.has(token)) used.set(token, new Set());
        used.get(token).add(file.replace(/\\/g, '/'));
      }
    }
  }
}

const missing = [...used.entries()].filter(([name]) => !defined.has(name));
if (!missing.length) {
  console.log(`every class used in ${used.size} names is defined in CSS`);
} else {
  console.log(`${missing.length} class name(s) used but not defined:`);
  for (const [name, where] of missing.sort()) console.log(`  .${name}  <- ${[...where].join(', ')}`);
}
