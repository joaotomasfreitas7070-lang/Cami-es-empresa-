-- =====================================================================
--  Transportes Freitas — Notificações no telemóvel (Web Push)
--  1) Cole tudo no Supabase → SQL Editor → New query → Run (uma vez).
--  2) Crie a Edge Function "notificar" (ver README / instruções).
--  Não apaga dados.
-- =====================================================================

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- Telemóveis com as notificações ligadas (cada pessoa só vê/gere os seus)
create table if not exists public.push_subscricoes (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  empresa_id uuid references public.empresas (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  criado_em timestamptz not null default now()
);
alter table public.push_subscricoes enable row level security;
drop policy if exists "push: as minhas" on public.push_subscricoes;
create policy "push: as minhas" on public.push_subscricoes for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (empresa_id is null or public.e_membro(empresa_id)));

-- Chaves do serviço de notificações (criadas sozinhas pela Edge Function; ninguém as lê pelo site)
create table if not exists public.push_config (
  id int primary key default 1 check (id = 1),
  url text, publica text, privada text, segredo text
);
alter table public.push_config enable row level security;

-- Para não enviar o mesmo aviso duas vezes
create table if not exists public.push_enviados (chave text primary key, em timestamptz not null default now());
alter table public.push_enviados enable row level security;

-- O site só precisa da chave pública
create or replace function public.push_chave_publica() returns text
language sql stable security definer set search_path = public as $$
  select publica from push_config where id = 1;
$$;

-- Chama a Edge Function (nunca impede a gravação de um registo)
create or replace function public.push_disparar(corpo jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare c record;
begin
  select url, segredo into c from push_config where id = 1;
  if c.url is null or c.segredo is null then return; end if;
  perform net.http_post(
    url := c.url,
    body := corpo,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-segredo', c.segredo)
  );
exception when others then
  raise warning 'notificação não enviada: %', sqlerrm;
end;
$$;
revoke execute on function public.push_disparar(jsonb) from public, anon, authenticated;

-- Avisar quando há pedidos de férias, problemas, recibos fechados e turnos novos
create or replace function public.registos_notificar() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tipo in ('ferias', 'ocorrencias', 'processamentos', 'escalas') and not new.apagado then
    perform push_disparar(jsonb_build_object(
      'evento', 'registo', 'empresa_id', new.empresa_id, 'id', new.id, 'tipo', new.tipo, 'op', tg_op,
      'antes', case when tg_op = 'UPDATE' then old.dados ->> 'estado' end));
  end if;
  return null;
end;
$$;
drop trigger if exists registos_notificar on public.registos;
create trigger registos_notificar after insert or update on public.registos
  for each row execute function public.registos_notificar();

-- Resumo diário às 07:30 (hora de Portugal no inverno; 08:30 no verão)
select cron.schedule('freitas-avisos-diarios', '30 7 * * *', $$ select public.push_disparar('{"evento":"diario"}'::jsonb) $$);
