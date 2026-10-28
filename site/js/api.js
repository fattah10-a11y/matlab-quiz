// Talks to Supabase: GitHub sign-in and the quiz functions in supabase/schema.sql.
const config = window.QUIZ_CONFIG || {};

export const configured = Boolean(config.supabaseUrl && config.supabaseKey
  && !config.supabaseUrl.includes('YOUR-PROJECT') && !config.supabaseKey.startsWith('YOUR-'));

// A rejected sign-up comes back as ?error=...&error_description=... (or in the
// hash). Read it before the Supabase client does, then tidy the address bar.
export const signInError = (() => {
  const url = new URL(location.href);
  const hash = new URLSearchParams(url.hash.startsWith('#') && url.hash.includes('=') ? url.hash.slice(1) : '');
  const get = key => url.searchParams.get(key) || hash.get(key);
  if (!get('error') && !get('error_description')) return null;
  const description = get('error_description') || get('error') || 'Sign-in failed.';
  for (const key of ['error', 'error_code', 'error_description', 'sb_flow_id', 'code']) url.searchParams.delete(key);
  history.replaceState(history.state, '', url.pathname + url.search);
  return description;
})();

const client = configured ? window.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { flowType: 'pkce', storageKey: 'mq-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
}) : null;

export async function getSession() {
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session;
}

export function onSignedOut(callback) {
  client?.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') callback(); });
}

export async function signIn() {
  const { error } = await client.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: location.origin + location.pathname, scopes: 'read:user user:email' }
  });
  if (error) throw error;
}

export async function signOut() {
  await client.auth.signOut();
}

const MESSAGES = {
  NOT_SIGNED_IN: 'Your session has ended. Please sign in again.',
  NOT_ENROLLED: 'This account is not allowed to use the quiz. Sign in with a GitHub account whose primary email is a Rowan address.',
  ADMIN_ONLY: 'Only the instructor can open this page.',
  ATTEMPT_NOT_FOUND: 'That quiz attempt was not found.',
  ATTEMPT_IN_PROGRESS: 'That quiz is still in progress.',
  NO_QUESTIONS: 'No questions are available right now. Please tell your instructor.',
  STUDENT_NOT_FOUND: 'That student was not found.'
};

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function call(fn, args = {}) {
  if (!client) throw new ApiError('NOT_CONFIGURED', 'The quiz is not connected to its database yet.');
  const { data, error } = await client.rpc(fn, args);
  if (!error) return data;
  const code = Object.keys(MESSAGES).find(key => error.message?.includes(key));
  if (code) throw new ApiError(code, MESSAGES[code]);
  const offline = !navigator.onLine || /fetch|network/i.test(error.message || '');
  throw new ApiError(offline ? 'OFFLINE' : 'ERROR',
    offline ? 'You appear to be offline. Check your connection and try again.' : `Something went wrong: ${error.message}`);
}

export const api = {
  whoami: () => call('whoami'),
  dashboard: () => call('my_dashboard'),
  startQuiz: () => call('start_quiz'),
  saveAnswer: (attempt, position, choice) => call('save_answer', { p_attempt: attempt, p_position: position, p_choice: choice }),
  submitQuiz: (attempt, answers) => call('submit_quiz', { p_attempt: attempt, p_answers: answers }),
  review: attempt => call('get_review', { p_attempt: attempt }),
  adminOverview: () => call('admin_overview'),
  adminStudent: user => call('admin_student', { p_user: user }),
  adminQuestions: () => call('admin_question_stats'),
  adminUpdateSettings: (minutes, perTopic) => call('admin_update_settings', { p_duration_minutes: minutes, p_per_topic: perTopic }),
  adminSetQuestionActive: (id, active) => call('admin_set_question_active', { p_question: id, p_active: active })
};
