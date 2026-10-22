-- School Result Portal - Independent Schema
-- Independent schema for the new Supabase project.
-- Run this once in your new Supabase project's SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.app_config (
  id integer primary key default 1 check (id = 1),
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.academic_context (
  id integer primary key default 1 check (id = 1),
  class_key text,
  academic_session text not null default '2026/2027',
  term text not null default '1st Term',
  term_status text not null default 'open' check (term_status in ('open', 'closed')),
  updated_at timestamptz not null default now()
);

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  class_key text not null,
  academic_session text not null default '2026/2027',
  name text not null,
  gender text not null,
  admno text,
  house text,
  age text,
  photo text,
  archived boolean not null default false,
  archived_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.scores (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  class_key text not null,
  subject_index integer not null,
  term text not null,
  academic_session text not null,
  ca1 numeric,
  ca2 numeric,
  ca3 numeric,
  exam numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, subject_index, term, academic_session)
);

create table if not exists public.traits (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  class_key text not null,
  trait_type text not null,
  trait_name text not null,
  rating numeric,
  term text not null,
  academic_session text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, trait_type, trait_name, term, academic_session)
);

create table if not exists public.fees (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  class_key text not null,
  term text not null,
  academic_session text not null,
  total numeric not null default 0,
  paid numeric not null default 0,
  debt numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, term, academic_session)
);

create table if not exists public.remarks (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  class_key text not null,
  term text not null,
  academic_session text not null,
  academic text,
  form_master text,
  principal text,
  days_opened integer,
  days_present integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, term, academic_session)
);

create table if not exists public.published_subjects (
  id uuid primary key default gen_random_uuid(),
  class_key text not null,
  subject_index integer not null,
  term text not null,
  academic_session text not null,
  published boolean not null default true,
  created_at timestamptz not null default now(),
  unique (class_key, subject_index, term, academic_session)
);

create table if not exists public.staff_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text not null default 'School Staff',
  role text not null default 'staff' check (role in ('staff', 'admin', 'developer')),
  suspended boolean not null default false,
  is_developer boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_access_config (
  id integer primary key default 1 check (id = 1),
  invite_enabled boolean not null default true,
  invite_code_hash text not null,
  invite_hint text not null default 'AMB••••••',
  updated_at timestamptz not null default now()
);

create index if not exists students_class_idx on public.students(class_key, academic_session, archived);
create index if not exists scores_class_term_idx on public.scores(class_key, academic_session, term);
create index if not exists traits_student_term_idx on public.traits(student_id, academic_session, term);
create index if not exists fees_student_term_idx on public.fees(student_id, academic_session, term);
create index if not exists remarks_student_term_idx on public.remarks(student_id, academic_session, term);

alter table public.app_config enable row level security;
alter table public.academic_context enable row level security;
alter table public.students enable row level security;
alter table public.scores enable row level security;
alter table public.traits enable row level security;
alter table public.fees enable row level security;
alter table public.remarks enable row level security;
alter table public.published_subjects enable row level security;
alter table public.staff_profiles enable row level security;
alter table public.portal_access_config enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['app_config','academic_context','students','scores','traits','fees','remarks','published_subjects'] loop
    execute format('drop policy if exists "School staff authenticated access" on public.%I', table_name);
    execute format('create policy "School staff authenticated access" on public.%I for all to authenticated using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null)', table_name);
  end loop;
end $$;

-- Management authorization stays in a non-exposed schema and is used by RLS.
create schema if not exists private;
create or replace function private.is_management()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.staff_profiles
    where id = (select auth.uid())
      and role in ('admin', 'developer')
      and suspended = false
  );
$$;
revoke all on function private.is_management() from public;
grant execute on function private.is_management() to authenticated;

drop policy if exists "School staff authenticated access" on public.staff_profiles;
create policy "Staff can read own profile" on public.staff_profiles
  for select to authenticated using (id = (select auth.uid()) or (select private.is_management()));
create policy "Management can update staff profiles" on public.staff_profiles
  for update to authenticated using ((select private.is_management())) with check ((select private.is_management()));
create policy "Management can delete staff profiles" on public.staff_profiles
  for delete to authenticated using ((select private.is_management()));
create policy "Authenticated users can create own profile" on public.staff_profiles
  for insert to authenticated
  with check (
    id = (select auth.uid())
    and role = 'staff'
    and is_developer = false
  );

drop policy if exists "School staff authenticated access" on public.portal_access_config;
create policy "Anyone can check invite configuration" on public.portal_access_config
  for select to anon, authenticated using (true);
