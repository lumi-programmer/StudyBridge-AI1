// Deterministic table-of-contents reader. A printed contents page is parsed
// exactly, with no model and no cost; callers fall back to a provider only when
// this returns nothing.
const URDU_DIGITS = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9', '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
const SKIP = /^(contents|content|table of contents|index|foreword|preface|page|pages|chapter name|topic|exercise|summary|glossary|bibliography)\b/i;
const LEADERS = /[.\u2026\u00b7\u2013_-]{3,}/;

function normalizeDigits(text) {
  return String(text).replace(/[۰-۹٠-٩]/g, ch => URDU_DIGITS[ch] ?? ch);
}

function romanToNumber(token) {
  const upper = token.toUpperCase();
  if (!/^[IVXLCDM]+$/.test(upper)) return null;
  let total = 0;
  for (let i = 0; i < upper.length; i += 1) {
    const value = ROMAN[upper[i]];
    const next = ROMAN[upper[i + 1]] || 0;
    total += value < next ? -value : value;
  }
  return total > 0 && total <= 500 ? total : null;
}

function parseNumber(token) {
  const digits = /^\d+$/.test(token) ? Number(token) : romanToNumber(token);
  return Number.isFinite(digits) && digits > 0 && digits <= 500 ? digits : null;
}

// "Chapter 3 Geometrical Optics ......... 29" -> { number, title, page }
function readLine(line) {
  const text = normalizeDigits(line).replace(/\s+/g, ' ').trim();
  if (!text || text.length < 3) return null;
  const body = text.replace(LEADERS, ' ').replace(/\s+/g, ' ').trim();
  if (SKIP.test(body)) return null;

  const words = body.split(' ');
  const trailing = words[words.length - 1];
  const pageMatch = /^(?:p(?:age)?\.?\s*)?(\d{1,4})\.?$/i.exec(trailing);
  const page = pageMatch ? Number(pageMatch[1]) : null;
  const withoutPage = page !== null && page <= 5000 ? words.slice(0, -1).join(' ') : body;
  const label = withoutPage.replace(/^(?:p(?:age)?\.?\s*\d+\s*)/i, '').trim();
  if (!label) return null;

  const headed = label.match(/^(chapter|unit|lesson|part|section|topic|باب|وحدت|سبق|یونٹ|حصہ)\s*(?:no\.?|number)?\s*([0-9IVXLCDM]+)\s*[:.\-\u2014]?\s*(.*)$/i);
  if (headed) {
    const number = parseNumber(headed[2]);
    const title = cleanTitle(headed[3] || '');
    if (number !== null && title) return { number, title, page: page ?? 0 };
  }

  const plain = label.match(/^([0-9]+|[IVXLCDM]+)\s*[.):\-]\s*(.+)$/);
  if (plain) {
    const number = parseNumber(plain[1]);
    const title = cleanTitle(plain[2]);
    if (number !== null && title) return { number, title, page: page ?? 0 };
  }
  return null;
}

function cleanTitle(raw) {
  const title = String(raw).replace(/^[:.\-\u2014]\s*/, '').replace(/\s*(?:p(?:age)?|pg)\.?\s*$/i, '').trim();
  return title ? title.slice(0, 160) : '';
}

export function parseContents(text) {
  const seen = new Set();
  const chapters = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const entry = readLine(line);
    if (!entry) continue;
    const key = `${entry.number}:${entry.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chapters.push({ number: entry.number, title: entry.title, page: entry.page, topics: [] });
    if (chapters.length >= 120) break;
  }
  return chapters;
}
