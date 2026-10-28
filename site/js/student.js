// Student pages: progress dashboard, the timed quiz, and the results review.
import { api } from './api.js';
import { $, $$, esc, inline, richText, LETTERS, fmtDate, fmtDateTime, fmtDuration, fmtClock, pct, fmtPct,
  toast, dialog, statusLabel } from './ui.js';
import { scoreTrend, topicBars } from './charts.js';

let pendingStart = false;   // set when the student confirmed "Start quiz"
let lastReview = null;      // the review returned by submit, shown without refetching

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function renderDashboard(ctx) {
  const data = await api.dashboard();
  const s = data.settings;
  const active = data.active;
  let hero;
  if (active) {
    const left = new Date(active.deadline) - new Date(active.server_now);
    hero = `<section class="hero in-progress" aria-labelledby="hero-title">
      <div><h2 id="hero-title">You have a quiz in progress</h2>
        <div class="hero-facts"><span>About ${esc(fmtClock(left))} left</span><span>The timer keeps running while you are away</span></div></div>
      <button type="button" class="btn btn-lg" data-action="resume">Resume quiz</button></section>`;
  } else {
    hero = `<section class="hero" aria-labelledby="hero-title">
      <div><h2 id="hero-title">Ready for a quiz?</h2>
        <div class="hero-facts"><span>${s.question_count} questions</span><span>${s.duration_minutes} minutes</span>
          <span>All ${s.topics.filter(t => t.per_quiz > 0).length} topics</span><span>New questions each time</span></div></div>
      <button type="button" class="btn btn-lg" data-action="start">Start quiz</button></section>`;
  }
  ctx.main.innerHTML = `<div class="page-head"><div><h1>Hi, ${esc(firstName(ctx.me))}</h1>
      <p>Practice quizzes for weeks 1–7. Every quiz mixes questions from all topics.</p></div></div>
    ${hero}<div id="progress"></div>`;
  renderProgress($('#progress'), data, { reviewHref: id => `#/review/${id}` });

  ctx.main.querySelector('[data-action="resume"]')?.addEventListener('click', () => ctx.navigate('/quiz'));
  ctx.main.querySelector('[data-action="start"]')?.addEventListener('click', async () => {
    const ok = await dialog({
      title: 'Start a quiz?',
      body: `<p>You will get <strong>${s.question_count} questions</strong> covering every topic, and
        <strong>${s.duration_minutes} minutes</strong> to finish.</p>
        <p>The timer starts now and keeps running if you close the page. Your answers are saved as you go,
        and the quiz is submitted automatically when time runs out.</p>`,
      buttons: [{ label: 'Not yet', style: 'btn-secondary', value: false }, { label: 'Start quiz', value: true }]
    });
    if (!ok) return;
    pendingStart = true;
    ctx.navigate('/quiz');
  });
}

const firstName = me => (me.full_name || me.github_login || 'there').split(/\s+/)[0];