create policy "Management can insert invite configuration" on public.portal_access_config
  for insert to authenticated with check ((select private.is_management()));
create policy "Management can update invite configuration" on public.portal_access_config
  for update to authenticated using ((select private.is_management())) with check ((select private.is_management()));

drop policy if exists "School staff authenticated access" on public.app_config;
drop policy if exists "School staff authenticated access" on public.academic_context;
create policy "Signed-in users can read app config" on public.app_config
  for select to authenticated using (true);
create policy "Management can write app config" on public.app_config
  for insert to authenticated with check ((select private.is_management()));
create policy "Management can update app config" on public.app_config
  for update to authenticated using ((select private.is_management())) with check ((select private.is_management()));
create policy "Signed-in users can read academic context" on public.academic_context
  for select to authenticated using (true);
create policy "Management can write academic context" on public.academic_context
  for insert to authenticated with check ((select private.is_management()));
create policy "Management can update academic context" on public.academic_context
  for update to authenticated using ((select private.is_management())) with check ((select private.is_management()));

grant select on public.portal_access_config to anon;
grant select, insert, update, delete on public.staff_profiles to authenticated;
grant select on public.staff_profiles to authenticated;

-- Result records are readable by signed-in staff. Teachers can save the
-- classroom records they work on; management-only writes remain enforced for
-- configuration, fees, and the official academic context.
do $$
declare table_name text;
begin
  foreach table_name in array array['students','scores','traits','remarks'] loop
    execute format('drop policy if exists "School staff authenticated access" on public.%I', table_name);
    execute format('drop policy if exists "Management can insert results" on public.%I', table_name);
    execute format('drop policy if exists "Management can update results" on public.%I', table_name);
    execute format('drop policy if exists "Management can delete results" on public.%I', table_name);
    execute format('create policy "Signed-in staff can read results" on public.%I for select to authenticated using (true)', table_name);
    execute format('create policy "Signed-in staff can insert results" on public.%I for insert to authenticated with check ((select auth.uid()) is not null)', table_name);
    execute format('create policy "Signed-in staff can update results" on public.%I for update to authenticated using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null)', table_name);
    execute format('create policy "Management can delete results" on public.%I for delete to authenticated using ((select private.is_management()))', table_name);
  end loop;
end $$;

-- Published subjects are classroom workflow records: staff can publish or
-- unpublish them, while only management can change settings and context.
drop policy if exists "School staff authenticated access" on public.published_subjects;
drop policy if exists "Management can insert results" on public.published_subjects;
drop policy if exists "Management can update results" on public.published_subjects;
drop policy if exists "Management can delete results" on public.published_subjects;
create policy "Signed-in staff can read published results" on public.published_subjects
  for select to authenticated using (true);
create policy "Signed-in staff can publish results" on public.published_subjects
  for insert to authenticated with check ((select auth.uid()) is not null);
create policy "Signed-in staff can update published results" on public.published_subjects
  for update to authenticated using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);
create policy "Signed-in staff can unpublish results" on public.published_subjects
  for delete to authenticated using ((select auth.uid()) is not null);

-- Fees remain a management-controlled schedule and should not be editable by
-- ordinary staff accounts.
drop policy if exists "School staff authenticated access" on public.fees;
drop policy if exists "Management can insert results" on public.fees;
drop policy if exists "Management can update results" on public.fees;
drop policy if exists "Management can delete results" on public.fees;
create policy "Signed-in staff can read fees" on public.fees
  for select to authenticated using (true);
create policy "Management can insert fees" on public.fees
  for insert to authenticated with check ((select private.is_management()));
create policy "Management can update fees" on public.fees
  for update to authenticated using ((select private.is_management())) with check ((select private.is_management()));
create policy "Management can delete fees" on public.fees
  for delete to authenticated using ((select private.is_management()));

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;

insert into public.app_config (id, config) values (1, jsonb_build_object(
  'school', jsonb_build_object(
    'name', '',
    'addr', '',
    'phone', '',
    'email', '',
    'motto', ''
  ),
  'session', '2026/2027',
  'term', '1st Term'
)) on conflict (id) do nothing;

insert into public.academic_context (id, academic_session, term, term_status)
values (1, '2026/2027', '1st Term', 'open')
on conflict (id) do nothing;

insert into public.portal_access_config (id, invite_enabled, invite_code_hash, invite_hint)
values (1, true, encode(digest('PORTAL2026', 'sha256'), 'hex'), 'POR••••••')
on conflict (id) do nothing;
