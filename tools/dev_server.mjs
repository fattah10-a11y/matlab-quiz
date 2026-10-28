// Local preview without Supabase: serves site/, runs the real schema in an
// in-memory Postgres, and imitates the Supabase endpoints the site uses
// (GitHub sign-in is replaced by a page of demo accounts).
// Run with: npm run dev   then open http://localhost:8787
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createLocalDb, signUp, rpc, root } from './localdb.mjs';

const SITE = join(root, 'site');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

const ACCOUNTS = [
  { key: 'jane', name: 'Jane Rivera', login: 'jrivera', email: 'riveraj7@students.rowan.edu', note: 'New student, no quizzes yet' },
  { key: 'omar', name: 'Omar Haddad', login: 'ohaddad', email: 'haddado4@students.rowan.edu', note: 'Student with past quizzes' },
  { key: 'instructor', name: 'Course Instructor', login: 'instructor', email: 'instructor@gmail.com', note: 'Admin, allowed by GitHub login' },
  { key: 'outsider', name: 'Outside User', login: 'outsider', email: 'someone@gmail.com', note: 'Not a Rowan email: should be refused' }
];
const CLASSMATES = ['Ava Chen', 'Liam Patel', 'Sofia Martinez', 'Noah Kim', 'Mia Johnson', 'Ethan Brooks', 'Zara Ahmed', 'Lucas Rossi'];

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

async function takeQuiz(db, userId, skill, daysAgo) {
  const quiz = await rpc(db, userId, 'start_quiz');
  const { rows } = await db.query(`select i.position, array_position(i.option_order, q.answer) - 1 as correct
    from quiz.attempt_items i join quiz.questions q on q.id = i.question_id where i.attempt_id = $1`, [quiz.attempt_id]);
  const answers = {};
  for (const r of rows) {
    if (Math.random() < 0.04) continue;  // left blank
    answers[r.position] = Math.random() < skill ? r.correct : (r.correct + 1 + Math.floor(Math.random() * 3)) % 4;
  }
  await rpc(db, userId, 'submit_quiz', { p_attempt: quiz.attempt_id, p_answers: answers });
  const used = 9 + Math.floor(Math.random() * 20);
  await db.query(`update quiz.attempts set started_at = now() - make_interval(days => $2::int, mins => $3::int),
      deadline = now() - make_interval(days => $2::int, mins => $3::int) + interval '30 minutes',
      submitted_at = now() - make_interval(days => $2::int, mins => $3::int - $4::int) where id = $1`,
    [quiz.attempt_id, daysAgo, 60 * 10, used]);
}

async function seedDemo(db, users) {
  const omar = ACCOUNTS.find(a => a.key === 'omar');
  users.set('omar', await signUp(db, { email: omar.email, login: omar.login, name: omar.name }));
  for (const [i, skill] of [0.45, 0.55, 0.62, 0.7, 0.74].entries()) await takeQuiz(db, users.get('omar'), skill, 20 - i * 4);
  for (const [n, name] of CLASSMATES.entries()) {
    const login = name.toLowerCase().replace(/\s+/g, '');
    const id = await signUp(db, { email: `${login}${n}@students.rowan.edu`, login, name });
    const base = 0.35 + Math.random() * 0.45, count = n % 4;
    for (let k = 0; k < count; k++) await takeQuiz(db, id, Math.min(0.95, base + k * 0.06), 18 - k * 5 - n % 3);
  }
}

