-- Material Didático FB - setup Supabase
-- Execute este arquivo no SQL Editor do projeto.

create table if not exists public.material_didatico_state (
  id text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.material_didatico_state enable row level security;

-- Em projetos novos, tabelas podem não ser expostas à Data API automaticamente.
grant usage on schema public to anon, authenticated;
grant select, insert, update on table public.material_didatico_state to anon, authenticated;

drop policy if exists "material_didatico_read" on public.material_didatico_state;
drop policy if exists "material_didatico_insert" on public.material_didatico_state;
drop policy if exists "material_didatico_update" on public.material_didatico_state;

create policy "material_didatico_read"
on public.material_didatico_state
for select
to anon, authenticated
using (id = 'main');

create policy "material_didatico_insert"
on public.material_didatico_state
for insert
to anon, authenticated
with check (id = 'main');

create policy "material_didatico_update"
on public.material_didatico_state
for update
to anon, authenticated
using (id = 'main')
with check (id = 'main');

-- Estado vazio de propósito:
-- o primeiro navegador que conectar envia o estado atual do painel.
insert into public.material_didatico_state (id, state)
values ('main', '{}'::jsonb)
on conflict (id) do nothing;

-- Habilita Postgres Changes para atualização em tempo real.
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
