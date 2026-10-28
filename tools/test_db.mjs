// Tests the Supabase schema (sign-up rules, quiz generation, grading, time
// limits, privacy and admin functions) against an in-memory Postgres.
// Run with: npm test
import assert from 'node:assert/strict';
import { createLocalDb, signUp, rpc } from './localdb.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const db = await createLocalDb({ admins: ['DevAdmin'.toLowerCase()] });
const jane = await signUp(db, { email: 'jane@students.rowan.edu', login: 'jane', name: 'Jane Doe' });
const omar = await signUp(db, { email: 'omar@rowan.edu', login: 'omar', name: 'Omar Ali' });
const admin = await signUp(db, { email: 'teacher@gmail.com', login: 'DevAdmin', name: 'Instructor' });

const rejects = async (promise, pattern) => {
  await assert.rejects(promise, err => pattern.test(err.message), `expected error matching ${pattern}`);
};
// Displayed index of the correct option for each position, read straight from the database.
const answerKey = async attemptId => Object.fromEntries((await db.query(
  `select i.position, array_position(i.option_order, q.answer) - 1 as correct
     from quiz.attempt_items i join quiz.questions q on q.id = i.question_id
    where i.attempt_id = $1`, [attemptId])).rows.map(r => [r.position, r.correct]));
const questionIds = async attemptId => (await db.query(
  'select question_id from quiz.attempt_items where attempt_id = $1', [attemptId])).rows.map(r => r.question_id);

test('sign-up accepts rowan.edu and its subdomains', async () => {
  await signUp(db, { email: 'a@rowan.edu', login: 'a1' });
  await signUp(db, { email: 'B@Students.Rowan.edu', login: 'b1' });
});

test('sign-up rejects other domains and look-alikes', async () => {
  for (const email of ['x@gmail.com', 'x@evilrowan.edu', 'x@rowan.edu.evil.com', 'x@rowan.com', null]) {
    await rejects(signUp(db, { email, login: 'x' + Math.random().toString(36).slice(2) }), /ROWAN_EMAIL_REQUIRED/);
  }
});

test('admin login bypasses the domain rule only through GitHub', async () => {
  await rejects(signUp(db, { email: 'fake@gmail.com', login: 'devadmin', provider: 'email' }), /ROWAN_EMAIL_REQUIRED/);
});

test('whoami reports roles; editing user_metadata cannot grant admin', async () => {
  assert.equal((await rpc(db, admin, 'whoami')).role, 'admin');
  assert.equal((await rpc(db, jane, 'whoami')).role, 'student');
  await db.query(`update auth.users set raw_user_meta_data = raw_user_meta_data || '{"user_name":"devadmin"}' where id = $1`, [omar]);
  assert.equal((await rpc(db, omar, 'whoami')).role, 'student');
  await rejects(rpc(db, omar, 'admin_overview'), /ADMIN_ONLY/);
});

test('signed-out callers are refused', async () => {
  await rejects(rpc(db, null, 'my_dashboard'), /NOT_SIGNED_IN/);
  await rejects(rpc(db, null, 'start_quiz'), /NOT_SIGNED_IN/);
});

let janeFirst;
test('start_quiz covers every topic and leaks no answers', async () => {
  const quiz = await rpc(db, jane, 'start_quiz');
  janeFirst = quiz.attempt_id;
  const dash = await rpc(db, jane, 'my_dashboard');
  assert.equal(quiz.total, dash.settings.question_count);
  assert.equal(quiz.questions.length, 20);
  assert.deepEqual(quiz.questions.map(q => q.position), [...Array(20)].map((_, i) => i + 1));
  const counts = {};
  for (const q of quiz.questions) counts[q.topic] = (counts[q.topic] || 0) + 1;
  for (const t of dash.settings.topics) assert.equal(counts[t.title] || 0, t.per_quiz, t.title);
  for (const q of quiz.questions) {
    assert.equal(q.options.length, 4);
    assert.ok(q.options.every(o => typeof o === 'string'));
  }
  const text = JSON.stringify(quiz);
  assert.ok(!/"answer"|"explanation"|"correct"|"is_correct"/.test(text), 'payload must not contain answers');
  assert.equal(new Set(await questionIds(quiz.attempt_id)).size, 20);
});

