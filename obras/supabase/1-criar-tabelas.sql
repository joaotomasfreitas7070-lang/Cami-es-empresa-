-- =====================================================================
--  Casas das Obras — fotos semanais das casas dos trabalhadores
--  Cole tudo no Supabase → SQL Editor → New query → Run (uma vez).
--  Pode ser o mesmo projeto Supabase do site dos transportes: as tabelas
--  daqui começam todas por "casas" e não tocam nas outras.
--  Depois corra "2-casas-do-excel.sql" para carregar as casas.
-- =====================================================================

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- ---------------------------------------------------------------- pessoas
create table if not exists public.casas_pessoas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete set null,
  nome text not null,
  email text unique,
  telefone text,
  papel text not null default 'encarregado' check (papel in ('gestor', 'encarregado')),
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

-- ------------------------------------------------------------------ casas
create table if not exists public.casas (
  id uuid primary key default gen_random_uuid(),
  ref text unique,
  pais text not null default 'PT',
  cc text,
  obra text,
  nome text not null,
  morada text,
  notas text,
  encarregado_id uuid references public.casas_pessoas (id) on delete set null,
  ativa boolean not null default true,
  criado_em timestamptz not null default now()
);

-- ----------------------------------------------------------------- regras
create table if not exists public.casas_regras (
  id int primary key default 1 check (id = 1),
  dia_limite int not null default 5 check (dia_limite between 1 and 7),   -- 1 = segunda … 7 = domingo
  hora_limite time not null default '18:00',
  min_fotos int not null default 6 check (min_fotos between 1 and 40),
  divisoes text[] not null default array['Fachada / exterior', 'Sala', 'Cozinha', 'Casa de banho', 'Quartos'],
  perguntas text[] not null default array[
    'A casa está limpa e arrumada?',
    'Há danos, avarias ou coisas partidas?',
    'Há humidade, bolor ou infiltrações?',
    'Há lixo acumulado dentro ou fora da casa?',
    'Os eletrodomésticos funcionam todos?'],
  so_fotos_recentes boolean not null default true,   -- recusa fotos tiradas antes desta semana
  carimbo boolean not null default true,              -- escreve data, hora e casa em cada foto
  guardar_semanas int not null default 12 check (guardar_semanas between 2 and 520),
  texto text not null default
    'Todas as semanas, cada casa tem de ter fotos de todas as divisões pedidas, tiradas na própria semana.
Responda às perguntas com verdade e escreva qualquer problema (avarias, danos, vizinhos, senhorio).
Depois de entregue, o relatório já não pode ser alterado.
Relatórios fora do prazo ficam marcados como atrasados e contam para o cumprimento de cada encarregado.',
  atualizado_em timestamptz not null default now()
);
insert into public.casas_regras (id) values (1) on conflict do nothing;

-- ------------------------------------------------------ relatórios e fotos
create table if not exists public.casas_relatorios (
  id uuid primary key default gen_random_uuid(),
  casa_id uuid not null references public.casas (id) on delete cascade,
  semana date not null check (extract(isodow from semana) = 1),   -- segunda-feira
  pessoa_id uuid references public.casas_pessoas (id) on delete set null,
  estado text check (estado in ('bom', 'atencao', 'mau')),
  respostas jsonb not null default '{}',
  ocupantes int,
  problema text,
  observacoes text,
  entregue_em timestamptz,
  prazo timestamptz,
  visto_em timestamptz,
  comentario_gestor text,
  problema_resolvido boolean not null default false,
  criado_em timestamptz not null default now(),
  unique (casa_id, semana)
);

create table if not exists public.casas_fotos (
  id uuid primary key default gen_random_uuid(),
  relatorio_id uuid not null references public.casas_relatorios (id) on delete cascade,
  casa_id uuid not null references public.casas (id) on delete cascade,
  semana date not null,
  divisao text not null,
  caminho text not null unique,
  tirada_em timestamptz,
  criado_por uuid default auth.uid(),
  criado_em timestamptz not null default now(),
  apagada_em timestamptz          -- a foto foi apagada do armazenamento (fora do prazo de guardar)
);
create index if not exists casas_fotos_rel on public.casas_fotos (relatorio_id);
create index if not exists casas_rel_semana on public.casas_relatorios (semana);

