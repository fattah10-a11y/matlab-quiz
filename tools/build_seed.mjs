// Validates bank/*.md and writes supabase/questions_seed.sql.
// Run with: npm run build:seed   (then paste the file into the Supabase SQL editor)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadBank, seedSql } from './bank.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bank = loadBank(join(root, 'bank'));
const out = join(root, 'supabase', 'questions_seed.sql');
writeFileSync(out, seedSql(bank));

const perQuiz = bank.topics.reduce((n, t) => n + t.per_quiz, 0);
console.log(`${bank.questions.length} questions in ${bank.topics.length} topics; ${perQuiz} questions per quiz.`);
for (const t of bank.topics) {
  const n = bank.questions.filter(q => q.topic_id === t.id).length;
  console.log(`  ${t.title.padEnd(32)} ${String(n).padStart(3)} questions, ${t.per_quiz} per quiz`);
}
console.log(`Wrote ${out}`);
