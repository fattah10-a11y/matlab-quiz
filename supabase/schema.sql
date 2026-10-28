-- MATLAB course quiz: tables, sign-up rules and quiz functions for Supabase.
-- Paste into the Supabase SQL editor and run. Safe to re-run: tables are kept,
-- functions and triggers are replaced.
--
-- Security model
--   * All data lives in the "quiz" schema, which the Supabase API does not expose.
--   * The browser can only call the public.* functions below (signed-in users only).
--   * Correct answers never leave the database until an attempt is finished.
--   * Sign-up is limited to GitHub accounts whose email is on an allowed domain
--     (rowan.edu and its subdomains), plus GitHub logins listed in quiz.admin_logins.

create schema if not exists quiz;
revoke all on schema quiz from public;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists quiz.allowed_domains (
  domain text primary key check (domain = lower(domain))
);
insert into quiz.allowed_domains (domain) values ('rowan.edu') on conflict do nothing;

create table if not exists quiz.admin_logins (
  github_login text primary key check (github_login = lower(github_login))
);

create table if not exists quiz.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  github_login text,
  full_name text,
  avatar_url text,
  role text not null default 'student' check (role in ('student', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists quiz.topics (
  id text primary key,
  title text not null,
  week text not null,
  sort_order int not null,
  per_quiz int not null default 2 check (per_quiz between 0 and 10)
);

create table if not exists quiz.questions (
  id text primary key,
  topic_id text not null references quiz.topics (id),
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  prompt text not null,
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) = 4),
  answer int not null check (answer between 0 and 3),
  source text,
  active boolean not null default true
);

create table if not exists quiz.settings (
  id boolean primary key default true check (id),
  duration_minutes int not null default 30 check (duration_minutes between 5 and 180),
  grace_seconds int not null default 30 check (grace_seconds between 0 and 300)
);
insert into quiz.settings default values on conflict do nothing;

create table if not exists quiz.attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references quiz.profiles (id) on delete cascade,
  started_at timestamptz not null default now(),
  deadline timestamptz not null,
  submitted_at timestamptz,
  status text not null default 'in_progress' check (status in ('in_progress', 'submitted', 'expired')),
  score int,
  total int not null default 0
);
create unique index if not exists attempts_one_open on quiz.attempts (user_id) where status = 'in_progress';
create index if not exists attempts_by_user on quiz.attempts (user_id, started_at desc);

create table if not exists quiz.attempt_items (
  attempt_id uuid not null references quiz.attempts (id) on delete cascade,
  position int not null,
  question_id text not null references quiz.questions (id),
  option_order int[] not null,  -- option_order[displayed + 1] = original option index
  chosen int,                   -- original option index, null when unanswered
  is_correct boolean,
  primary key (attempt_id, position)
);
create index if not exists attempt_items_by_question on quiz.attempt_items (question_id);

alter table quiz.allowed_domains enable row level security;
alter table quiz.admin_logins enable row level security;
alter table quiz.profiles enable row level security;
alter table quiz.topics enable row level security;
alter table quiz.questions enable row level security;
alter table quiz.settings enable row level security;
alter table quiz.attempts enable row level security;
alter table quiz.attempt_items enable row level security;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable from the browser)
-- ---------------------------------------------------------------------------

create or replace function quiz.email_domain_allowed(p_email text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from quiz.allowed_domains d
    where split_part(lower(coalesce(p_email, '')), '@', 2) = d.domain
       or split_part(lower(coalesce(p_email, '')), '@', 2) like '%.' || d.domain)
$$;

-- Admin status comes from the GitHub identity, which users cannot edit
-- (unlike user_metadata).
create or replace function quiz.is_admin(p_uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.identities i
    join quiz.admin_logins a on a.github_login = lower(i.identity_data ->> 'user_name')
    where i.user_id = p_uid and i.provider = 'github')
$$;

