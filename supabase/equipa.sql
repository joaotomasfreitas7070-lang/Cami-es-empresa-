-- =====================================================================
--  Transportes Freitas — Equipa, papéis e permissões
--  Cole tudo no Supabase → SQL Editor → New query → Run (uma vez).
-- =====================================================================

-- ---------- Tabelas ----------
create table if not exists public.empresas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  parametros jsonb not null default '{}'::jsonb,
  criada_em timestamptz not null default now()
);

create table if not exists public.membros (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  email text not null,
  nome text not null,
  telefone text,
  papel text not null check (papel in ('patrao', 'rh', 'contabilidade', 'logistica', 'condutor', 'mecanico', 'marketing')),
  dias_ferias int not null default 22 check (dias_ferias between 0 and 60),
  data_entrada date,
  criado_em timestamptz not null default now(),
  unique (empresa_id, email)
);
create index if not exists membros_user_idx on public.membros (user_id);

create table if not exists public.papeis_permissoes (
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  papel text not null,
  permissoes text[] not null default '{}',
  primary key (empresa_id, papel)
);

-- Todos os registos da empresa (viagens, abastecimentos, despesas, carrinhas,
-- custos fixos, férias, problemas). Os campos de cada registo ficam em "dados".
create table if not exists public.registos (
  empresa_id uuid not null references public.empresas (id) on delete cascade,
  id text not null,
  tipo text not null check (tipo in ('carrinhas', 'viagens', 'abastecimentos', 'despesas', 'custosFixos', 'ferias', 'ocorrencias')),
  criado_por uuid default auth.uid(),
  dados jsonb not null default '{}'::jsonb,
  apagado boolean not null default false,
  atualizado timestamptz not null default now(),
  primary key (empresa_id, id)
);
create index if not exists registos_sync_idx on public.registos (empresa_id, atualizado);

-- ---------- Funções de permissões ----------
-- (security definer: consultam "membros" sem passar pelas regras, para não haver ciclos)
create or replace function public.e_membro(e uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from membros where empresa_id = e and user_id = auth.uid());
$$;

create or replace function public.pode(e uuid, p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from membros m
    left join papeis_permissoes pp on pp.empresa_id = m.empresa_id and pp.papel = m.papel
    where m.empresa_id = e and m.user_id = auth.uid()
      and (m.papel = 'patrao' or p = any (coalesce(pp.permissoes, '{}')))
  );
$$;

