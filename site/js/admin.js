// Instructor pages: class overview, student roster, question statistics and
// quiz settings. The database refuses these calls for anyone but admins.
import { api } from './api.js';
import { $, $$, esc, inline, richText, LETTERS, fmtDate, fmtPct, pct, relativeTime, toast, statusLabel, avatar,
  displayName } from './ui.js';
import { histogram, topicBars } from './charts.js';
import { renderProgress } from './student.js';

const TABS = [['overview', 'Overview', '#/admin'], ['students', 'Students', '#/admin/students'],
  ['questions', 'Questions', '#/admin/questions'], ['settings', 'Settings', '#/admin/settings']];

function tabs(active) {
  return `<nav class="tabs" aria-label="Admin sections">${TABS.map(([id, label, href]) =>
    `<a href="${href}" ${id === active ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
}

export async function renderAdmin(ctx, tab) {
  const head = `<div class="page-head"><div><h1>Instructor</h1><p>Class progress and quiz settings.</p></div></div>${tabs(tab)}`;
  if (tab === 'questions') return renderQuestions(ctx, head);
  const data = await api.adminOverview();
  if (tab === 'students') return renderStudents(ctx, head, data);
  if (tab === 'settings') return renderSettings(ctx, head, data.settings);
  return renderOverview(ctx, head, data);
}

function renderOverview(ctx, head, data) {
  const c = data.class;
  const bins = [...Array(10)].map((_, i) => ({ label: i === 9 ? '90–100%' : `${i * 10}–${i * 10 + 9}%`, count: 0 }));
  for (const score of data.scores) bins[Math.min(9, Math.floor(Number(score) / 10))].count++;
  const low = data.students.filter(s => s.attempts && Number(s.average_pct) < 60)
    .sort((a, b) => a.average_pct - b.average_pct);
  const none = data.students.filter(s => !s.attempts);
  const watch = [...low, ...none].slice(0, 6);
  ctx.main.innerHTML = `${head}
    <div class="tiles">
      <div class="tile"><div class="tile-label">Students signed up</div><div class="tile-value">${c.students}</div>
        <div class="tile-note">${c.active_students} have taken a quiz</div></div>
      <div class="tile"><div class="tile-label">Quizzes submitted</div><div class="tile-value">${c.attempts}</div>
        <div class="tile-note">${c.last_7_days} in the last 7 days</div></div>
      <div class="tile"><div class="tile-label">Class average</div><div class="tile-value">${fmtPct(c.average_pct)}</div>
        <div class="tile-note">Across all submitted quizzes</div></div>
      <div class="tile"><div class="tile-label">Quiz format</div><div class="tile-value">${data.settings.question_count} Q</div>
        <div class="tile-note">${data.settings.duration_minutes} minutes · <a href="#/admin/settings">change</a></div></div>
    </div>
    <div class="grid-2">
      <section class="card" aria-labelledby="dist-title">
        <div class="card-head"><h2 id="dist-title">Score distribution</h2><p>Number of quizzes by percent correct</p></div>
        <div id="dist"></div>
      </section>
      <section class="card" aria-labelledby="watch-title">
        <div class="card-head"><h2 id="watch-title">Students to check on</h2><p>Average under 60%, or no quizzes yet</p></div>
        ${watch.length ? `<ol class="focus-list">${watch.map(s => `<li><div>
            <div class="focus-name"><a href="#/admin/student/${esc(s.id)}">${esc(displayName(s))}</a></div>
            <div class="focus-meta">${s.attempts ? `${s.attempts} ${s.attempts === 1 ? 'quiz' : 'quizzes'} · last ${esc(relativeTime(s.last_at))}`
              : `No quizzes yet · joined ${esc(fmtDate(s.joined))}`}</div></div>
            <span class="focus-value">${s.attempts ? fmtPct(s.average_pct) : '—'}</span></li>`).join('')}</ol>
          ${low.length + none.length > watch.length ? `<p class="focus-note"><a href="#/admin/students">See all students</a></p>` : ''}`
          : '<p class="muted">Everyone has taken a quiz and averages 60% or more.</p>'}
      </section>
    </div>
    <section class="card" aria-labelledby="class-topics">
      <div class="card-head"><h2 id="class-topics">Class accuracy by topic</h2><p>Percent correct across all students and quizzes</p></div>
      <div id="class-bars"></div>
    </section>`;
  histogram($('#dist'), bins, { edges: [...Array(11)].map((_, i) => i * 10), format: v => `${v}%` });
  topicBars($('#class-bars'), data.topics, { minAnswered: 10, twoColumns: true });
}

const SORTS = {
  name: s => (s.full_name || s.github_login || s.email || '').toLowerCase(),
  attempts: s => s.attempts,
  average: s => s.average_pct ?? -1,
  best: s => s.best_pct ?? -1,
  last: s => s.last_pct ?? -1,
  active: s => s.last_at ? new Date(s.last_at).getTime() : 0
};

function renderStudents(ctx, head, data) {
  let sort = 'name', ascending = true, query = '';
  ctx.main.innerHTML = `${head}
    <section class="card">
      <div class="toolbar">
        <input class="input" type="search" id="student-search" placeholder="Search name, GitHub login or email" aria-label="Search students">
        <span class="muted small" id="student-count"></span>
        <span style="flex:1"></span>
        <button type="button" class="btn btn-secondary btn-sm" id="export">Download CSV</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th><button class="sort" data-sort="name">Student</button></th>
          <th class="num"><button class="sort" data-sort="attempts">Quizzes</button></th>
          <th class="num"><button class="sort" data-sort="average">Average</button></th>
          <th class="num"><button class="sort" data-sort="best">Best</button></th>
          <th class="num"><button class="sort" data-sort="last">Latest</button></th>
          <th><button class="sort" data-sort="active">Last quiz</button></th>
        </tr></thead>
        <tbody id="student-rows"></tbody></table></div>
    </section>`;

  const rows = () => {
    const q = query.toLowerCase();
    const list = data.students.filter(s => !q || [s.full_name, s.github_login, s.email].some(v => v?.toLowerCase().includes(q)));
    list.sort((a, b) => {
      const x = SORTS[sort](a), y = SORTS[sort](b);
      return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
    });
    return list;
  };
  const draw = () => {
    const list = rows();
    $('#student-count').textContent = `${list.length} of ${data.students.length} students`;
    $('#student-rows').innerHTML = list.length ? list.map(s => `<tr class="clickable" data-id="${esc(s.id)}">
      <td><div class="account">${avatar(s)}<div><a href="#/admin/student/${esc(s.id)}">${esc(displayName(s))}</a>
        <div class="muted small">${esc(s.github_login ? '@' + s.github_login : '')}${s.github_login && s.email ? ' · ' : ''}${esc(s.email)}</div></div></div></td>
      <td class="num">${s.attempts}</td><td class="num">${fmtPct(s.average_pct)}</td><td class="num">${fmtPct(s.best_pct)}</td>
      <td class="num">${fmtPct(s.last_pct)}</td>
      <td>${s.in_progress ? statusLabel('neutral', 'Taking a quiz now') : esc(relativeTime(s.last_at))}</td></tr>`).join('')
      : `<tr><td colspan="6" class="muted">${data.students.length ? 'No students match your search.' : 'No students have signed in yet.'}</td></tr>`;
    for (const b of $$('button.sort', ctx.main)) {
      if (b.dataset.sort === sort) b.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
      else b.removeAttribute('aria-sort');
    }
  };
  $('#student-search').addEventListener('input', e => { query = e.target.value; draw(); });
  ctx.main.querySelector('thead').addEventListener('click', e => {
    const b = e.target.closest('button.sort');
    if (!b) return;
    ascending = b.dataset.sort === sort ? !ascending : b.dataset.sort === 'name';
    sort = b.dataset.sort;
    draw();
  });
  $('#student-rows').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && !e.target.closest('a')) ctx.navigate(`/admin/student/${tr.dataset.id}`);
  });
  $('#export').addEventListener('click', () => downloadCsv(rows()));
  draw();
}