test('start_quiz resumes the open attempt instead of creating another', async () => {
  const again = await rpc(db, jane, 'start_quiz');
  assert.equal(again.attempt_id, janeFirst);
  assert.equal((await db.query("select count(*)::int n from quiz.attempts where user_id = $1", [jane])).rows[0].n, 1);
});

test('save_answer validates input and is private to the owner', async () => {
  await rejects(rpc(db, jane, 'save_answer', { p_attempt: janeFirst, p_position: 1, p_choice: 4 }), /BAD_CHOICE/);
  await rejects(rpc(db, jane, 'save_answer', { p_attempt: janeFirst, p_position: 99, p_choice: 0 }), /BAD_POSITION/);
  await rejects(rpc(db, omar, 'save_answer', { p_attempt: janeFirst, p_position: 1, p_choice: 0 }), /ATTEMPT_NOT_FOUND/);
  await rejects(rpc(db, omar, 'get_review', { p_attempt: janeFirst }), /ATTEMPT_NOT_FOUND/);
  await rejects(rpc(db, jane, 'get_review', { p_attempt: janeFirst }), /ATTEMPT_IN_PROGRESS/);
});

test('answers saved one by one and in the final submit are both graded', async () => {
  const key = await answerKey(janeFirst);
  for (let p = 1; p <= 10; p++) {
    assert.deepEqual(await rpc(db, jane, 'save_answer', { p_attempt: janeFirst, p_position: p, p_choice: key[p] }), { ok: true });
  }
  const resumed = await rpc(db, jane, 'start_quiz');
  assert.equal(resumed.questions[0].choice, key[1], 'saved choices come back on resume');
  const rest = {};
  for (let p = 11; p <= 19; p++) rest[p] = key[p];
  rest[20] = (key[20] + 1) % 4;  // one wrong answer
  const review = await rpc(db, jane, 'submit_quiz', { p_attempt: janeFirst, p_answers: rest });
  assert.equal(review.status, 'submitted');
  assert.equal(review.score, 19);
  assert.equal(review.total, 20);
  const last = review.items.find(i => i.position === 20);
  assert.equal(last.is_correct, false);
  assert.equal(last.correct, key[20]);
  assert.ok(review.items.every(i => i.options.length === 4 && i.options.every(o => o.text && o.explanation)));
  assert.ok(review.items.slice(0, 19).every(i => i.is_correct && i.choice === i.correct));
});

test('a submitted attempt cannot be changed', async () => {
  const r = await rpc(db, jane, 'save_answer', { p_attempt: janeFirst, p_position: 20, p_choice: 0 });
  assert.equal(r.ok, false);
  const again = await rpc(db, jane, 'submit_quiz', { p_attempt: janeFirst, p_answers: { 20: 0 } });
  assert.equal(again.score, 19);
});

test('the next quiz avoids questions the student has already seen', async () => {
  const second = await rpc(db, jane, 'start_quiz');
  assert.notEqual(second.attempt_id, janeFirst);
  const first = new Set(await questionIds(janeFirst));
  const overlap = (await questionIds(second.attempt_id)).filter(id => first.has(id));
  assert.deepEqual(overlap, []);
  const review = await rpc(db, jane, 'submit_quiz', { p_attempt: second.attempt_id });
  assert.equal(review.score, 0, 'unanswered questions count as wrong');
});

test('time limit: late answers are refused and the attempt is auto-graded', async () => {
  const quiz = await rpc(db, omar, 'start_quiz');
  const key = await answerKey(quiz.attempt_id);
  await rpc(db, omar, 'save_answer', { p_attempt: quiz.attempt_id, p_position: 1, p_choice: key[1] });
  await db.query("update quiz.attempts set started_at = now() - interval '40 minutes', deadline = now() - interval '10 minutes' where id = $1", [quiz.attempt_id]);
  const late = await rpc(db, omar, 'save_answer', { p_attempt: quiz.attempt_id, p_position: 2, p_choice: key[2] });
  assert.deepEqual(late, { ok: false, reason: 'closed' });
  const dash = await rpc(db, omar, 'my_dashboard');
  assert.equal(dash.active, null);
  const attempt = dash.attempts.at(-1);
  assert.equal(attempt.status, 'expired');
  assert.equal(attempt.score, 1);
  assert.equal(attempt.seconds_used, 30 * 60);
});

