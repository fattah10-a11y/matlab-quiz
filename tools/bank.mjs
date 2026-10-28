// Reads the Markdown question bank (bank/*.md) and turns it into seed SQL.
//
// File format:
//   # Topic: <id> | <title> | <week> | <questions per quiz>
//   ## <question id> | easy|medium|hard | <source>
//   Question text, optionally with ```matlab fenced code```.
//   - [x] Correct option          (exactly one per question)
//     > Why it is right.
//   - [ ] Wrong option
//     > Why it is wrong.
//       Extra option lines are indented four spaces.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

export function parseBankFile(text, file) {
  const fail = (line, message) => { throw new Error(`${file}:${line + 1}: ${message}`); };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let topic = null, question = null, inFence = false;
  const questions = [];
  const finish = () => {
    if (!question) return;
    question.prompt = question.body.join('\n').trim();
    delete question.body;
    if (!question.prompt) fail(question.line, `${question.id} has no question text`);
    if (question.options.length !== 4) fail(question.line, `${question.id} needs 4 options, has ${question.options.length}`);
    const correct = question.options.filter(o => o.correct).length;
    if (correct !== 1) fail(question.line, `${question.id} needs exactly one [x] option, has ${correct}`);
    for (const o of question.options) {
      if (!o.text.trim()) fail(question.line, `${question.id} has an empty option`);
      if (!o.explanation.trim()) fail(question.line, `${question.id} option "${o.text}" has no explanation`);
    }
    question.answer = question.options.findIndex(o => o.correct);
    question.options = question.options.map(o => ({ text: o.text.trim(), explanation: o.explanation.trim() }));
    questions.push(question);
    question = null;
  };

  lines.forEach((line, i) => {
    if (inFence || line.startsWith('```')) {
      if (!question) fail(i, 'code block outside a question');
      if (question.options.length) fail(i, 'code blocks must come before the options');
      if (line.startsWith('```')) inFence = !inFence;
      question.body.push(line);
      return;
    }
    let m;
    if ((m = line.match(/^# Topic:\s*(.+)$/))) {
      if (topic) fail(i, 'only one topic per file');
      const [id, title, week, perQuiz] = m[1].split('|').map(s => s.trim());
      if (!/^[a-z][a-z0-9_]*$/.test(id || '')) fail(i, `bad topic id "${id}"`);
      if (!title || !week || !/^\d+$/.test(perQuiz || '')) fail(i, 'topic needs: id | title | week | per-quiz count');
      topic = { id, title, week, per_quiz: Number(perQuiz) };
    } else if ((m = line.match(/^## (.+)$/))) {
      finish();
      if (!topic) fail(i, 'question before the # Topic line');
      const [id, difficulty, source] = m[1].split('|').map(s => s.trim());
      if (!/^[a-z0-9-]+$/.test(id || '')) fail(i, `bad question id "${id}"`);
      if (!DIFFICULTIES.has(difficulty)) fail(i, `difficulty must be easy, medium or hard, got "${difficulty}"`);
      question = { id, topic_id: topic.id, difficulty, source: source || null, body: [], options: [], line: i };
    } else if ((m = line.match(/^- \[( |x)\] (.+)$/))) {
      if (!question) fail(i, 'option outside a question');
      question.options.push({ correct: m[1] === 'x', text: m[2], explanation: '' });
    } else if ((m = line.match(/^  > ?(.*)$/)) && question?.options.length) {
      const o = question.options.at(-1);
      o.explanation += (o.explanation ? ' ' : '') + m[1];
    } else if ((m = line.match(/^    (.*)$/)) && question?.options.length) {
      question.options.at(-1).text += '\n' + m[1];
    } else if (question && !question.options.length) {
      question.body.push(line);
    } else if (line.trim()) {
      fail(i, `unexpected line: ${line}`);
    }
  });
  if (inFence) fail(lines.length - 1, 'unclosed code block');
  finish();
  if (!topic) fail(0, 'missing "# Topic:" line');
  questions.forEach(q => delete q.line);
  return { topic, questions };
}

export function loadBank(dir) {
  const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  const topics = [], questions = [], seen = new Set();
  files.forEach((file, index) => {
    const parsed = parseBankFile(readFileSync(join(dir, file), 'utf8'), file);
    if (topics.some(t => t.id === parsed.topic.id)) throw new Error(`${file}: duplicate topic ${parsed.topic.id}`);
    topics.push({ ...parsed.topic, sort_order: index + 1 });
    for (const q of parsed.questions) {
      if (seen.has(q.id)) throw new Error(`${file}: duplicate question id ${q.id}`);
      seen.add(q.id);
      questions.push(q);
    }
  });
  if (!questions.length) throw new Error(`no questions found in ${dir}`);
  return { topics, questions };
}

const lit = value => value === null || value === undefined ? 'null' : `'${String(value).replace(/'/g, "''")}'`;

// Upserts topics and questions. Questions missing from the bank are deactivated,
// not deleted, so past attempts keep their history. per_quiz is only set for new
// topics; changes made on the admin Settings page are kept.
export function seedSql({ topics, questions }) {
  const out = ['-- Generated by tools/build_seed.mjs from bank/*.md. Do not edit by hand.', 'begin;', ''];
  out.push('insert into quiz.topics (id, title, week, sort_order, per_quiz) values');
  out.push(topics.map(t => `  (${lit(t.id)}, ${lit(t.title)}, ${lit(t.week)}, ${t.sort_order}, ${t.per_quiz})`).join(',\n'));
  out.push('on conflict (id) do update set title = excluded.title, week = excluded.week, sort_order = excluded.sort_order;', '');
  out.push('insert into quiz.questions (id, topic_id, difficulty, prompt, options, answer, source, active) values');
  out.push(questions.map(q => `  (${lit(q.id)}, ${lit(q.topic_id)}, ${lit(q.difficulty)}, ${lit(q.prompt)}, ${lit(JSON.stringify(q.options))}::jsonb, ${q.answer}, ${lit(q.source)}, true)`).join(',\n'));
  out.push('on conflict (id) do update set topic_id = excluded.topic_id, difficulty = excluded.difficulty, prompt = excluded.prompt,');
  out.push('  options = excluded.options, answer = excluded.answer, source = excluded.source, active = true;', '');
  out.push(`update quiz.questions set active = false where id not in (${questions.map(q => lit(q.id)).join(', ')});`);
  out.push('', 'commit;', '');
  return out.join('\n');
}