function downloadCsv(students) {
  const cell = v => {
    const s = String(v ?? '');
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;   // keep spreadsheets from running formulas
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const header = ['Name', 'GitHub login', 'Email', 'Joined', 'Quizzes', 'Average %', 'Best %', 'Latest %', 'Last quiz'];
  const lines = [header, ...students.map(s => [s.full_name, s.github_login, s.email, fmtDate(s.joined), s.attempts,
    s.average_pct, s.best_pct, s.last_pct, s.last_at ? new Date(s.last_at).toISOString() : ''])].map(r => r.map(cell).join(','));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `matlab-quiz-students-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function renderAdminStudent(ctx, id) {
  const data = await api.adminStudent(id);
  const p = data.profile;
  ctx.main.innerHTML = `<a class="back-link" href="#/admin/students">← All students</a>
    <div class="page-head"><div class="account">${avatar(p)}<div><h1>${esc(displayName(p))}</h1>
      <p>${esc(p.github_login ? '@' + p.github_login + ' · ' : '')}${esc(p.email)} · joined ${esc(fmtDate(p.created_at))}</p></div></div>
      ${data.active ? statusLabel('neutral', 'Taking a quiz now') : ''}</div>
    <div id="progress"></div>`;
  renderProgress($('#progress'), data, { reviewHref: attempt => `#/review/${attempt}` });
}

async function renderQuestions(ctx, head) {
  const questions = await api.adminQuestions();
  const topics = [...new Map(questions.map(q => [q.topic_id, q.topic])).entries()];
  let topic = '', query = '', sort = 'id';
  ctx.main.innerHTML = `${head}
    <section class="card">
      <div class="toolbar">
        <select class="input" id="q-topic" aria-label="Filter by topic"><option value="">All topics</option>
          ${topics.map(([id, title]) => `<option value="${esc(id)}">${esc(title)}</option>`).join('')}</select>
        <input class="input" type="search" id="q-search" placeholder="Search question text or ID" aria-label="Search questions">
        <select class="input" id="q-sort" aria-label="Sort questions" style="flex:0 1 220px">
          <option value="id">Sort by topic</option><option value="hardest">Hardest first</option>
          <option value="easiest">Easiest first</option><option value="served">Most shown first</option></select>
      </div>
      <p class="muted small" style="margin-bottom:12px">Turning a question off removes it from new quizzes; past results keep it.
        Accuracy counts students only. Questions under 30% (with at least 5 answers) are marked for a second look.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Question</th><th>Topic</th><th class="num">Shown</th><th class="num">Correct</th><th>In quizzes</th></tr></thead>
        <tbody id="q-rows"></tbody></table></div>
    </section>`;

  const accuracy = q => q.served ? q.correct / q.served : null;
  const draw = () => {
    const text = query.toLowerCase();
    let list = questions.filter(q => (!topic || q.topic_id === topic)
      && (!text || q.id.includes(text) || q.prompt.toLowerCase().includes(text)));
    if (sort === 'hardest') list = list.filter(q => q.served).sort((a, b) => accuracy(a) - accuracy(b));
    if (sort === 'easiest') list = list.filter(q => q.served).sort((a, b) => accuracy(b) - accuracy(a));
    if (sort === 'served') list = [...list].sort((a, b) => b.served - a.served);
    $('#q-rows').innerHTML = list.map(q => {
      const acc = accuracy(q);
      const flag = q.served >= 5 && acc < 0.3 ? statusLabel('warn', 'Check wording') : '';
      const firstLine = q.prompt.split('\n')[0];
      return `<tr data-id="${esc(q.id)}">
        <td style="min-width:280px"><details><summary><strong>${esc(q.id)}</strong> · ${esc(q.difficulty)} — ${inline(firstLine)} ${flag}</summary>
          <div class="prompt" style="margin-top:10px">${richText(q.prompt)}</div>
          <ol class="review-options">${q.options.map((o, i) => `<li class="review-option ${i === q.answer ? 'is-correct' : ''}">
            <span class="letter" aria-hidden="true">${LETTERS[i]}</span><div class="option-text">${inline(o.text)}</div>
            ${i === q.answer ? `<div class="tags">${statusLabel('good', 'Correct answer')}</div>` : ''}
            <div class="why">${inline(o.explanation)}</div></li>`).join('')}</ol>
          ${q.source ? `<p class="source">Source: ${esc(q.source)}</p>` : ''}</details></td>
        <td>${esc(q.topic)}</td><td class="num">${q.served}</td>
        <td class="num">${acc === null ? '—' : `${fmtPct(pct(q.correct, q.served))}`}</td>
        <td><label><input type="checkbox" data-active ${q.active ? 'checked' : ''}> <span class="sr-only">Use ${esc(q.id)} in quizzes</span>${q.active ? 'On' : 'Off'}</label></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">No questions match.</td></tr>';
  };
  $('#q-topic').addEventListener('change', e => { topic = e.target.value; draw(); });
  $('#q-search').addEventListener('input', e => { query = e.target.value; draw(); });
  $('#q-sort').addEventListener('change', e => { sort = e.target.value; draw(); });
  $('#q-rows').addEventListener('change', async e => {
    if (!e.target.matches('[data-active]')) return;
    const id = e.target.closest('tr').dataset.id;
    const q = questions.find(x => x.id === id);
    e.target.disabled = true;
    try {
      await api.adminSetQuestionActive(id, e.target.checked);
      q.active = e.target.checked;
      toast(`${id} is now ${q.active ? 'on' : 'off'} for new quizzes.`);
    } catch (err) {
      e.target.checked = q.active;
      toast(err.message);
    }
    draw();
  });
  draw();
}

function renderSettings(ctx, head, settings) {
  ctx.main.innerHTML = `${head}
    <form class="card" id="settings-form">
      <div class="card-head"><h2>Quiz format</h2><p>Applies to quizzes started after you save</p></div>
      <div class="field" style="max-width:240px;margin-bottom:24px">
        <label for="duration">Time limit (minutes)</label>
        <input class="input" type="number" id="duration" min="5" max="180" required value="${settings.duration_minutes}">
      </div>
      <h3 style="margin-bottom:12px">Questions per topic</h3>
      <div class="settings-grid">
        <span class="muted small">Topic</span><span class="muted small">Per quiz</span><span class="muted small avail">In the bank</span>
        ${settings.topics.map(t => `<label for="t-${esc(t.id)}">${esc(t.title)} <span class="muted small">· ${esc(t.week)}</span></label>
          <input class="input" type="number" id="t-${esc(t.id)}" data-topic="${esc(t.id)}" min="0" max="10" value="${t.per_quiz}">
          <span class="muted small avail">${t.available} active</span>`).join('')}
      </div>
      <p style="margin-top:20px"><strong id="total-q"></strong> <span class="muted" id="total-note"></span></p>
      <div style="margin-top:20px"><button class="btn" type="submit">Save settings</button></div>
    </form>`;
  const form = $('#settings-form');
  const update = () => {
    let total = 0;
    for (const input of $$('[data-topic]', form)) {
      const t = settings.topics.find(x => x.id === input.dataset.topic);
      total += Math.min(Number(input.value) || 0, t.available);
    }
    const minutes = Number($('#duration').value) || 0;
    $('#total-q').textContent = `${total} questions per quiz`;
    $('#total-note').textContent = total && minutes ? `· about ${Math.round((minutes * 60) / total)} seconds per question` : '';
  };
  form.addEventListener('input', update);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const perTopic = Object.fromEntries($$('[data-topic]', form).map(i => [i.dataset.topic, Number(i.value)]));
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const saved = await api.adminUpdateSettings(Number($('#duration').value), perTopic);
      Object.assign(settings, saved);
      toast(`Saved: ${saved.question_count} questions in ${saved.duration_minutes} minutes.`);
    } catch (err) {
      toast(err.message);
    }
    button.disabled = false;
  });
  update();
}