create or replace function quiz.current_user_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN';
  end if;
  if not exists (select 1 from quiz.profiles where id = v_uid) then
    raise exception 'NOT_ENROLLED';
  end if;
  return v_uid;
end $$;

create or replace function quiz.require_admin() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := quiz.current_user_id();
begin
  if not quiz.is_admin(v_uid) then
    raise exception 'ADMIN_ONLY';
  end if;
  return v_uid;
end $$;

create or replace function quiz.shuffled_order(p_n int) returns int[]
language sql volatile set search_path = '' as $$
  select array_agg(i order by random()) from generate_series(0, p_n - 1) as i
$$;

-- Grades an open attempt from its saved answers and closes it.
create or replace function quiz.finalize(p_attempt uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update quiz.attempt_items i
     set is_correct = (i.chosen is not null and i.chosen = q.answer)
    from quiz.questions q
   where q.id = i.question_id and i.attempt_id = p_attempt;

  update quiz.attempts a
     set status = p_status,
         submitted_at = case when p_status = 'expired' then a.deadline else now() end,
         score = (select count(*) from quiz.attempt_items i where i.attempt_id = p_attempt and i.is_correct)
   where a.id = p_attempt and a.status = 'in_progress';
end $$;

create or replace function quiz.finalize_expired(p_uid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_attempt uuid;
begin
  for v_attempt in
    select a.id from quiz.attempts a, quiz.settings s
    where a.status = 'in_progress' and (p_uid is null or a.user_id = p_uid)
      and now() > a.deadline + make_interval(secs => s.grace_seconds)
  loop
    perform quiz.finalize(v_attempt, 'expired');
  end loop;
end $$;

create or replace function quiz.quiz_payload(p_attempt uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'attempt_id', a.id,
    'started_at', a.started_at,
    'deadline', a.deadline,
    'server_now', now(),
    'total', a.total,
    'questions', (
      select jsonb_agg(jsonb_build_object(
        'position', i.position,
        'topic', t.title,
        'prompt', q.prompt,
        'options', (select jsonb_agg(q.options -> o.idx -> 'text' order by o.ord)
                      from unnest(i.option_order) with ordinality as o (idx, ord)),
        'choice', (select o.ord - 1 from unnest(i.option_order) with ordinality as o (idx, ord)
                    where o.idx = i.chosen)
      ) order by i.position)
      from quiz.attempt_items i
      join quiz.questions q on q.id = i.question_id
      join quiz.topics t on t.id = q.topic_id
      where i.attempt_id = a.id))
  from quiz.attempts a
  where a.id = p_attempt
$$;

create or replace function quiz.review_payload(p_attempt uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'attempt_id', a.id,
    'status', a.status,
    'started_at', a.started_at,
    'submitted_at', a.submitted_at,
    'seconds_used', extract(epoch from (least(a.submitted_at, a.deadline) - a.started_at))::int,
    'score', a.score,
    'total', a.total,
    'student', (select jsonb_build_object('id', p.id, 'full_name', p.full_name, 'github_login', p.github_login, 'email', p.email)
                  from quiz.profiles p where p.id = a.user_id),
    'items', (
      select jsonb_agg(jsonb_build_object(
        'position', i.position,
        'topic', t.title,
        'topic_order', t.sort_order,
        'difficulty', q.difficulty,
        'prompt', q.prompt,
        'source', q.source,
        'options', (select jsonb_agg(q.options -> o.idx order by o.ord)
                      from unnest(i.option_order) with ordinality as o (idx, ord)),
        'correct', (select o.ord - 1 from unnest(i.option_order) with ordinality as o (idx, ord)
                     where o.idx = q.answer),
        'choice', (select o.ord - 1 from unnest(i.option_order) with ordinality as o (idx, ord)
                    where o.idx = i.chosen),
        'is_correct', coalesce(i.is_correct, false)
      ) order by i.position)
      from quiz.attempt_items i
      join quiz.questions q on q.id = i.question_id
      join quiz.topics t on t.id = q.topic_id
      where i.attempt_id = a.id))
  from quiz.attempts a
  where a.id = p_attempt
$$;

create or replace function quiz.settings_payload() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'duration_minutes', s.duration_minutes,
    'question_count', (select coalesce(sum(least(t.per_quiz, (select count(*) from quiz.questions q
                                                              where q.topic_id = t.id and q.active))), 0)
                         from quiz.topics t),
    'topics', (select jsonb_agg(jsonb_build_object(
                 'id', t.id, 'title', t.title, 'week', t.week, 'per_quiz', t.per_quiz,
                 'available', (select count(*) from quiz.questions q where q.topic_id = t.id and q.active))
               order by t.sort_order) from quiz.topics t))
  from quiz.settings s
$$;

-- Everything the progress page shows for one user.
create or replace function quiz.dashboard(p_uid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'profile', (select jsonb_build_object('id', p.id, 'full_name', p.full_name, 'github_login', p.github_login,
                                          'email', p.email, 'avatar_url', p.avatar_url, 'role', p.role,
                                          'created_at', p.created_at)
                  from quiz.profiles p where p.id = p_uid),
    'settings', quiz.settings_payload(),
    'active', (select jsonb_build_object('attempt_id', a.id, 'deadline', a.deadline, 'server_now', now())
                 from quiz.attempts a where a.user_id = p_uid and a.status = 'in_progress'),
    'attempts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'started_at', a.started_at, 'submitted_at', a.submitted_at, 'status', a.status,
               'score', a.score, 'total', a.total,
               'seconds_used', extract(epoch from (least(a.submitted_at, a.deadline) - a.started_at))::int)
             order by a.started_at)
      from quiz.attempts a where a.user_id = p_uid and a.status <> 'in_progress'), '[]'::jsonb),
    'topics', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'week', t.week,
                                          'answered', coalesce(s.answered, 0), 'correct', coalesce(s.correct, 0))
             order by t.sort_order)
      from quiz.topics t
      left join (
        select q.topic_id, count(*) as answered, count(*) filter (where i.is_correct) as correct
        from quiz.attempt_items i
        join quiz.attempts a on a.id = i.attempt_id
        join quiz.questions q on q.id = i.question_id
        where a.user_id = p_uid and a.status <> 'in_progress'
        group by q.topic_id) s on s.topic_id = t.id), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------------------
