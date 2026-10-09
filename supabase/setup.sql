-- Material Didático FB - banco, identificação por PIN e auditoria
-- Rode este arquivo inteiro no SQL Editor do projeto Supabase.

-- Estado compartilhado do painel.
create table if not exists public.material_didatico_state (
  id text primary key,
  state jsonb not null default '{}'::jsonb,
  revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid null,
  updated_client_id text null
);

alter table public.material_didatico_state
  add column if not exists revision bigint not null default 0,
  add column if not exists updated_by uuid null,
  add column if not exists updated_client_id text null;

-- Identidades informais do app.
-- Usuário é independente da lista de designers.
create table if not exists public.material_didatico_users (
  id uuid primary key,
  display_name text not null,
  name_key text not null unique,
  pin_hash text not null,
  pin_salt text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz null
);

-- Sessões lembradas por dispositivo/navegador.
create table if not exists public.material_didatico_sessions (
  id uuid primary key,
  user_id uuid not null references public.material_didatico_users(id) on delete cascade,
  token_hash text not null unique,
  device_id text null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz null
);

-- Histórico propositalmente NÃO exposto ao frontend.
create table if not exists public.material_didatico_audit_log (
  id bigint generated always as identity primary key,
  user_id uuid null references public.material_didatico_users(id) on delete set null,
  user_name text not null,
  device_id text null,
  ip_observed text null,
  user_agent text null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists material_didatico_sessions_token_hash_idx
  on public.material_didatico_sessions(token_hash);

create index if not exists material_didatico_audit_created_at_idx
  on public.material_didatico_audit_log(created_at desc);

create index if not exists material_didatico_audit_user_idx
  on public.material_didatico_audit_log(user_id, created_at desc);

alter table public.material_didatico_state enable row level security;
alter table public.material_didatico_users enable row level security;
alter table public.material_didatico_sessions enable row level security;
alter table public.material_didatico_audit_log enable row level security;

-- O navegador só pode LER o estado para montar o painel e receber Realtime.
-- Toda escrita passa pela Edge Function, que valida a sessão/PIN e cria o log.
grant usage on schema public to anon, authenticated;
grant select on table public.material_didatico_state to anon, authenticated;

revoke insert, update, delete on table public.material_didatico_state from anon, authenticated;
revoke all on table public.material_didatico_users from anon, authenticated;
revoke all on table public.material_didatico_sessions from anon, authenticated;
revoke all on table public.material_didatico_audit_log from anon, authenticated;

drop policy if exists "material_didatico_read" on public.material_didatico_state;
drop policy if exists "material_didatico_insert" on public.material_didatico_state;
drop policy if exists "material_didatico_update" on public.material_didatico_state;

create policy "material_didatico_read"
on public.material_didatico_state
for select
to anon, authenticated
using (id = 'main');

insert into public.material_didatico_state (id, state, revision)
values ('main', '{}'::jsonb, 0)
on conflict (id) do nothing;

-- Realtime apenas no estado compartilhado.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'material_didatico_state'
  ) then
    alter publication supabase_realtime
      add table public.material_didatico_state;
  end if;
end
$$;
