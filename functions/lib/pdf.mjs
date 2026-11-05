// Text-layer PDF extraction with no third-party dependency: locate each
// content stream, inflate it with the platform's DecompressionStream, then read
// the text-showing operators. Scanned pages have no text layer and fall back to
// the vision path in the scanner route.

function toLatin1(bytes) {
  let out = '';
  const step = 8192;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return out;
}

async function inflate(candidate) {
  for (const format of ['deflate', 'deflate-raw']) {
    try {
      const stream = new Blob([candidate]).stream()
        .pipeThrough(new DecompressionStream(format));
      const buffer = await new Response(stream).arrayBuffer();
      if (buffer.byteLength > 0) return new Uint8Array(buffer);
    } catch { /* try the next format */ }
  }
  return null;
}

function unescapePdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = raw[++i];
    if (next === 'n') out += '\n';
    else if (next === 't') out += ' ';
    else if (next === 'r' || next === 'b' || next === 'f') out += ' ';
    else if (next === '(' || next === ')' || next === '\\') out += next;
    else if (next >= '0' && next <= '7') {
      let oct = next;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else if (next === '\n') out += '';
    else out += next === undefined ? '' : next;
  }
  return out;
}

function hexToString(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

// Two-byte CID fonts (common in LaTeX and Word exports) show text as <00480065…>.
function readable(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0) { if (i + 1 < text.length) { out += text[i + 1]; i += 1; } continue; }
    if (code >= 32 || code === 9 || code === 10) out += String.fromCharCode(code);
  }
  return out;
}

function textFromContent(content) {
  const chunks = [];
  let total = 0;
  const push = value => {
    if (!value) return;
    total += value.length;
    if (total > 120000) return;
    chunks.push(value);
  };
  const blocks = content.split(/\bBT\b/).slice(1);
  for (const block of blocks) {
    const body = block.split(/\bET\b/)[0];
    const pattern = /(\((?:\\.|[^\\()])*\)\s*(?:Tj|')|\[[^\]]*\]\s*TJ|<[0-9A-Fa-f\s]+>\s*Tj)/g;
    let match;
    let line = '';
    while ((match = pattern.exec(body)) !== null) {
      const token = match[0];
      let piece = '';
      if (token.startsWith('(')) {
        piece = unescapePdfString(token.slice(1, token.lastIndexOf(')')));
      } else if (token.startsWith('<')) {
        piece = hexToString(token.slice(1, token.lastIndexOf('>')));
      } else {
        const arrayBody = token.slice(1, token.lastIndexOf(']'));
        const inner = arrayBody.match(/(?:\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>)/g) || [];
        for (const item of inner) {
          if (item.startsWith('(')) piece += unescapePdfString(item.slice(1, -1));
          else piece += hexToString(item.slice(1, -1));
          // A large kerning gap between runs usually means a space in the page.
          const gapStart = arrayBody.indexOf(item) + item.length;
          const gap = /^\s*(-?\d{3,})/.exec(arrayBody.slice(gapStart));
          if (gap && Number(gap[1]) <= -180) piece += ' ';
        }
      }
      piece = readable(piece);
      if (/\bT\*|\bTd\b|\bTD\b/.test(token)) line += '\n';
      line += piece;
      if (token.endsWith('Tj') || token.endsWith("'")) { line = line.trim(); if (line) push(line); line = ''; }
    }
    if (line.trim()) push(line.trim());
    push('\n');
  }
  return chunks.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export async function extractPdfPages(bytes) {
  const source = toLatin1(bytes);
  const pageCount = (source.match(/\/Type\s*\/Page[^s]/g) || []).length
    || (source.match(/\/Count\s+(\d+)/g) || []).length || 0;
  const pages = [];
  let index = 0;
  let cursor = 0;
  for (;;) {
    const start = source.indexOf('stream', cursor);
    if (start < 0) break;
    const end = source.indexOf('endstream', start);
    if (end < 0) break;
    cursor = end + 9;
    let from = start + 6;
    if (source[from] === '\r') from += 1;
    if (source[from] === '\n') from += 1;
    const raw = bytes.subarray(from, end);
    const header = source.slice(Math.max(0, start - 400), start);
    const flate = /FlateDecode/.test(header);
    let content = '';
    if (flate) {
      const inflated = await inflate(raw);
      if (inflated) content = toLatin1(inflated);
    } else {
      content = toLatin1(raw);
    }
    if (!content || !/\bBT\b/.test(content)) continue;
    const text = textFromContent(content);
    if (text.replace(/\s/g, '').length < 4) continue;
    index += 1;
    pages.push({ page_number: index, text: text.slice(0, 20000), characters: text.length });
    if (index >= 60) break;
  }
  return { pages, declaredPages: pageCount, extractedPages: index, hasTextLayer: index > 0 };
}

export function isPdf(bytes) {
  const head = toLatin1(bytes.subarray(0, 5));
  return head === '%PDF-';
}
