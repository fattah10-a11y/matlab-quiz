// An in-memory Postgres (PGlite) loaded with the real schema and question bank,
// shared by the tests and the local dev server.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadBank, seedSql } from './bank.mjs';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function createLocalDb({ admins = [] } = {}) {
  const db = new PGlite();
  await db.exec(readFileSync(join(root, 'tools', 'auth_stub.sql'), 'utf8'));
  await db.exec(readFileSync(join(root, 'supabase', 'schema.sql'), 'utf8'));
  await db.exec(seedSql(loadBank(join(root, 'bank'))));
  for (const login of admins) {
    await db.query('insert into quiz.admin_logins values ($1)', [login.toLowerCase()]);
  }
  return db;
}

// Mimics a GitHub sign-up: inserts auth.users (firing the sign-up triggers) and
// the GitHub identity. Throws if the sign-up rules reject the account.
export async function signUp(db, { email, login, name = login, provider = 'github' }) {
  const meta = { user_name: login, full_name: name, avatar_url: null };
  const { rows } = await db.query(
    'insert into auth.users (email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3) returning id',
    [email, meta, { provider, providers: [provider] }]);
  const id = rows[0].id;
  if (provider === 'github') {
    await db.query('insert into auth.identities (user_id, provider, identity_data) values ($1, $2, $3)',
      [id, 'github', { ...meta, email }]);
  }
  return id;
}

// Calls a public.* function as the given user, the way Supabase's API does.
export async function rpc(db, userId, fn, args = {}) {
  if (!/^[a-z_]+$/.test(fn)) throw new Error(`bad function name ${fn}`);
  const names = Object.keys(args);
  if (!names.every(n => /^p_[a-z_]+$/.test(n))) throw new Error(`bad argument names for ${fn}`);
  const params = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
  const values = names.map(n => args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n]);
  return db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify(userId ? { sub: userId, role: 'authenticated' } : {})]);
    const { rows } = await tx.query(`select public.${fn}(${params}) as result`, values);
    return rows[0].result;
  });
}
