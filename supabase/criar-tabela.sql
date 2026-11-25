-- Cole isto no Supabase → SQL Editor → New query → Run.
create table if not exists public.frota_dados (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  dados jsonb not null,
  atualizado timestamptz not null default now()
);

alter table public.frota_dados enable row level security;

create policy "ver os meus dados" on public.frota_dados
  for select using ((select auth.uid()) = user_id);
create policy "criar os meus dados" on public.frota_dados
  for insert with check ((select auth.uid()) = user_id);
create policy "alterar os meus dados" on public.frota_dados
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