export async function startDevServer({ port = 8787, demo = true } = {}) {
  const db = await createLocalDb({ admins: ['instructor'] });
  const users = new Map(), codes = new Map();
  if (demo) await seedDemo(db, users);

  const session = key => {
    const a = ACCOUNTS.find(x => x.key === key), id = users.get(key);
    const exp = Math.floor(Date.now() / 1000) + 86400;
    const user = { id, aud: 'authenticated', role: 'authenticated', email: a.email,
      app_metadata: { provider: 'github', providers: ['github'] },
      user_metadata: { user_name: a.login, full_name: a.name }, created_at: new Date().toISOString() };
    return { access_token: `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: id, email: a.email, role: 'authenticated', aud: 'authenticated', exp })}.dev`,
      token_type: 'bearer', expires_in: 86400, expires_at: exp, refresh_token: `dev-${key}`, user };
  };
  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' && body !== undefined ? JSON.stringify(body) : body);
  };
  const readBody = req => new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
  const userFromAuth = req => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub || null; } catch { return null; }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/rest/v1/rpc/') && req.method === 'POST') {
        const fn = url.pathname.split('/').pop();
        const args = await readBody(req);
        try {
          return send(res, 200, await rpc(db, userFromAuth(req), fn, args));
        } catch (err) {
          return send(res, 400, { code: 'P0001', message: err.message, details: null, hint: null });
        }
      }
      if (url.pathname === '/auth/v1/authorize') {
        const redirect = url.searchParams.get('redirect_to') || '/';
        return send(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
          <title>Demo sign-in</title><style>body{font:16px system-ui;max-width:520px;margin:8vh auto;padding:0 16px}
          a{display:block;padding:14px 16px;border:1px solid #c3c2b7;border-radius:10px;margin:10px 0;color:inherit;text-decoration:none}
          a:hover{border-color:#256abf}small{display:block;color:#52514e}</style>
          <h1>Local demo sign-in</h1><p>Stands in for GitHub on the local preview. Pick an account:</p>
          ${ACCOUNTS.map(a => `<a href="/__dev/callback?as=${a.key}&redirect_to=${encodeURIComponent(redirect)}" data-account="${a.key}">
            <strong>${a.name}</strong> (${a.email})<small>${a.note}</small></a>`).join('')}`, 'text/html');
      }
      if (url.pathname === '/__dev/callback') {
        const key = url.searchParams.get('as');
        const account = ACCOUNTS.find(a => a.key === key);
        const back = new URL(url.searchParams.get('redirect_to') || '/', `http://${req.headers.host}`);
        if (!account) return send(res, 400, { message: 'unknown account' });
        if (!users.has(key)) {
          try {
            users.set(key, await signUp(db, { email: account.email, login: account.login, name: account.name }));
          } catch (err) {
            back.searchParams.set('error', 'server_error');
            back.searchParams.set('error_code', 'unexpected_failure');
            back.searchParams.set('error_description', 'Database error saving new user');
            res.writeHead(302, { Location: back.toString() });
            return res.end();
          }
        }
        const code = randomUUID();
        codes.set(code, key);
        back.searchParams.set('code', code);
        res.writeHead(302, { Location: back.toString() });
        return res.end();
      }
      if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
        const body = await readBody(req);
        const key = url.searchParams.get('grant_type') === 'pkce' ? codes.get(body.auth_code)
          : String(body.refresh_token || '').replace(/^dev-/, '');
        codes.delete(body.auth_code);
        if (!key || !users.has(key)) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid code' });
        return send(res, 200, session(key));
      }
      if (url.pathname === '/auth/v1/user') {
        const id = userFromAuth(req);
        const key = [...users].find(([, v]) => v === id)?.[0];
        return key ? send(res, 200, session(key).user) : send(res, 401, { message: 'not signed in' });
      }
      if (url.pathname === '/auth/v1/logout') return send(res, 204, '');
      if (url.pathname === '/config.js') {
        return send(res, 200, `window.QUIZ_CONFIG = ${JSON.stringify({ supabaseUrl: `http://${req.headers.host}`,
          supabaseKey: 'local-dev-key', courseCode: 'CS01104',
          courseName: 'Introduction to Programming / Problem Solving: MATLAB/CAD', term: 'Local preview' })};`, 'text/javascript');
      }
      const path = { '/': 'index.html', '/favicon.ico': 'icon.svg' }[url.pathname] || decodeURIComponent(url.pathname);
      const file = normalize(join(SITE, path));
      if (!file.startsWith(SITE + sep)) return send(res, 403, { message: 'forbidden' });
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') return send(res, 404, 'Not found', 'text/plain');
      console.error(err);
      send(res, 500, { message: err.message });
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, db, url: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(r)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8787;
  const { url } = await startDevServer({ port });
  console.log(`Local preview running at ${url}  (Ctrl+C to stop)`);
  console.log('Sign in with any demo account; "Course Instructor" opens the admin pages.');
}