-- ----------------------------------------------------------- funções base
create or replace function public.casas_eu() returns uuid
language sql stable security definer set search_path = public as $$
  select id from casas_pessoas where user_id = (select auth.uid()) and ativo;
$$;

create or replace function public.casas_e_gestor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from casas_pessoas where user_id = (select auth.uid()) and ativo and papel = 'gestor');
$$;

-- A casa (pelo id em texto, ex. na pasta da foto) está entregue a mim?
create or replace function public.casas_e_minha(casa text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from casas c join casas_pessoas p on p.id = c.encarregado_id
                 where c.id::text = casa and p.user_id = (select auth.uid()) and p.ativo);
$$;

-- Segunda-feira da semana atual (hora de Portugal)
create or replace function public.casas_semana_atual() returns date
language sql stable as $$
  select date_trunc('week', (now() at time zone 'Europe/Lisbon'))::date;
$$;

-- Prazo de entrega de uma semana, segundo as regras
create or replace function public.casas_prazo(semana date) returns timestamptz
language sql stable security definer set search_path = public as $$
  select ((semana + (r.dia_limite - 1)) + r.hora_limite) at time zone 'Europe/Lisbon' from casas_regras r where r.id = 1;
$$;

-- Ao entrar: liga a conta à pessoa com o mesmo email
create or replace function public.casas_ligar() returns json
language plpgsql security definer set search_path = public as $$
declare p casas_pessoas;
begin
  update casas_pessoas set user_id = auth.uid()
   where user_id is null and lower(email) = lower(auth.jwt() ->> 'email')
     and not exists (select 1 from casas_pessoas where user_id = auth.uid());
  select * into p from casas_pessoas where user_id = auth.uid();
  return json_build_object('pessoa', case when p.id is null then null else row_to_json(p) end, 'ha_gestor', exists (select 1 from casas_pessoas where papel = 'gestor' and ativo));
end;
$$;

-- A primeira pessoa a entrar (quando ainda não há gestor) fica gestora
create or replace function public.casas_primeiro_gestor(nome text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from casas_pessoas where papel = 'gestor') then raise exception 'Já existe um gestor.'; end if;
  insert into casas_pessoas (user_id, nome, email, papel) values (auth.uid(), nome, auth.jwt() ->> 'email', 'gestor')
  on conflict (user_id) do update set papel = 'gestor', ativo = true;
end;
$$;

-- ----------------------------------------------- proteção dos relatórios
-- O encarregado não pode marcar como entregue, nem mexer no que é do gestor.
create or replace function public.casas_relatorio_proteger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.prazo is null then new.prazo := casas_prazo(new.semana); end if;
  if tg_op = 'INSERT' and new.pessoa_id is null then new.pessoa_id := casas_eu(); end if;
  if coalesce(current_setting('casas.sistema', true), '') = '1' or casas_e_gestor() then return new; end if;
  if tg_op = 'INSERT' then
    if new.semana <> casas_semana_atual() then raise exception 'Só pode fazer o relatório da semana atual.'; end if;
    new.pessoa_id := casas_eu(); new.entregue_em := null; new.visto_em := null;
    new.comentario_gestor := null; new.problema_resolvido := false; new.prazo := casas_prazo(new.semana);
  else
    if old.entregue_em is not null then raise exception 'Este relatório já foi entregue e não pode ser alterado.'; end if;
    new.casa_id := old.casa_id; new.semana := old.semana; new.pessoa_id := casas_eu(); new.entregue_em := null;
    new.prazo := old.prazo; new.visto_em := old.visto_em; new.comentario_gestor := old.comentario_gestor;
    new.problema_resolvido := old.problema_resolvido;
  end if;
  return new;
end;
$$;
drop trigger if exists casas_relatorio_proteger on public.casas_relatorios;
create trigger casas_relatorio_proteger before insert or update on public.casas_relatorios
  for each row execute function public.casas_relatorio_proteger();