-- Sign-up gate and profile creation (triggers on auth.users)
-- ---------------------------------------------------------------------------

create or replace function quiz.check_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if quiz.email_domain_allowed(new.email) then
    return new;
  end if;
  if coalesce(new.raw_app_meta_data ->> 'provider', '') = 'github' and exists (
       select 1 from quiz.admin_logins a
       where a.github_login = lower(coalesce(new.raw_user_meta_data ->> 'user_name', ''))) then
    return new;
  end if;
  raise exception 'ROWAN_EMAIL_REQUIRED: % is not an allowed email domain', coalesce(new.email, 'no email');
end $$;

create or replace function quiz.create_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into quiz.profiles (id, email, github_login, full_name, avatar_url)
  values (new.id, coalesce(new.email, ''),
          new.raw_user_meta_data ->> 'user_name',
          coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
          new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists quiz_check_new_user on auth.users;
create trigger quiz_check_new_user before insert on auth.users
  for each row execute function quiz.check_new_user();

drop trigger if exists quiz_create_profile on auth.users;
create trigger quiz_create_profile after insert on auth.users
  for each row execute function quiz.create_profile();

-- ---------------------------------------------------------------------------
-- Functions the web app calls (supabase.rpc)
-- ---------------------------------------------------------------------------

create or replace function public.whoami() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_admin boolean;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN';
  end if;
  v_admin := quiz.is_admin(v_uid);
  if not exists (select 1 from quiz.profiles where id = v_uid) then
    -- Account created before this schema was installed: apply the same rules now.
    if not (v_admin or quiz.email_domain_allowed((select email from auth.users where id = v_uid))) then
      raise exception 'NOT_ENROLLED';
    end if;
    insert into quiz.profiles (id, email) select id, coalesce(email, '') from auth.users where id = v_uid;
  end if;
  update quiz.profiles p
     set role = case when v_admin then 'admin' else 'student' end,
         email = coalesce(u.email, p.email),
         github_login = coalesce(i.identity_data ->> 'user_name', p.github_login),
         full_name = coalesce(i.identity_data ->> 'full_name', i.identity_data ->> 'name', p.full_name),
         avatar_url = coalesce(i.identity_data ->> 'avatar_url', p.avatar_url)
    from auth.users u
    left join auth.identities i on i.user_id = u.id and i.provider = 'github'
   where p.id = v_uid and u.id = v_uid;
  return (select jsonb_build_object('id', p.id, 'email', p.email, 'github_login', p.github_login,
                                    'full_name', p.full_name, 'avatar_url', p.avatar_url, 'role', p.role)
            from quiz.profiles p where p.id = v_uid);
end $$;

create or replace function public.my_dashboard() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := quiz.current_user_id();
begin
  perform quiz.finalize_expired(v_uid);
  return quiz.dashboard(v_uid);
end $$;

-- Resumes the open attempt, or builds a new quiz: per_quiz questions from every
-- topic, least-seen questions first, in random order with shuffled options.
create or replace function public.start_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := quiz.current_user_id();
  v_attempt uuid;
  v_total int;
begin
  perform quiz.finalize_expired(v_uid);
  select id into v_attempt from quiz.attempts where user_id = v_uid and status = 'in_progress';
  if v_attempt is null then
    begin
      insert into quiz.attempts (user_id, deadline)
      select v_uid, now() + make_interval(mins => s.duration_minutes) from quiz.settings s
      returning id into v_attempt;
    exception when unique_violation then
      select id into v_attempt from quiz.attempts where user_id = v_uid and status = 'in_progress';
      return quiz.quiz_payload(v_attempt);
    end;

    insert into quiz.attempt_items (attempt_id, position, question_id, option_order)
    select v_attempt, row_number() over (order by random()), r.id, quiz.shuffled_order(4)
    from (
      select q.id, t.per_quiz,
             row_number() over (partition by q.topic_id order by coalesce(seen.n, 0), random()) as rn
      from quiz.questions q
      join quiz.topics t on t.id = q.topic_id
      left join (
        select i.question_id, count(*) as n
        from quiz.attempt_items i join quiz.attempts a on a.id = i.attempt_id
        where a.user_id = v_uid
        group by i.question_id) seen on seen.question_id = q.id
      where q.active and t.per_quiz > 0) r
    where r.rn <= r.per_quiz;

    get diagnostics v_total = row_count;
    if v_total = 0 then
      raise exception 'NO_QUESTIONS';
    end if;
    update quiz.attempts set total = v_total where id = v_attempt;
  end if;
  return quiz.quiz_payload(v_attempt);
end $$;

-- p_choice is the displayed option index (0-3), or null to clear the answer.
create or replace function public.save_answer(p_attempt uuid, p_position int, p_choice int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := quiz.current_user_id();
  v_open boolean;
begin
  select a.status = 'in_progress' and now() <= a.deadline + make_interval(secs => s.grace_seconds)
    into v_open
    from quiz.attempts a, quiz.settings s
   where a.id = p_attempt and a.user_id = v_uid;
  if v_open is null then
    raise exception 'ATTEMPT_NOT_FOUND';
  end if;
  if not v_open then
    perform quiz.finalize_expired(v_uid);
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if p_choice is not null and (p_choice < 0 or p_choice > 3) then
    raise exception 'BAD_CHOICE';
  end if;
  update quiz.attempt_items
     set chosen = case when p_choice is null then null else option_order[p_choice + 1] end
   where attempt_id = p_attempt and position = p_position;
  if not found then
    raise exception 'BAD_POSITION';
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- p_answers is an optional final copy of the answers, {"<position>": choice},
-- applied only while time remains. Late submissions are graded on saved answers.
create or replace function public.submit_quiz(p_attempt uuid, p_answers jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := quiz.current_user_id();
  v_status text;
  v_open boolean;
begin
  select a.status, now() <= a.deadline + make_interval(secs => s.grace_seconds)
    into v_status, v_open
    from quiz.attempts a, quiz.settings s
   where a.id = p_attempt and a.user_id = v_uid
     for update of a;
  if v_status is null then
    raise exception 'ATTEMPT_NOT_FOUND';
  end if;
  if v_status = 'in_progress' then
    if v_open and p_answers is not null and jsonb_typeof(p_answers) = 'object' then
      update quiz.attempt_items i
         set chosen = case when e.value = 'null'::jsonb then null
                           else i.option_order[(e.value #>> '{}')::int + 1] end
        from jsonb_each(p_answers) e
       where i.attempt_id = p_attempt
         and i.position = (e.key)::int
         and (e.value = 'null'::jsonb or (jsonb_typeof(e.value) = 'number' and (e.value #>> '{}')::int between 0 and 3));
    end if;
    perform quiz.finalize(p_attempt, case when v_open then 'submitted' else 'expired' end);
  end if;
  return quiz.review_payload(p_attempt);
end $$;

create or replace function public.get_review(p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := quiz.current_user_id();
  v_owner uuid;
begin
  select user_id into v_owner from quiz.attempts where id = p_attempt;
  if v_owner is null or (v_owner <> v_uid and not quiz.is_admin(v_uid)) then
    raise exception 'ATTEMPT_NOT_FOUND';
  end if;
  perform quiz.finalize_expired(v_owner);
  if (select status from quiz.attempts where id = p_attempt) = 'in_progress' then
    raise exception 'ATTEMPT_IN_PROGRESS';
  end if;
  return quiz.review_payload(p_attempt);
end $$;

-- ---------------------------------------------------------------------------
-- Admin functions
-- ---------------------------------------------------------------------------

create or replace function public.admin_overview() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform quiz.require_admin();
  perform quiz.finalize_expired(null);
  return jsonb_build_object(
    'settings', quiz.settings_payload(),
    'class', (
      select jsonb_build_object(
        'students', (select count(*) from quiz.profiles where role = 'student'),
        'active_students', count(distinct a.user_id),
        'attempts', count(*),
        'average_pct', round(avg(a.score * 100.0 / nullif(a.total, 0)), 1),
        'last_7_days', count(*) filter (where a.started_at > now() - interval '7 days'))
      from quiz.attempts a join quiz.profiles p on p.id = a.user_id
      where p.role = 'student' and a.status <> 'in_progress'),
    'students', coalesce((
      select jsonb_agg(x order by x ->> 'full_name' nulls last, x ->> 'email')
      from (
        select jsonb_build_object(
          'id', p.id, 'full_name', p.full_name, 'github_login', p.github_login, 'email', p.email,
          'joined', p.created_at,
          'attempts', count(a.id),
          'average_pct', round(avg(a.score * 100.0 / nullif(a.total, 0)), 1),
          'best_pct', round(max(a.score * 100.0 / nullif(a.total, 0)), 1),
          'last_pct', round((array_agg(a.score * 100.0 / nullif(a.total, 0) order by a.started_at desc))[1], 1),
          'last_at', max(a.started_at),
          'in_progress', exists (select 1 from quiz.attempts o where o.user_id = p.id and o.status = 'in_progress')) as x
        from quiz.profiles p
        left join quiz.attempts a on a.user_id = p.id and a.status <> 'in_progress'
        where p.role = 'student'
        group by p.id) s), '[]'::jsonb),
    'topics', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'week', t.week,
                                          'answered', coalesce(s.answered, 0), 'correct', coalesce(s.correct, 0))
             order by t.sort_order)
      from quiz.topics t
      left join (
        select q.topic_id, count(*) as answered, count(*) filter (where i.is_correct) as correct
        from quiz.attempt_items i
        join quiz.attempts a on a.id = i.attempt_id
        join quiz.profiles p on p.id = a.user_id
        join quiz.questions q on q.id = i.question_id
        where p.role = 'student' and a.status <> 'in_progress'
        group by q.topic_id) s on s.topic_id = t.id), '[]'::jsonb),
    'scores', coalesce((
      select jsonb_agg(round(a.score * 100.0 / nullif(a.total, 0), 1) order by a.started_at)
      from quiz.attempts a join quiz.profiles p on p.id = a.user_id
      where p.role = 'student' and a.status <> 'in_progress'), '[]'::jsonb));
end $$;

create or replace function public.admin_student(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform quiz.require_admin();
  if not exists (select 1 from quiz.profiles where id = p_user) then
    raise exception 'STUDENT_NOT_FOUND';
  end if;
  perform quiz.finalize_expired(p_user);
  return quiz.dashboard(p_user);
end $$;

create or replace function public.admin_question_stats() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform quiz.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', q.id, 'topic_id', q.topic_id, 'topic', t.title, 'difficulty', q.difficulty,
             'prompt', q.prompt, 'options', q.options, 'answer', q.answer, 'source', q.source, 'active', q.active,
             'served', coalesce(s.served, 0), 'answered', coalesce(s.answered, 0), 'correct', coalesce(s.correct, 0))
           order by t.sort_order, q.id)
    from quiz.questions q
    join quiz.topics t on t.id = q.topic_id
    left join (
      select i.question_id, count(*) as served, count(i.chosen) as answered,
             count(*) filter (where i.is_correct) as correct
      from quiz.attempt_items i
      join quiz.attempts a on a.id = i.attempt_id
      join quiz.profiles p on p.id = a.user_id
      where p.role = 'student' and a.status <> 'in_progress'
      group by i.question_id) s on s.question_id = q.id), '[]'::jsonb);
end $$;

-- p_per_topic: {"<topic id>": count}. Changes apply to quizzes started afterwards.
create or replace function public.admin_update_settings(p_duration_minutes int, p_per_topic jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform quiz.require_admin();
  if p_duration_minutes is not null then
    update quiz.settings set duration_minutes = p_duration_minutes;
  end if;
  if p_per_topic is not null then
    update quiz.topics t set per_quiz = (e.value #>> '{}')::int
      from jsonb_each(p_per_topic) e
     where t.id = e.key;
  end if;
  return quiz.settings_payload();
end $$;

create or replace function public.admin_set_question_active(p_question text, p_active boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform quiz.require_admin();
  update quiz.questions set active = p_active where id = p_question;
  if not found then
    raise exception 'QUESTION_NOT_FOUND';
  end if;
  return jsonb_build_object('id', p_question, 'active', p_active);
end $$;

-- ---------------------------------------------------------------------------
-- Permissions: signed-in users may call the public functions; nothing else.
-- ---------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.whoami()', 'public.my_dashboard()', 'public.start_quiz()',
    'public.save_answer(uuid, int, int)', 'public.submit_quiz(uuid, jsonb)', 'public.get_review(uuid)',
    'public.admin_overview()', 'public.admin_student(uuid)', 'public.admin_question_stats()',
    'public.admin_update_settings(int, jsonb)', 'public.admin_set_question_active(text, boolean)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

revoke all on all tables in schema quiz from public, anon, authenticated;
revoke all on all functions in schema quiz from public, anon, authenticated;
grant usage on schema quiz to supabase_auth_admin;
grant execute on function quiz.check_new_user(), quiz.create_profile() to supabase_auth_admin;