// Stat tiles, score trend, topic mastery and history. Shared with the admin's
// per-student page.
export function renderProgress(container, data, { reviewHref }) {
  const attempts = data.attempts;
  const scores = attempts.map(a => pct(a.score, a.total));
  const average = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const latest = scores.at(-1) ?? null;
  const delta = scores.length > 1 ? latest - scores.at(-2) : null;
  const deltaText = delta === null ? 'First quiz' : delta === 0 ? 'Same as the quiz before'
    : `<span class="${delta > 0 ? 'delta-up' : 'delta-down'}">${delta > 0 ? '▲' : '▼'} ${fmtPct(Math.abs(Math.round(delta * 10) / 10))}</span> vs the quiz before`;
  const answered = data.topics.reduce((n, t) => n + t.answered, 0);
  const correct = data.topics.reduce((n, t) => n + t.correct, 0);

  container.innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="tile-label">Quizzes taken</div><div class="tile-value">${attempts.length}</div>
        <div class="tile-note">${attempts.length ? `Last on ${fmtDate(attempts.at(-1).started_at)}` : 'None yet'}</div></div>
      <div class="tile"><div class="tile-label">Average score</div><div class="tile-value">${fmtPct(average === null ? null : Math.round(average * 10) / 10)}</div>
        <div class="tile-note">${answered ? `${correct} of ${answered} questions right` : '—'}</div></div>
      <div class="tile"><div class="tile-label">Best score</div><div class="tile-value">${fmtPct(scores.length ? Math.max(...scores) : null)}</div>
        <div class="tile-note">${scores.length ? 'Your highest so far' : '—'}</div></div>
      <div class="tile"><div class="tile-label">Latest score</div><div class="tile-value">${fmtPct(latest)}</div>
        <div class="tile-note">${attempts.length ? deltaText : '—'}</div></div>
    </div>
    <div class="grid-2">
      <section class="card" aria-labelledby="trend-title">
        <div class="card-head"><h2 id="trend-title">Score trend</h2><p>Percent correct, quiz by quiz</p></div>
        <div id="trend"></div>
      </section>
      <section class="card" aria-labelledby="focus-title">
        <div class="card-head"><h2 id="focus-title">Where to focus</h2><p>Lowest topics so far</p></div>
        ${focusList(data.topics, attempts.length)}
      </section>
    </div>
    <section class="card" aria-labelledby="topics-title">
      <div class="card-head"><h2 id="topics-title">Topic mastery</h2><p>Percent correct per topic, all quizzes combined</p></div>
      <div id="topic-bars"></div>
    </section>
    <section class="card" aria-labelledby="history-title">
      <div class="card-head"><h2 id="history-title">Quiz history</h2><p>${attempts.length ? 'Open a quiz to see every answer explained' : ''}</p></div>
      ${attempts.length ? `<div class="table-wrap"><table>
        <thead><tr><th class="hide-sm">#</th><th>Date</th><th class="num">Score</th><th class="num">Percent</th><th class="num hide-sm">Time used</th><th class="hide-sm">Status</th><th><span class="sr-only">Review</span></th></tr></thead>
        <tbody>${attempts.map((a, i) => `<tr>
          <td class="hide-sm">${i + 1}</td><td style="white-space:nowrap">${esc(fmtDateTime(a.started_at))}</td>
          <td class="num" style="white-space:nowrap">${a.score} / ${a.total}</td><td class="num">${fmtPct(pct(a.score, a.total))}</td>
          <td class="num hide-sm">${fmtDuration(a.seconds_used)}</td>
          <td class="hide-sm">${a.status === 'expired' ? statusLabel('warn', 'Time ran out') : statusLabel('good', 'Submitted')}</td>
          <td><a href="${reviewHref(a.id)}">Review</a></td></tr>`).reverse().join('')}</tbody></table></div>`
      : '<p class="muted">No quizzes yet. Your results and explanations will be listed here.</p>'}
    </section>`;

  scoreTrend($('#trend', container), attempts.map((a, i) => ({
    value: pct(a.score, a.total), label: `Quiz ${i + 1} · ${fmtDate(a.started_at)} · ${a.score}/${a.total}`
  })));
  topicBars($('#topic-bars', container), data.topics, { twoColumns: true });
}

function focusList(topics, attemptCount) {
  if (!attemptCount) {
    return '<p class="muted">After your first quiz, the three topics where you lost the most points will appear here.</p>';
  }
  const weakest = topics.filter(t => t.answered)
    .map(t => ({ ...t, value: Math.round((t.correct / t.answered) * 100) }))
    .sort((a, b) => a.value - b.value || b.answered - a.answered).slice(0, 3);
  return `<ol class="focus-list">${weakest.map(t => `<li><div><div class="focus-name">${esc(t.title)}</div>
      <div class="focus-meta">${esc(t.week)} · ${t.correct} of ${t.answered} correct</div></div>
      <span class="focus-value">${t.value}%</span></li>`).join('')}</ol>
    <p class="focus-note">Review the slides for these weeks, then take another quiz. New quizzes favor questions you have not seen yet.</p>`;
}

// ---------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------

export async function renderQuiz(ctx) {
  let payload;
  if (pendingStart) {
    pendingStart = false;
    payload = await api.startQuiz();
  } else {
    const dash = await api.dashboard();
    if (!dash.active) { ctx.navigate('/', true); return; }
    payload = await api.startQuiz();   // resumes the open attempt
  }
  return quizSession(ctx, payload);
}

function quizSession(ctx, payload) {
  const key = `mq.quiz.${payload.attempt_id}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key)) || {}; } catch (_) {}
  const q = {
    id: payload.attempt_id,
    questions: payload.questions,
    deadline: new Date(payload.deadline).getTime(),
    offset: new Date(payload.server_now).getTime() - Date.now(),
    answers: Object.fromEntries(payload.questions.filter(x => x.choice !== null).map(x => [x.position, x.choice])),
    flags: new Set(saved.flags || []),
    index: Math.min(saved.index || 0, payload.questions.length - 1),
    pending: new Map(),
    saving: false,
    finishing: false,
    warned: 0
  };
  const total = q.questions.length;
  const remaining = () => q.deadline - (Date.now() + q.offset);
  const answeredCount = () => Object.keys(q.answers).length;
  const persist = () => {
    try { localStorage.setItem(key, JSON.stringify({ flags: [...q.flags], index: q.index })); } catch (_) {}
  };

  ctx.main.innerHTML = `<div class="quiz-layout">
    <div>
      <div class="quiz-bar" id="quiz-bar">
        <span class="quiz-bar-time" role="timer"><span data-clock>--:--</span><small>left</small></span>
        <span class="quiz-bar-count" data-answered-short></span>
        <button type="button" class="btn btn-sm" data-submit-quiz>Submit</button>
      </div>
      <section class="card question-card" id="question"></section>
    </div>
    <aside class="quiz-side" aria-label="Quiz progress">
      <div class="card timer" id="timer"><div class="timer-label">Time left</div>
        <div class="timer-value" data-clock role="timer">--:--</div>
        <div class="timer-note" id="timer-note"></div></div>
      <div class="card">
        <div class="progress-text"><span id="answered-text"></span><span id="flag-text"></span></div>
        <div class="progressbar" aria-hidden="true"><span id="progress-fill"></span></div>
        <div class="navgrid" id="navgrid" role="group" aria-label="Jump to question"></div>
        <div class="nav-legend"><span><i class="legend-box answered"></i>Answered</span><span><i class="legend-box"></i>Not answered</span><span>⚑ Flagged</span></div>
      </div>
      <button type="button" class="btn btn-lg" data-submit-quiz>Submit quiz</button>
      <div class="save-state" id="save-state" aria-live="polite"></div>
    </aside></div>
    <p class="sr-only" id="time-alert" aria-live="assertive"></p>`;
  const submitButtons = $$('[data-submit-quiz]');

  const setSaveState = (text, error = false) => {
    const el = $('#save-state');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', error);
  };

  function renderNav() {
    $('#navgrid').innerHTML = q.questions.map((x, i) => {
      const answered = q.answers[x.position] !== undefined;
      const flagged = q.flags.has(x.position);
      const label = `Question ${i + 1}, ${answered ? 'answered' : 'not answered'}${flagged ? ', flagged' : ''}`;
      return `<button type="button" data-index="${i}" class="${answered ? 'answered' : ''} ${flagged ? 'flagged' : ''}"
        aria-label="${label}" ${i === q.index ? 'aria-current="true"' : ''}>${i + 1}</button>`;
    }).join('');
    const n = answeredCount();
    $('#answered-text').textContent = `${n} of ${total} answered`;
    $('[data-answered-short]').textContent = `${n}/${total} answered`;
    $('#flag-text').textContent = q.flags.size ? `⚑ ${q.flags.size} flagged` : '';
    $('#progress-fill').style.width = `${(n / total) * 100}%`;
  }

  function renderQuestion() {
    const x = q.questions[q.index];
    const chosen = q.answers[x.position];
    const flagged = q.flags.has(x.position);
    $('#question').innerHTML = `
      <div class="question-meta"><span><strong>Question ${q.index + 1}</strong> of ${total}</span><span>${esc(x.topic)}</span></div>
      <div class="prompt" id="prompt">${richText(x.prompt)}</div>
      <fieldset class="options" aria-labelledby="prompt">
        <legend class="sr-only">Choose one answer</legend>
        ${x.options.map((text, i) => `<label class="option">
          <input type="radio" name="answer" value="${i}" ${chosen === i ? 'checked' : ''}>
          <span class="letter" aria-hidden="true">${LETTERS[i]}</span>
          <span class="option-text"><span class="sr-only">${LETTERS[i]}. </span>${inline(text)}</span></label>`).join('')}
      </fieldset>
      <div class="question-actions">
        <button type="button" class="btn btn-secondary" data-go="-1" ${q.index === 0 ? 'disabled' : ''}>← Previous</button>
        <button type="button" class="btn btn-ghost flag-button" aria-pressed="${flagged}">⚑ ${flagged ? 'Flagged' : 'Flag for review'}</button>
        ${chosen !== undefined ? '<button type="button" class="btn btn-ghost" data-clear>Clear answer</button>' : ''}
        <span class="spacer"></span>
        ${q.index < total - 1 ? '<button type="button" class="btn" data-go="1">Next →</button>'
          : '<button type="button" class="btn" data-submit>Review &amp; submit</button>'}
      </div>`;
  }

  function go(index) {
    q.index = Math.max(0, Math.min(total - 1, index));
    persist();
    renderQuestion();
    renderNav();
    $('#question').scrollIntoView({ block: 'nearest', behavior: 'instant' });
    $('#question .prompt')?.setAttribute('tabindex', '-1');
    $('#question .prompt')?.focus({ preventScroll: true });
  }

  async function flush() {
    if (q.saving || !q.pending.size || q.finishing) return;
    q.saving = true;
    setSaveState('Saving…');
    const [position, choice] = q.pending.entries().next().value;
    q.pending.delete(position);
    try {
      const result = await api.saveAnswer(q.id, position, choice);
      q.saving = false;
      if (result && result.ok === false) { finish('closed'); return; }
      setSaveState(q.pending.size ? 'Saving…' : 'All answers saved');
      flush();
    } catch (err) {
      q.saving = false;
      if (!q.pending.has(position)) q.pending.set(position, choice);
      setSaveState('Not saved yet. Retrying…', true);
      setTimeout(flush, 4000);
    }
  }

  function choose(choice) {
    const x = q.questions[q.index];
    if (choice === null) delete q.answers[x.position];
    else q.answers[x.position] = choice;
    q.pending.set(x.position, choice);
    renderNav();
    flush();
  }

  async function finish(reason) {
    if (q.finishing) return;
    q.finishing = true;
    clearInterval(timer);
    const message = reason === 'time' || reason === 'closed' ? 'Time is up. Submitting your quiz…' : 'Submitting…';
    setSaveState(message);
    submitButtons.forEach(b => { b.disabled = true; });
    const answers = Object.fromEntries(q.questions.map(x => [x.position, q.answers[x.position] ?? null]));
    for (let tries = 1; ; tries++) {
      try {
        lastReview = await api.submitQuiz(q.id, answers);
        break;
      } catch (err) {
        if (tries >= (reason === 'manual' ? 3 : 10)) {
          if (reason === 'manual' && remaining() > 0) {
            q.finishing = false;
            submitButtons.forEach(b => { b.disabled = false; });
            setSaveState(err.message, true);
            toast('Could not submit. Check your connection and try again.');
            timer = setInterval(tick, 500);
          } else {
            setSaveState('Could not reach the server. Your saved answers will be graded automatically; check your dashboard later.', true);
          }
          return;
        }
        setSaveState('Could not reach the server. Retrying…', true);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    try { localStorage.removeItem(key); } catch (_) {}
    toast(lastReview.status === 'expired' ? 'Time ran out. Your saved answers were graded.' : 'Quiz submitted.');
    ctx.navigate(`/review/${q.id}`);
  }

  function tick() {
    const left = remaining();
    $$('[data-clock]').forEach(el => { el.textContent = fmtClock(left); });
    for (const card of [$('#timer'), $('#quiz-bar')]) {
      card.classList.toggle('warn', left <= 5 * 60000 && left > 60000);
      card.classList.toggle('critical', left <= 60000);
    }
    const warning = left <= 60000 ? 2 : left <= 5 * 60000 ? 1 : 0;
    if (warning > q.warned) {
      q.warned = warning;
      const text = warning === 2 ? 'Less than 1 minute left' : '5 minutes left';
      $('#timer-note').textContent = `⚠ ${text}`;
      $('#time-alert').textContent = text;
    }
    if (left <= 0) finish('time');
  }

  $('#question').addEventListener('change', event => {
    if (event.target.name === 'answer') {
      choose(Number(event.target.value));
      renderQuestion();
      $(`#question input[value="${event.target.value}"]`)?.focus();
    }
  });
  $('#question').addEventListener('click', event => {
    const nav = event.target.closest('[data-go]');
    if (nav) return go(q.index + Number(nav.dataset.go));
    if (event.target.closest('.flag-button')) {
      const pos = q.questions[q.index].position;
      q.flags.has(pos) ? q.flags.delete(pos) : q.flags.add(pos);
      persist();
      renderQuestion();
      renderNav();
      $('#question .flag-button')?.focus();
      return;
    }
    if (event.target.closest('[data-clear]')) { choose(null); renderQuestion(); return; }
    if (event.target.closest('[data-submit]')) confirmSubmit();
  });
  $('#navgrid').addEventListener('click', event => {
    const button = event.target.closest('button[data-index]');
    if (button) go(Number(button.dataset.index));
  });
  submitButtons.forEach(b => b.addEventListener('click', confirmSubmit));

  async function confirmSubmit() {
    const unanswered = total - answeredCount();
    const ok = await dialog({
      title: 'Submit your quiz?',
      body: `<p>You answered <strong>${answeredCount()} of ${total}</strong> questions.</p>
        ${unanswered ? `<p>${unanswered} unanswered ${unanswered === 1 ? 'question counts' : 'questions count'} as incorrect.</p>` : ''}
        ${q.flags.size ? `<p>⚑ ${q.flags.size} ${q.flags.size === 1 ? 'question is' : 'questions are'} still flagged for review.</p>` : ''}
        <p>You cannot change your answers after submitting.</p>`,
      buttons: [{ label: 'Keep working', style: 'btn-secondary', value: false }, { label: 'Submit quiz', value: true }]
    });
    if (ok) finish('manual');
  }

  const beforeUnload = event => {
    if (q.pending.size || q.saving) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('beforeunload', beforeUnload);

  renderQuestion();
  renderNav();
  setSaveState(answeredCount() ? 'Your saved answers were restored' : 'Answers save automatically');
  let timer = setInterval(tick, 500);
  tick();

  return () => {
    clearInterval(timer);
    window.removeEventListener('beforeunload', beforeUnload);
  };
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export async function renderReview(ctx, attemptId) {
  const data = lastReview?.attempt_id === attemptId ? lastReview : await api.review(attemptId);
  lastReview = null;
  const items = data.items;
  const correct = items.filter(i => i.is_correct).length;
  const unanswered = items.filter(i => i.choice === null).length;
  const wrong = items.length - correct - unanswered;
  const ownAttempt = data.student.id === ctx.me.id;
  const back = ownAttempt ? '<a class="back-link" href="#/">← Back to dashboard</a>'
    : `<a class="back-link" href="#/admin/student/${esc(data.student.id)}">← Back to ${esc(data.student.full_name || data.student.github_login || 'student')}</a>`;

  const byTopic = new Map();
  for (const item of [...items].sort((a, b) => a.topic_order - b.topic_order)) {
    const t = byTopic.get(item.topic) || { total: 0, correct: 0 };
    t.total++;
    if (item.is_correct) t.correct++;
    byTopic.set(item.topic, t);
  }

  ctx.main.innerHTML = `${back}
    <div class="page-head"><div><h1>Quiz results</h1>
      <p>${ownAttempt ? '' : `${esc(data.student.full_name || data.student.github_login)} · `}${esc(fmtDateTime(data.started_at))}</p></div></div>
    <section class="card"><div class="score-hero">
      <div class="score-number">${data.score}<small> / ${data.total}</small></div>
      <div class="score-facts">
        <div><strong>${fmtPct(pct(data.score, data.total))}</strong> correct</div>
        <div>Time used: ${fmtDuration(data.seconds_used)}</div>
        <div>${data.status === 'expired' ? statusLabel('warn', 'Time ran out — saved answers were graded') : statusLabel('good', 'Submitted on time')}</div>
      </div></div></section>
    <section class="card" aria-labelledby="by-topic">
      <div class="card-head"><h2 id="by-topic">By topic</h2><p>This quiz only</p></div>
      <div class="table-wrap"><table><thead><tr><th>Topic</th><th class="num">Correct</th><th class="num">Percent</th></tr></thead>
        <tbody>${[...byTopic].map(([topic, t]) => `<tr><td>${esc(topic)}</td><td class="num">${t.correct} / ${t.total}</td>
          <td class="num">${fmtPct(pct(t.correct, t.total))}</td></tr>`).join('')}</tbody></table></div>
    </section>
    <div class="filter-row" role="group" aria-label="Show questions">
      <button type="button" class="chip" data-filter="all" aria-pressed="true">All (${items.length})</button>
      <button type="button" class="chip" data-filter="wrong" aria-pressed="false">Incorrect (${wrong})</button>
      <button type="button" class="chip" data-filter="unanswered" aria-pressed="false">Unanswered (${unanswered})</button>
      <button type="button" class="chip" data-filter="correct" aria-pressed="false">Correct (${correct})</button>
    </div>
    <div class="stack" id="review-items">${items.map(reviewItem).join('')}</div>`;

  ctx.main.querySelector('.filter-row').addEventListener('click', event => {
    const chip = event.target.closest('[data-filter]');
    if (!chip) return;
    $$('.chip', ctx.main).forEach(c => c.setAttribute('aria-pressed', String(c === chip)));
    for (const el of $$('.review-item', ctx.main)) {
      const f = chip.dataset.filter;
      el.hidden = !(f === 'all' || el.dataset.state === f);
    }
  });
}

function reviewItem(item) {
  const state = item.is_correct ? 'correct' : item.choice === null ? 'unanswered' : 'wrong';
  const badge = state === 'correct' ? statusLabel('good', 'Correct')
    : state === 'wrong' ? statusLabel('bad', 'Incorrect') : statusLabel('neutral', 'Not answered');
  return `<article class="card review-item ${state}" data-state="${state}">
    <div class="question-meta"><span><strong>Question ${item.position}</strong> · ${esc(item.topic)} · ${esc(item.difficulty)}</span>${badge}</div>
    <div class="prompt">${richText(item.prompt)}</div>
    <ol class="review-options">${item.options.map((o, i) => {
      const isCorrect = i === item.correct, chosen = i === item.choice;
      const cls = isCorrect ? 'is-correct' : chosen ? 'is-chosen-wrong' : '';
      const tags = [isCorrect ? statusLabel('good', 'Correct answer') : '', chosen ? statusLabel(isCorrect ? 'good' : 'bad', 'Your answer') : ''].join('');
      return `<li class="review-option ${cls}"><span class="letter" aria-hidden="true">${LETTERS[i]}</span>
        <div class="option-text"><span class="sr-only">${LETTERS[i]}. </span>${inline(o.text)}</div>
        ${tags ? `<div class="tags">${tags}</div>` : ''}
        <div class="why">${inline(o.explanation)}</div></li>`;
    }).join('')}</ol>
    ${item.source ? `<p class="source">Source: ${esc(item.source)}</p>` : ''}
  </article>`;
}