-- Entregar: verifica as regras no servidor (não só no telemóvel)
create or replace function public.casas_entregar(rel uuid) returns json
language plpgsql security definer set search_path = public as $$
declare r casas_relatorios; g casas_regras; n int; falta text[]; sem_resp int;
begin
  select * into r from casas_relatorios where id = rel for update;
  if r.id is null or not (casas_e_minha(r.casa_id::text) or casas_e_gestor()) then raise exception 'Relatório não encontrado.'; end if;
  if r.entregue_em is not null then raise exception 'Este relatório já foi entregue.'; end if;
  if r.semana < casas_semana_atual() and not casas_e_gestor() then raise exception 'Essa semana já terminou: o relatório ficou em falta.'; end if;
  select * into g from casas_regras where id = 1;
  select count(*) into n from casas_fotos where relatorio_id = rel;
  if n < g.min_fotos then raise exception 'Faltam fotos: tem %, o mínimo são %.', n, g.min_fotos; end if;
  select array_agg(d) into falta from unnest(g.divisoes) d
   where not exists (select 1 from casas_fotos f where f.relatorio_id = rel and f.divisao = d);
  if falta is not null then raise exception 'Faltam fotos de: %', array_to_string(falta, ', '); end if;
  select count(*) into sem_resp from unnest(g.perguntas) q where coalesce(r.respostas ->> q, '') = '';
  if sem_resp > 0 then raise exception 'Responda a todas as perguntas (faltam %).', sem_resp; end if;
  if r.estado is null then raise exception 'Escolha o estado geral da casa.'; end if;
  perform set_config('casas.sistema', '1', true);
  update casas_relatorios set entregue_em = now(), pessoa_id = coalesce(casas_eu(), pessoa_id), prazo = coalesce(prazo, casas_prazo(semana)) where id = rel returning * into r;
  return json_build_object('entregue_em', r.entregue_em, 'atrasado', r.entregue_em > r.prazo);
end;
$$;

-- ------------------------------------------------------------- segurança
alter table public.casas_pessoas enable row level security;
alter table public.casas enable row level security;
alter table public.casas_regras enable row level security;
alter table public.casas_relatorios enable row level security;
alter table public.casas_fotos enable row level security;

drop policy if exists "pessoas: ver" on public.casas_pessoas;
create policy "pessoas: ver" on public.casas_pessoas for select to authenticated
  using (user_id = (select auth.uid()) or public.casas_e_gestor());
drop policy if exists "pessoas: gestor" on public.casas_pessoas;
create policy "pessoas: gestor" on public.casas_pessoas for all to authenticated
  using (public.casas_e_gestor()) with check (public.casas_e_gestor());

drop policy if exists "casas: ver" on public.casas;
create policy "casas: ver" on public.casas for select to authenticated
  using (public.casas_e_gestor() or encarregado_id = public.casas_eu());
drop policy if exists "casas: gestor" on public.casas;
create policy "casas: gestor" on public.casas for all to authenticated
  using (public.casas_e_gestor()) with check (public.casas_e_gestor());

drop policy if exists "regras: ver" on public.casas_regras;
create policy "regras: ver" on public.casas_regras for select to authenticated using (public.casas_eu() is not null);
drop policy if exists "regras: gestor" on public.casas_regras;
create policy "regras: gestor" on public.casas_regras for update to authenticated
  using (public.casas_e_gestor()) with check (public.casas_e_gestor());

drop policy if exists "relatorios: ver" on public.casas_relatorios;
create policy "relatorios: ver" on public.casas_relatorios for select to authenticated
  using (public.casas_e_gestor() or public.casas_e_minha(casa_id::text));
drop policy if exists "relatorios: criar" on public.casas_relatorios;
create policy "relatorios: criar" on public.casas_relatorios for insert to authenticated
  with check (public.casas_e_gestor() or public.casas_e_minha(casa_id::text));
drop policy if exists "relatorios: alterar" on public.casas_relatorios;
create policy "relatorios: alterar" on public.casas_relatorios for update to authenticated
  using (public.casas_e_gestor() or (public.casas_e_minha(casa_id::text) and entregue_em is null))
  with check (public.casas_e_gestor() or public.casas_e_minha(casa_id::text));
drop policy if exists "relatorios: apagar" on public.casas_relatorios;
create policy "relatorios: apagar" on public.casas_relatorios for delete to authenticated using (public.casas_e_gestor());

drop policy if exists "fotos: ver" on public.casas_fotos;
create policy "fotos: ver" on public.casas_fotos for select to authenticated
  using (public.casas_e_gestor() or public.casas_e_minha(casa_id::text));