test('a late submit ignores the answers it carries', async () => {
  const quiz = await rpc(db, omar, 'start_quiz');
  const key = await answerKey(quiz.attempt_id);
  await db.query("update quiz.attempts set deadline = now() - interval '5 minutes' where id = $1", [quiz.attempt_id]);
  const review = await rpc(db, omar, 'submit_quiz', { p_attempt: quiz.attempt_id, p_answers: key });
  assert.equal(review.status, 'expired');
  assert.equal(review.score, 0);
});

test('a submit within the grace period still counts', async () => {
  const quiz = await rpc(db, omar, 'start_quiz');
  const key = await answerKey(quiz.attempt_id);
  await db.query("update quiz.attempts set deadline = now() - interval '10 seconds' where id = $1", [quiz.attempt_id]);
  const review = await rpc(db, omar, 'submit_quiz', { p_attempt: quiz.attempt_id, p_answers: key });
  assert.equal(review.status, 'submitted');
  assert.equal(review.score, 20);
});

test('dashboard stats add up', async () => {
  const dash = await rpc(db, jane, 'my_dashboard');
  assert.equal(dash.attempts.length, 2);
  assert.deepEqual(dash.attempts.map(a => a.score), [19, 0]);
  const answered = dash.topics.reduce((n, t) => n + t.answered, 0);
  const correct = dash.topics.reduce((n, t) => n + t.correct, 0);
  assert.equal(answered, 40);
  assert.equal(correct, 19);
  assert.equal(dash.topics.length, 12);
});

test('students cannot use admin functions', async () => {
  for (const [fn, args] of [['admin_overview', {}], ['admin_question_stats', {}], ['admin_student', { p_user: omar }],
                            ['admin_update_settings', { p_duration_minutes: 10, p_per_topic: null }],
                            ['admin_set_question_active', { p_question: 'fun-01', p_active: false }]]) {
    await rejects(rpc(db, jane, fn, args), /ADMIN_ONLY/);
  }
});

test('admin overview, student detail and question stats', async () => {
  const o = await rpc(db, admin, 'admin_overview');
  assert.equal(o.class.students, 4);  // jane, omar, a1, b1 (the admin is excluded)
  assert.equal(o.class.attempts, 5);
  assert.equal(o.class.active_students, 2);
  const j = o.students.find(s => s.github_login === 'jane');
  assert.equal(j.attempts, 2);
  assert.equal(Number(j.best_pct), 95);
  assert.equal(Number(j.last_pct), 0);
  assert.equal(o.topics.length, 12);
  assert.equal(o.scores.length, 5);
  const detail = await rpc(db, admin, 'admin_student', { p_user: jane });
  assert.equal(detail.profile.full_name, 'Jane Doe');
  const review = await rpc(db, admin, 'get_review', { p_attempt: janeFirst });
  assert.equal(review.score, 19);
  assert.equal(review.student.github_login, 'jane');
  const stats = await rpc(db, admin, 'admin_question_stats');
  assert.equal(stats.length, 220);
  assert.equal(stats.reduce((n, s) => n + s.served, 0), 100);
});

test('admin settings change future quizzes', async () => {
  const s = await rpc(db, admin, 'admin_update_settings', { p_duration_minutes: 20, p_per_topic: { fundamentals: 3, errors: 0 } });
  assert.equal(s.duration_minutes, 20);
  assert.equal(s.question_count, 21);
  for (const id of ['fun-01', 'fun-02', 'fun-03', 'fun-04', 'fun-05', 'fun-06', 'fun-07', 'fun-08', 'fun-09', 'fun-10', 'fun-11', 'fun-12', 'fun-13', 'fun-14']) {
    await rpc(db, admin, 'admin_set_question_active', { p_question: id, p_active: false });
  }
  const settings = (await rpc(db, admin, 'admin_overview')).settings;
  assert.equal(settings.question_count, 20, 'only 2 active fundamentals questions remain');
  const quiz = await rpc(db, omar, 'start_quiz');
  assert.equal(quiz.total, 20);
  const ids = await questionIds(quiz.attempt_id);
  assert.ok(ids.includes('fun-15') && ids.includes('fun-16'));
  assert.ok(!ids.some(id => id.startsWith('err-')));
  const { rows } = await db.query('select extract(epoch from deadline - started_at)::int as s from quiz.attempts where id = $1', [quiz.attempt_id]);
  assert.equal(rows[0].s, 20 * 60);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
