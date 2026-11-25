-- =====================================================================
--  Transportes Freitas — Equipa (atualização 2)
--  Aniversários, telemóvel, contacto de emergência e avisos.
--  Cole tudo no Supabase → SQL Editor → New query → Run (uma vez).
--  Não apaga nada: só acrescenta campos e permissões.
-- =====================================================================

alter table public.membros add column if not exists data_nascimento date;
alter table public.membros add column if not exists contacto_emergencia text;

-- Novas permissões de avisos nos papéis que já existem
update public.papeis_permissoes
   set permissoes = array(select distinct unnest(permissoes || '{avisos_aniversarios}'::text[]))
 where papel in ('rh', 'marketing');
update public.papeis_permissoes
   set permissoes = array(select distinct unnest(permissoes || '{avisos_ferias}'::text[]))
 where papel in ('rh', 'logistica');

-- Cada pessoa pode completar os seus próprios dados (sem mexer no papel nem no resto)
create or replace function public.atualizar_meu_perfil(p_telefone text, p_nascimento date, p_emergencia text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Sem sessão iniciada'; end if;
  update membros
     set telefone = nullif(trim(p_telefone), ''),
         data_nascimento = p_nascimento,
         contacto_emergencia = nullif(trim(p_emergencia), '')
   where user_id = auth.uid();
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.atualizar_meu_perfil(text, date, text) from anon;

-- Empresas novas já vêm com os avisos ligados nos papéis certos
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
    (e, 'rh',            '{ferias_aprovar,pessoas_gerir,avisos_aniversarios,avisos_ferias}'),
    (e, 'contabilidade', '{financeiro,precos,viagens_ver_todas,viagens_editar_todas,abastecimentos_todos,despesas_registar}'),
    (e, 'logistica',     '{precos,viagens_registar,viagens_ver_todas,viagens_editar_todas,abastecimentos_registar,abastecimentos_todos,despesas_registar,carrinhas_gerir,ocorrencias_gerir,avisos_ferias}'),
    (e, 'condutor',      '{viagens_registar,abastecimentos_registar}'),
    (e, 'mecanico',      '{abastecimentos_registar,abastecimentos_todos,despesas_registar,carrinhas_gerir,ocorrencias_gerir}'),
    (e, 'marketing',     '{viagens_ver_todas,avisos_aniversarios}');
  return e;
end;
$$;