drop policy if exists "fotos: juntar" on public.casas_fotos;
create policy "fotos: juntar" on public.casas_fotos for insert to authenticated
  with check (public.casas_e_gestor() or (public.casas_e_minha(casa_id::text) and exists (
    select 1 from public.casas_relatorios r where r.id = relatorio_id and r.casa_id = casas_fotos.casa_id and r.entregue_em is null
      and r.semana = public.casas_semana_atual())));
drop policy if exists "fotos: apagar" on public.casas_fotos;
create policy "fotos: apagar" on public.casas_fotos for delete to authenticated
  using (public.casas_e_gestor() or (criado_por = (select auth.uid()) and exists (
    select 1 from public.casas_relatorios r where r.id = relatorio_id and r.entregue_em is null)));

-- ---------------------------------------------- armazenamento das fotos
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('casas-fotos', 'casas-fotos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "casas-fotos: ver" on storage.objects;
create policy "casas-fotos: ver" on storage.objects for select to authenticated
  using (bucket_id = 'casas-fotos' and (public.casas_e_gestor() or public.casas_e_minha(split_part(name, '/', 1))));
drop policy if exists "casas-fotos: enviar" on storage.objects;
create policy "casas-fotos: enviar" on storage.objects for insert to authenticated
  with check (bucket_id = 'casas-fotos' and (public.casas_e_gestor() or public.casas_e_minha(split_part(name, '/', 1))));
drop policy if exists "casas-fotos: apagar" on storage.objects;
create policy "casas-fotos: apagar" on storage.objects for delete to authenticated
  using (bucket_id = 'casas-fotos' and (public.casas_e_gestor() or (owner_id = (select auth.uid())::text)));

-- ---------------------------------------------------- notificações (push)
create table if not exists public.casas_push_subs (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  criado_em timestamptz not null default now()
);
alter table public.casas_push_subs enable row level security;
drop policy if exists "push: as minhas" on public.casas_push_subs;
create policy "push: as minhas" on public.casas_push_subs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table if not exists public.casas_push_config (
  id int primary key default 1 check (id = 1),
  url text, publica text, privada text, segredo text
);
alter table public.casas_push_config enable row level security;   -- sem políticas: o site não lê

create table if not exists public.casas_push_enviados (chave text primary key, em timestamptz not null default now());
alter table public.casas_push_enviados enable row level security;

create or replace function public.casas_disparar(corpo jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare c record;
begin
  select url, segredo into c from casas_push_config where id = 1;
  if c.url is null or c.segredo is null then return; end if;
  perform net.http_post(url := c.url, body := corpo,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-segredo', c.segredo));
exception when others then
  raise warning 'aviso não enviado: %', sqlerrm;
end;
$$;
revoke execute on function public.casas_disparar(jsonb) from public, anon, authenticated;

-- Avisar o gestor quando um relatório chega com problemas, e o encarregado quando o gestor comenta
create or replace function public.casas_relatorio_avisar() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.entregue_em is not null and old.entregue_em is null then
    perform casas_disparar(jsonb_build_object('evento', 'entregue', 'id', new.id));
  elsif coalesce(new.comentario_gestor, '') <> coalesce(old.comentario_gestor, '') and coalesce(new.comentario_gestor, '') <> '' then
    perform casas_disparar(jsonb_build_object('evento', 'comentario', 'id', new.id));
  end if;
  return null;
end;
$$;
drop trigger if exists casas_relatorio_avisar on public.casas_relatorios;
create trigger casas_relatorio_avisar after update on public.casas_relatorios
  for each row execute function public.casas_relatorio_avisar();

-- De hora a hora: lembretes, fim do prazo, resumo ao gestor e limpeza das fotos antigas
do $$ begin perform cron.unschedule('casas-de-hora-a-hora'); exception when others then null; end $$;
select cron.schedule('casas-de-hora-a-hora', '2 * * * *', $$ select public.casas_disparar('{"evento":"hora"}'::jsonb) $$);

-- ------------------------------------------------- convites por link
-- O gestor envia a cada encarregado um link pessoal; a pessoa escolhe a palavra-passe e fica com conta.
alter table public.casas_pessoas add column if not exists convite text unique;

-- Quem abre o link (ainda sem conta) só fica a saber o nome e o email desse convite
create or replace function public.casas_convite_info(token text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('nome', nome, 'email', email) from casas_pessoas
   where convite = token and length(token) >= 20 and ativo and user_id is null;
$$;
grant execute on function public.casas_convite_info(text) to anon, authenticated;
