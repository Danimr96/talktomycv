-- talktomycv — Postgres schema (Supabase)
-- Deny-all RLS: the service role (server-side) is the only path in.
-- Run this in the Supabase SQL editor to reproduce the backend.

-- ── tables ────────────────────────────────────────────────────────────────

create table if not exists public.recruiters (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  nombre      text not null,
  empresa     text not null,
  email       text not null,
  puesto      text not null,
  banda       text not null,
  modalidad   text not null,
  jd          text,
  consent     boolean not null default false,
  consent_at  timestamptz,
  ip_hash     text,           -- salted SHA-256 of the IP, for abuse control
  user_agent  text
);

create table if not exists public.sessions (
  id           uuid primary key default gen_random_uuid(),
  recruiter_id uuid not null references public.recruiters(id) on delete cascade,
  token        text unique not null,
  tokens_in    integer not null default 0,
  tokens_out   integer not null default 0,
  cost_eur     numeric not null default 0,
  msg_count    integer not null default 0,
  status       text not null default 'active',
  created_at   timestamptz not null default now(),
  last_at      timestamptz not null default now()
);

create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  role       text not null check (role in ('user','assistant')),
  content    text not null,
  tokens     integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.daily_spend (
  day      date primary key,
  cost_eur numeric not null default 0,
  sessions integer not null default 0
);

-- ── row-level security: enable, define NO policies → deny-all ──────────────
-- The service_role key bypasses RLS; nothing is reachable with the anon key.

alter table public.recruiters  enable row level security;
alter table public.sessions    enable row level security;
alter table public.messages    enable row level security;
alter table public.daily_spend enable row level security;

-- ── atomic daily-spend increment (kill-switch backing) ────────────────────
-- Absolute-value upserts race; this increments and returns the new total.

create or replace function public.increment_daily_spend(p_day date, p_cost numeric)
returns numeric language sql security definer set search_path = public as $$
  insert into public.daily_spend(day, cost_eur) values (p_day, p_cost)
  on conflict (day) do update set cost_eur = daily_spend.cost_eur + excluded.cost_eur
  returning cost_eur;
$$;
revoke all on function public.increment_daily_spend(date, numeric) from public, anon, authenticated;

-- ── retention: purge everything older than 12 months (GDPR) ───────────────

create or replace function public.purge_old_data()
returns void language sql security definer set search_path = public as $$
  delete from public.recruiters  where created_at < now() - interval '12 months';
  delete from public.sessions    where created_at < now() - interval '12 months';
  delete from public.messages    where created_at < now() - interval '12 months';
  delete from public.daily_spend where day < (now() - interval '12 months')::date;
$$;
revoke all on function public.purge_old_data() from public, anon, authenticated;

-- schedule the purge daily (requires the pg_cron extension):
-- create extension if not exists pg_cron;
-- select cron.schedule('purge-old-data', '30 3 * * *', $$select public.purge_old_data();$$);
