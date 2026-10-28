// End-to-end check in Microsoft Edge against the local dev server: sign-in rules,
// taking and resuming a quiz, results, progress pages and the admin pages.
// Screenshots go to .qa/. Run with: npm run test:browser
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDevServer } from './dev_server.mjs';
import { root } from './localdb.mjs';

const shots = join(root, '.qa');
mkdirSync(shots, { recursive: true });
const srv = await startDevServer({ port: 8899 });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const problems = [];
const steps = [];

async function open(name, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  const page = await context.newPage();
  page.on('pageerror', e => problems.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`${name}: ${m.text()}`); });
  await page.goto(srv.url);
  return page;
}
async function signInAs(page, account) {
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await page.locator(`[data-account="${account}"]`).click();
}
const shot = (page, name, fullPage = true) => page.screenshot({ path: join(shots, `${name}.png`), fullPage });
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function step(name, fn) {
  try { await fn(); steps.push(`  ok    ${name}`); }
  catch (err) { steps.push(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`); problems.push(name); }
}

await step('an account without a Rowan email is refused with instructions', async () => {
  const page = await open('outsider');
  await signInAs(page, 'outsider');
  await page.getByText('This GitHub account cannot join the quiz').waitFor();
  assert.ok(await page.getByRole('link', { name: /GitHub → Settings → Emails/ }).isVisible());
  assert.ok(!page.url().includes('error='), 'error parameters are removed from the address bar');
  await shot(page, 'signin-rejected');
  await page.context().close();
});

await step('student: empty dashboard, start, answer, resume after reload, submit, review', async () => {
  const page = await open('jane');
  await signInAs(page, 'jane');
  await page.getByRole('heading', { name: 'Ready for a quiz?' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Instructor', exact: true }).count(), 0);
  await shot(page, 'dashboard-empty');
  await page.goto(`${srv.url}/#/admin`);
  await page.getByRole('heading', { name: 'Ready for a quiz?' }).waitFor();

  await page.getByRole('button', { name: 'Start quiz' }).click();
  await page.locator('dialog').getByRole('button', { name: 'Start quiz' }).click();
  await page.locator('[data-clock]:visible').waitFor();
  assert.match(await page.locator('[data-clock]:visible').textContent(), /^(30:00|29:5\d)$/);
  assert.equal(await page.locator('#navgrid button').count(), 20);
  for (let i = 0; i < 10; i++) {
    await page.locator('.option').nth(i % 4).click();
    await page.getByRole('button', { name: 'Next →' }).click();
  }
  await page.locator('.flag-button').click();
  await page.getByText('All answers saved').waitFor();
  await shot(page, 'quiz-desktop', false);

  await page.reload();
  await page.locator('[data-clock]:visible').waitFor();
  assert.equal(await page.locator('#answered-text').textContent(), '10 of 20 answered');
  assert.equal(await page.locator('#navgrid button.flagged').count(), 1);
  assert.equal(await page.locator('#navgrid button[aria-current="true"]').textContent(), '11');

  for (let i = 10; i < 18; i++) {
    await page.locator('#navgrid button').nth(i).click();
    await page.locator('.option').nth((i + 1) % 4).click();
  }
  assert.equal(await page.locator('#answered-text').textContent(), '18 of 20 answered');
  await page.locator('[data-submit-quiz]:visible').click();
  await page.locator('dialog').getByText('2 unanswered questions count as incorrect').waitFor();
  await page.locator('dialog').getByRole('button', { name: 'Submit quiz' }).click();
  await page.getByRole('heading', { name: 'Quiz results' }).waitFor();
  assert.equal(await page.locator('.review-item').count(), 20);
  await page.getByRole('button', { name: /^Unanswered/ }).click();
  assert.equal(await page.locator('.review-item:not([hidden])').count(), 2);
  await page.getByRole('button', { name: /^All/ }).click();
  await shot(page, 'review-desktop');

  await page.getByRole('link', { name: '← Back to dashboard' }).click();
  await page.getByRole('heading', { name: 'Quiz history' }).waitFor();
  assert.equal(await page.locator('#history-title ~ * tbody tr, section[aria-labelledby="history-title"] tbody tr').count(), 1);
  await shot(page, 'dashboard-after-one');
  await page.context().close();
});

await step('student on a phone: dashboard with history and the quiz fit the screen', async () => {
  const page = await open('omar-mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await signInAs(page, 'omar');
  await page.getByRole('heading', { name: 'Score trend' }).waitFor();
  assert.ok(await noSideScroll(page), 'dashboard has no horizontal scroll');
  await shot(page, 'dashboard-mobile');
  await page.getByRole('button', { name: 'Start quiz' }).click();
  await page.locator('dialog').getByRole('button', { name: 'Start quiz' }).click();
  await page.locator('[data-clock]:visible').waitFor();
  assert.ok(await noSideScroll(page), 'quiz has no horizontal scroll');
  await shot(page, 'quiz-mobile');
  await page.context().close();
});

await step('dark mode renders', async () => {
  const page = await open('omar-dark', { colorScheme: 'dark' });
  await signInAs(page, 'omar');
  await page.getByRole('button', { name: 'Resume quiz' }).click();
  await page.locator('[data-clock]:visible').waitFor();
  await shot(page, 'quiz-dark', false);
  await page.goto(`${srv.url}/#/`);
  await page.getByRole('heading', { name: 'Score trend' }).waitFor();
  await page.locator('#trend svg').hover({ position: { x: 300, y: 100 } });
  await page.locator('#trend .tooltip:not([hidden])').waitFor();
  await shot(page, 'dashboard-dark');
  await page.context().close();
});

await step('instructor: overview, students, student detail, review, questions, settings', async () => {
  const page = await open('instructor');
  await signInAs(page, 'instructor');
  await page.getByRole('link', { name: 'Instructor', exact: true }).click();
  await page.getByRole('heading', { name: 'Score distribution' }).waitFor();
  await shot(page, 'admin-overview');

  await page.getByRole('link', { name: 'Students', exact: true }).click();
  await page.locator('#student-rows tr').first().waitFor();
  assert.equal(await page.locator('#student-rows tr').count(), 10);
  await page.locator('#student-search').fill('omar');
  assert.equal(await page.locator('#student-rows tr').count(), 1);
  await page.locator('#student-search').fill('');
  await page.getByRole('button', { name: 'Average' }).click();
  await shot(page, 'admin-students');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  assert.match((await download).suggestedFilename(), /^matlab-quiz-students-\d{4}-\d{2}-\d{2}\.csv$/);

  await page.locator('#student-search').fill('omar');
  await page.locator('#student-rows tr').first().click();
  await page.getByRole('heading', { name: 'Omar Haddad' }).waitFor();
  await shot(page, 'admin-student');
  await page.getByRole('link', { name: 'Review' }).first().click();
  await page.getByRole('heading', { name: 'Quiz results' }).waitFor();
  await page.getByRole('link', { name: '← Back to Omar Haddad' }).click();
  await page.getByRole('heading', { name: 'Omar Haddad' }).waitFor();

  await page.goto(`${srv.url}/#/admin/questions`);
  await page.locator('#q-rows tr').first().waitFor();
  assert.equal(await page.locator('#q-rows tr').count(), 220);
  await page.locator('#q-sort').selectOption('hardest');
  await page.locator('#q-rows details').first().locator('summary').click();
  await shot(page, 'admin-questions', false);
  await page.locator('#q-sort').selectOption('id');
  await page.locator('#q-rows tr').first().locator('[data-active]').uncheck();
  await page.getByText('fun-01 is now off for new quizzes.').waitFor();

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.locator('#duration').fill('25');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByText('Saved: 20 questions in 25 minutes.').waitFor();
  await shot(page, 'admin-settings');
  const { rows } = await srv.db.query('select duration_minutes from quiz.settings');
  assert.equal(rows[0].duration_minutes, 25);
  const off = await srv.db.query("select active from quiz.questions where id = 'fun-01'");
  assert.equal(off.rows[0].active, false);
  await page.context().close();
});

await browser.close();
await srv.close();
console.log(steps.join('\n'));
const errors = problems.filter(p => !steps.some(s => s.includes(p)));
if (errors.length) console.log(`\nBrowser errors:\n  ${errors.join('\n  ')}`);
console.log(`\nScreenshots saved in ${shots}`);
process.exit(problems.length ? 1 : 0);
