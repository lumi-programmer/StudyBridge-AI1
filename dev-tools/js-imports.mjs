// Reports shared helpers that a module calls without importing them.
// Comments and string literals are stripped first so prose does not count.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'web/js');
const strip = src => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/[ \t]\/\/[^\n]*/g, ' ')
  .replace(/`[\s\S]*?`/g, '``')
  .replace(/'[^'\n]*'/g, "''")
  .replace(/"[^"\n]*"/g, '""');
const readExports = file => {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) m[1].split(',').forEach(part => names.add(part.split(' as ').pop().trim()));
  return names;
};

const names = new Map();
for (const file of ['ui.js', 'api.js', 'store.js', 'charts.js', 'focus.js']) {
  for (const name of readExports(path.join(root, file))) if (name !== 'render') names.set(name, file);
}
const viewDir = path.join(root, 'views');
for (const file of ['shared.js', 'quiz.js']) {
  for (const name of readExports(path.join(viewDir, file))) if (name !== 'render') names.set(name, `views/${file}`);
}

const files = [
  ...fs.readdirSync(root).filter(f => f.endsWith('.js')).map(f => path.join(root, f)),
  ...fs.readdirSync(viewDir).filter(f => f.endsWith('.js')).map(f => path.join(viewDir, f)),
];
let problems = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const importRe = /^[\t ]*import[\s\S]*?from\s*['"][^'"]+['"];?/gm;
  const importLines = src.match(importRe)?.join('\n') || '';
  const body = strip(src.replace(importRe, ''));
  const imported = new Set();
  for (const m of importLines.matchAll(/import\s*\{([^}]*)\}/g)) m[1].split(',').forEach(p => imported.add(p.split(' as ').pop().trim()));
  for (const m of importLines.matchAll(/import\s+([A-Za-z0-9_$]+)\s+from/g)) imported.add(m[1]);
  for (const [name, owner] of names) {
    if (imported.has(name)) continue;
    const call = new RegExp(`[^\\w$.]${name}\\s*\\(`);
    if (!call.test(body)) continue;
    if (new RegExp(`(function|class|const|let|var)\\s+${name}\\b`).test(body)) continue;
    problems += 1;
    const line = src.split('\n').findIndex(l => call.test(strip(l)) && !/^\s*import/.test(l)) + 1;
    console.log(`MISSING IMPORT ${path.relative(root, file)}:${line} — ${name}() is exported by ${owner}`);
  }
}
console.log(problems ? `${problems} problem(s)` : 'every shared helper called is imported');

// Second pass: every named import must exist in the module it names, which is
// what the browser checks when it links an ES module.
const resolveFailures = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[2]);
    if (!fs.existsSync(target)) { resolveFailures.push(`${path.relative(root, file)} — no module at ${m[2]}`); continue; }
    const available = readExports(target);
    for (const part of m[1].split(',')) {
      const name = part.split(' as ')[0].trim();
      if (name && !available.has(name)) resolveFailures.push(`${path.relative(root, file)} — ${m[2]} does not export “${name}”`);
    }
  }
}
console.log(resolveFailures.length ? `\nEXPORT MISMATCHES\n${resolveFailures.join('\n')}` : '\nnamed imports all resolve against their modules');
process.exit(resolveFailures.length || problems ? 1 : 0);

