// Boot, sign-in and hash routing.
import { api, configured, getSession, signIn, signOut, signInError, onSignedOut, ApiError } from './api.js';
import { $, esc, avatar, displayName } from './ui.js';
import { renderDashboard, renderQuiz, renderReview } from './student.js';
import { renderAdmin, renderAdminStudent } from './admin.js';

const config = window.QUIZ_CONFIG || {};
const main = $('#main');
const ctx = { main, me: null, navigate };
let cleanup = null;

const routes = [
  [/^\/?$/, () => renderDashboard(ctx), 'Dashboard'],
  [/^\/quiz$/, () => renderQuiz(ctx), 'Quiz'],
  [/^\/review\/([0-9a-f-]{36})$/, id => renderReview(ctx, id), 'Quiz results'],
  [/^\/admin(?:\/(students|questions|settings))?$/, tab => renderAdmin(ctx, tab || 'overview'), 'Instructor', true],
  [/^\/admin\/student\/([0-9a-f-]{36})$/, id => renderAdminStudent(ctx, id), 'Student', true]
];

function navigate(path, replace = false) {
  const hash = `#${path}`;
  if (location.hash === hash) return route();
  if (replace) { history.replaceState(null, '', hash); route(); }
  else location.hash = hash;
}

async function route() {
  if (!ctx.me) return;
  cleanup?.();
  cleanup = null;
  const path = location.hash.replace(/^#/, '') || '/';
  const match = routes.map(([re, view, title, admin]) => ({ m: path.match(re), view, title, admin })).find(r => r.m);
  if (!match || (match.admin && ctx.me.role !== 'admin')) return navigate('/', true);
  document.title = `${match.title} · MATLAB Quiz`;
  for (const a of document.querySelectorAll('#mainnav a')) {
    const current = a.dataset.section === (path.startsWith('/admin') ? 'admin' : 'student');
    current ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  }
  main.innerHTML = '<div class="loading" role="status">Loading…</div>';
  window.scrollTo(0, 0);
  try {
    cleanup = (await match.view(match.m[1])) || null;
  } catch (err) {
    showError(err);
  }
  main.focus({ preventScroll: true });
}

function showError(err) {
  if (err instanceof ApiError && (err.code === 'NOT_SIGNED_IN' || err.code === 'NOT_ENROLLED')) {
    return renderSignIn(err.code === 'NOT_ENROLLED' ? err.message : null);
  }
  console.error(err);
  main.innerHTML = `<section class="card" style="max-width:560px;margin:8vh auto 0">
    <h1 style="font-size:1.375rem">Something went wrong</h1>
    <p style="margin:10px 0 20px;color:var(--ink-2)">${esc(err.message || String(err))}</p>
    <button type="button" class="btn" id="retry">Try again</button>
    <a class="btn btn-ghost" href="#/">Go to dashboard</a></section>`;
  $('#retry').addEventListener('click', route);
}

function renderHeader() {
  const me = ctx.me;
  $('#mainnav').innerHTML = me ? `<a href="#/" data-section="student">Dashboard</a>
    ${me.role === 'admin' ? '<a href="#/admin" data-section="admin">Instructor</a>' : ''}` : '';
  $('#account').innerHTML = me ? `<div class="account">${avatar(me)}<span class="account-name">${esc(displayName(me))}</span>
    <button type="button" class="btn btn-ghost btn-sm" id="sign-out">Sign out</button></div>` : '';
  $('#sign-out')?.addEventListener('click', async () => {
    await signOut();
    location.hash = '';
    location.reload();
  });
}

const githubSettings = '<a href="https://github.com/settings/emails" target="_blank" rel="noopener">GitHub → Settings → Emails</a>';

function renderSignIn(error) {
  ctx.me = null;
  renderHeader();
  document.title = 'Sign in · MATLAB Quiz';
  const rejected = error && /database error|rowan|not allowed|saving new user|enrolled/i.test(error);
  main.innerHTML = `<div class="signin">
    <img src="icon.svg" alt="" width="56" height="56">
    <h1>MATLAB Quiz</h1>
    <p class="lede">${esc(config.courseCode || '')} · Timed practice quizzes that cover every topic from weeks 1–7.</p>
    <div class="card">
      ${error ? `<div class="notice notice-bad" role="alert">
        <span class="notice-title">${rejected ? 'This GitHub account cannot join the quiz' : 'Sign-in did not finish'}</span>
        ${rejected ? `Only GitHub accounts whose <em>primary</em> email is a Rowan address (ending in rowan.edu) can sign up.
          <ol><li>Open ${githubSettings}.</li><li>Add your Rowan email and verify it.</li>
          <li>Choose it as your <strong>Primary email address</strong>.</li><li>Come back and sign in again.</li></ol>`
          : esc(error)}</div>` : ''}
      <button type="button" class="btn btn-lg" id="sign-in">Sign in with GitHub</button>
      <ul class="rules">
        <li>Use a GitHub account whose primary email is your Rowan address.</li>
        <li>Each quiz is timed and mixes questions from every topic.</li>
        <li>Answers save as you go, and your progress is kept for the whole term.</li>
      </ul>
    </div></div>`;
  $('#sign-in').addEventListener('click', async event => {
    event.target.disabled = true;
    try { await signIn(); } catch (err) { event.target.disabled = false; renderSignIn(err.message); }
  });
}

function renderSetupNeeded() {
  main.innerHTML = `<section class="card" style="max-width:640px;margin:6vh auto 0">
    <h1 style="font-size:1.5rem;margin-bottom:12px">Almost ready</h1>
    <p>This copy of the quiz is not connected to a database yet. Open <code>site/config.js</code> and enter your
    Supabase project URL and anon (publishable) key, then reload. The README explains every step.</p></section>`;
}

async function boot() {
  $('#brand-course').textContent = config.courseCode || '';
  $('#footer').textContent = [config.courseCode, config.courseName, config.term].filter(Boolean).join(' · ');
  if (!configured) return renderSetupNeeded();
  const session = await getSession();
  if (!session) return renderSignIn(signInError);
  try {
    ctx.me = await api.whoami();
  } catch (err) {
    if (err.code === 'NOT_ENROLLED') await signOut();
    return err.code === 'NOT_SIGNED_IN' || err.code === 'NOT_ENROLLED' ? renderSignIn(err.message) : showError(err);
  }
  renderHeader();
  onSignedOut(() => renderSignIn(null));
  window.addEventListener('hashchange', route);
  route();
}

boot().catch(showError);