create or replace function public.e_membro_pasta(pasta text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return public.e_membro(pasta::uuid);
exception when others then
  return false;
end;
$$;

-- Quem pode ver cada tipo de registo
create or replace function public.registo_ver(e uuid, t text, por uuid, d jsonb) returns boolean
language sql stable set search_path = public as $$
  select case t
    when 'carrinhas'      then true
    when 'viagens'        then por = auth.uid() or pode(e, 'viagens_ver_todas') or pode(e, 'financeiro')
    when 'abastecimentos' then por = auth.uid() or pode(e, 'abastecimentos_todos') or pode(e, 'financeiro')
    when 'despesas'       then por = auth.uid() or pode(e, 'financeiro')
    when 'custosFixos'    then pode(e, 'financeiro')
    -- os pedidos pendentes são privados; depois de decididos, toda a equipa vê (calendário de ausências)
    when 'ferias'         then por = auth.uid() or pode(e, 'ferias_aprovar') or coalesce(d ->> 'estado', 'Pendente') <> 'Pendente'
    when 'ocorrencias'    then por = auth.uid() or pode(e, 'ocorrencias_gerir') or pode(e, 'carrinhas_gerir')
    else false
  end;
$$;

-- Quem pode criar/alterar/apagar cada tipo de registo
create or replace function public.registo_escrever(e uuid, t text, por uuid, d jsonb) returns boolean
language sql stable set search_path = public as $$
  select case t
    when 'carrinhas'      then pode(e, 'carrinhas_gerir')
    when 'viagens'        then pode(e, 'viagens_editar_todas') or (por = auth.uid() and pode(e, 'viagens_registar'))
    when 'abastecimentos' then pode(e, 'abastecimentos_todos') or (por = auth.uid() and pode(e, 'abastecimentos_registar'))
    when 'despesas'       then pode(e, 'financeiro') or (por = auth.uid() and pode(e, 'despesas_registar'))
    when 'custosFixos'    then pode(e, 'financeiro')
    -- quem pede férias só pode deixar o pedido "Pendente" ou cancelá-lo
    when 'ferias'         then pode(e, 'ferias_aprovar')
                               or (por = auth.uid() and coalesce(d ->> 'estado', 'Pendente') in ('Pendente', 'Cancelado'))
    -- quem reporta um problema só o pode alterar enquanto está "Aberto"
    when 'ocorrencias'    then pode(e, 'ocorrencias_gerir') or pode(e, 'carrinhas_gerir')
                               or (por = auth.uid() and coalesce(d ->> 'estado', 'Aberto') = 'Aberto')
    else false
  end;
$$;

-- ---------- Proteções automáticas ----------
create or replace function public.registos_proteger() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.criado_por := auth.uid();
  else
    new.criado_por := old.criado_por;
    new.empresa_id := old.empresa_id;
    new.tipo := old.tipo;
  end if;
  new.atualizado := clock_timestamp();
  return new;
end;
$$;
drop trigger if exists registos_proteger on public.registos;
create trigger registos_proteger before insert or update on public.registos
  for each row execute function public.registos_proteger();

create or replace function public.membros_proteger() returns trigger
language plpgsql set search_path = public as $$
begin
  new.email := lower(trim(new.email));
  -- só as funções do sistema (criar empresa / aceitar convite) ligam contas
  if coalesce(current_setting('app.sistema', true), '') <> '1' then
    if tg_op = 'INSERT' then new.user_id := null;
    else new.user_id := old.user_id; new.empresa_id := old.empresa_id;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists membros_proteger on public.membros;
create trigger membros_proteger before insert or update on public.membros
  for each row execute function public.membros_proteger();

-- ---------- Regras de acesso (RLS) ----------
alter table public.empresas enable row level security;
alter table public.membros enable row level security;
alter table public.papeis_permissoes enable row level security;
alter table public.registos enable row level security;

drop policy if exists "empresas ver" on public.empresas;
drop policy if exists "empresas alterar" on public.empresas;
create policy "empresas ver" on public.empresas for select to authenticated using (e_membro(id));
create policy "empresas alterar" on public.empresas for update to authenticated
  using (pode(id, 'financeiro')) with check (pode(id, 'financeiro'));

drop policy if exists "membros ver" on public.membros;
drop policy if exists "membros criar" on public.membros;
drop policy if exists "membros alterar" on public.membros;
drop policy if exists "membros apagar" on public.membros;
create policy "membros ver" on public.membros for select to authenticated using (e_membro(empresa_id));
create policy "membros criar" on public.membros for insert to authenticated
  with check (pode(empresa_id, 'pessoas_gerir') and (papel <> 'patrao' or pode(empresa_id, 'permissoes_gerir')));
create policy "membros alterar" on public.membros for update to authenticated
  using (pode(empresa_id, 'pessoas_gerir') and (papel <> 'patrao' or pode(empresa_id, 'permissoes_gerir')))
  with check (pode(empresa_id, 'pessoas_gerir') and (papel <> 'patrao' or pode(empresa_id, 'permissoes_gerir')));
create policy "membros apagar" on public.membros for delete to authenticated
  using (pode(empresa_id, 'pessoas_gerir') and (papel <> 'patrao' or pode(empresa_id, 'permissoes_gerir'))
         and user_id is distinct from auth.uid());

drop policy if exists "papeis ver" on public.papeis_permissoes;
drop policy if exists "papeis alterar" on public.papeis_permissoes;
create policy "papeis ver" on public.papeis_permissoes for select to authenticated using (e_membro(empresa_id));
create policy "papeis alterar" on public.papeis_permissoes for update to authenticated
  using (pode(empresa_id, 'permissoes_gerir')) with check (pode(empresa_id, 'permissoes_gerir'));

drop policy if exists "registos ver" on public.registos;
drop policy if exists "registos criar" on public.registos;
drop policy if exists "registos alterar" on public.registos;
create policy "registos ver" on public.registos for select to authenticated
  using (e_membro(empresa_id) and registo_ver(empresa_id, tipo, criado_por, dados));
create policy "registos criar" on public.registos for insert to authenticated
  with check (e_membro(empresa_id) and registo_escrever(empresa_id, tipo, criado_por, dados));
create policy "registos alterar" on public.registos for update to authenticated
  using (e_membro(empresa_id) and registo_escrever(empresa_id, tipo, criado_por, dados))
  with check (e_membro(empresa_id) and registo_escrever(empresa_id, tipo, criado_por, dados));
-- (não há "apagar": os registos são marcados como apagados, para chegar a todos os telemóveis)

-- ---------- Funções chamadas pelo site ----------
create or replace function public.criar_empresa(p_nome text, p_meu_nome text, p_parametros jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare e uuid;
begin
  if auth.uid() is null then raise exception 'Sem sessão iniciada'; end if;
  insert into empresas (nome, parametros) values (p_nome, coalesce(p_parametros, '{}'::jsonb)) returning id into e;
  perform set_config('app.sistema', '1', true);
  insert into membros (empresa_id, user_id, email, nome, papel)
    values (e, auth.uid(), coalesce(auth.jwt() ->> 'email', ''), p_meu_nome, 'patrao');
  perform set_config('app.sistema', '', true);
  insert into papeis_permissoes (empresa_id, papel, permissoes) values
    (e, 'rh',            '{ferias_aprovar,pessoas_gerir}'),
    (e, 'contabilidade', '{financeiro,precos,viagens_ver_todas,viagens_editar_todas,abastecimentos_todos,despesas_registar}'),
    (e, 'logistica',     '{precos,viagens_registar,viagens_ver_todas,viagens_editar_todas,abastecimentos_registar,abastecimentos_todos,despesas_registar,carrinhas_gerir,ocorrencias_gerir}'),
    (e, 'condutor',      '{viagens_registar,abastecimentos_registar}'),
    (e, 'mecanico',      '{abastecimentos_registar,abastecimentos_todos,despesas_registar,carrinhas_gerir,ocorrencias_gerir}'),
    (e, 'marketing',     '{viagens_ver_todas}');
  return e;
end;
$$;

-- Liga a conta a convites feitos pelo RH com o mesmo email (email já confirmado).
create or replace function public.aceitar_convites() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or coalesce(auth.jwt() ->> 'email', '') = '' then return 0; end if;
  perform set_config('app.sistema', '1', true);
  update membros set user_id = auth.uid()
    where user_id is null and email = lower(auth.jwt() ->> 'email');
  get diagnostics n = row_count;
  perform set_config('app.sistema', '', true);
  return n;
end;
$$;

revoke execute on function public.criar_empresa(text, text, jsonb) from anon;
revoke execute on function public.aceitar_convites() from anon;

-- ---------- Ficheiros da empresa (faturas e fotos dos problemas) ----------
-- Guardados em faturas/<empresa>/... ; qualquer pessoa da empresa os pode ver.
drop policy if exists "empresa: ver ficheiros" on storage.objects;
drop policy if exists "empresa: enviar ficheiros" on storage.objects;
drop policy if exists "empresa: apagar ficheiros" on storage.objects;
create policy "empresa: ver ficheiros" on storage.objects for select to authenticated
  using (bucket_id = 'faturas' and public.e_membro_pasta((storage.foldername(name))[1]));
create policy "empresa: enviar ficheiros" on storage.objects for insert to authenticated
  with check (bucket_id = 'faturas' and public.e_membro_pasta((storage.foldername(name))[1]));
create policy "empresa: apagar ficheiros" on storage.objects for delete to authenticated
  using (bucket_id = 'faturas' and public.e_membro_pasta((storage.foldername(name))[1]));
