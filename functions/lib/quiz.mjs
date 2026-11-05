// Offline quiz builder: turns the student's own extracted text into MCQs
// without calling a model. Used when no AI provider is configured, so quizzing
// stays available for free. Questions always cite the page they came from.
import { truncate } from './util.mjs';
import { QUESTION_BANK } from './content.mjs';

const DEFINITION = /^([A-Z][\w ()’'&/-]{2,48}?)\s+(?:is|are|refers to|means|defined as|was|were)\s+(.{20,240})$/;

function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map(s => s.trim())
    .filter(s => s.length > 24 && s.length < 300);
}

function termsFrom(pages) {
  const found = [];
  for (const page of pages) {
    for (const sentence of sentences(page.text)) {
      const match = DEFINITION.exec(sentence);
      if (!match) continue;
      const term = match[1].trim();
      const definition = match[2].trim().replace(/[.;]$/, '');
      if (term.length < 3 || definition.length < 15) continue;
      if (found.some(item => item.term.toLowerCase() === term.toLowerCase())) continue;
      found.push({ term, definition, sentence, page });
    }
  }
  return found;
}

function numericCloze(pages) {
  const out = [];
  for (const page of pages) {
    for (const sentence of sentences(page.text)) {
      const match = /(\d+(?:[.,]\d+)?)\s*(%|m\/s|cm|mm|kg|g|mol|litre|L|A|V|Ω|ohm|newton|N|joule|J|watt|W)/i.exec(sentence);
      if (!match) continue;
      const value = match[1];
      const unit = match[2];
      const others = [...new Set(
        sentences(page.text)
          .map(s => /(\d+(?:[.,]\d+)?)\s*(?:%|m\/s|cm|mm|kg|g|mol|litre|L|A|V|Ω|ohm|newton|N|joule|J|watt|W)/i.exec(s))
          .filter(Boolean).map(m => m[1]).filter(v => v !== value),
      )].slice(0, 3);
      if (others.length < 2) continue;
      const options = [value, ...others].slice(0, 4);
      out.push({
        q: `Fill the blank from page ${page.page_number}: “${truncate(sentence.replace(match[0], '______ '), 160)}”`,
        options,
        answer: options.indexOf(value),
        explain: `The text states ${value}${unit === '%' ? '%' : ` ${unit}`}.`,
        source: { page: page.page_number, kind: 'cloze' },
      });
      if (out.length >= 6) return out;
    }
  }
  return out;
}

function mixedOptions(question) {
  const items = question.options.map((option, index) => ({ option, correct: index === question.answer }));
  for (let i = items.length - 1; i > 0; i -= 1) {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    const j = buffer[0] % (i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return { options: items.map(item => item.option), answer: items.findIndex(item => item.correct) };
}

export function buildLocalQuiz(pages, { count = 8, title = 'Quiz from your scanned material' } = {}) {
  const termList = termsFrom(pages);
  const questions = [];
  for (let i = 0; i < termList.length && questions.length < count; i += 1) {
    const item = termList[i];
    const distractors = termList.filter((_, index) => index !== i)
      .slice(0, 8)
      .map(other => other.definition);
    const unique = [...new Set(distractors)];
    if (unique.length < 2) continue;
    const options = [item.definition, ...unique.slice(0, 3)];
    questions.push({
      q: `What is (are) ${item.term}?`,
      options,
      answer: 0,
      explain: `${item.term}: ${item.definition}`,
      source: { page: item.page.page_number, chapter: item.page.chapter_title || null, book: item.page.book_title || null, kind: 'definition' },
    });
  }
  if (questions.length < count) questions.push(...numericCloze(pages).slice(0, count - questions.length));
  return {
    title,
    origin: 'local_text',
    note: 'Built from your own scanned text (no AI). Verify wording against your book.',
    questions: questions.map(question => {
      const choices = mixedOptions(question);
      return {
        ...question,
        options: choices.options.map(option => truncate(String(option).replace(/\s+/g, ' '), 180)),
        answer: choices.answer,
      };
    }),
  };
}

export function importantTerms(pages, limit = 24) {
  return termsFrom(pages).slice(0, limit).map(item => ({
    term: item.term, definition: item.definition, page: item.page.page_number,
  }));
}

// Model output is untrusted input: only well-shaped MCQs are stored, and each
// keeps the page reference of the material it was generated from.
export function sanitizeQuestions(list, pages = []) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, 15)) {
    const question = String(item?.question || item?.q || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const options = Array.isArray(item?.options)
      ? item.options.map(option => truncate(String(option).replace(/\s+/g, ' '), 200)).filter(Boolean)
      : [];
    const answer = Number(item?.answer);
    if (!question || options.length < 3 || options.length > 6) continue;
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) continue;
    const page = pages[0];
    const choices = mixedOptions({ options, answer });
    out.push({
      q: question,
      options: choices.options.map(option => truncate(String(option), 200)),
      answer: choices.answer,
      explain: truncate(String(item?.explain || item?.rationale || ''), 400),
      source: {
        page: Number.isInteger(Number(item?.page)) ? Number(item.page) : page?.page_number ?? null,
        chapter: page?.chapter_title ?? null,
        book: page?.book_title ?? null,
        kind: 'ai',
      },
    });
  }
  return out;
}

// Questions as the practice UI sees them: the key stays on the server.
export function publicQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).map((question, index) => ({
    index,
    q: question.q,
    options: Array.isArray(question.options) ? question.options : [],
    source: question.source || null,
  }));
}

// Grading happens here so a score cannot be claimed from the browser.
export function gradeAnswers(questions, answers) {
  const given = Array.isArray(answers) ? answers : [];
  const feedback = [];
  let score = 0;
  (questions || []).forEach((question, index) => {
    const chosen = Number(given[index]);
    const ok = Number.isInteger(chosen) && chosen === question.answer;
    if (ok) score += 1;
    feedback.push({
      index,
      chosen: Number.isInteger(chosen) ? chosen : null,
      answer: question.answer,
      ok,
      explain: question.explain || null,
      source: question.source || null,
    });
  });
  return { score, total: (questions || []).length, feedback };
}


// Curated question bank quiz: real, vetted content with no model call and no
// scan required, so practice is possible from the very first visit.
export function bankQuiz({ subject = '', count = 8, title = '' } = {}) {
  const wanted = String(subject || '').trim().toLowerCase();
  const pool = wanted
    ? QUESTION_BANK.filter(item => item.s.toLowerCase() === wanted || item.s.toLowerCase().includes(wanted))
    : QUESTION_BANK;
  const picked = shuffledList(pool).slice(0, Math.max(1, Math.min(count, 15)));
  const questions = picked.map(item => ({
    q: item.q,
    options: [...item.o],
    answer: item.a,
    explain: item.e,
    source: { subject: item.s, kind: 'bank' },
  })).map(question => {
    const choices = mixedOptions(question);
    return { ...question, options: choices.options, answer: choices.answer };
  });
  return {
    title: title || (wanted ? `${wanted} practice quiz` : 'Mixed practice quiz'),
    origin: 'question_bank',
    note: 'From the StudyBridge vetted question bank — no AI call, free.',
    questions,
  };
}

function shuffledList(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    const j = buffer[0] % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
