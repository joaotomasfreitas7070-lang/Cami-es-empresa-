-- =====================================================================
--  Transportes Freitas — atualização 3
--  Salários, clientes e escalas/turnos.
--  Cole tudo no Supabase → SQL Editor → New query → Run (uma vez).
--  Não apaga dados: acrescenta tipos de registo, permissões e regras.
-- =====================================================================

-- Novos tipos de registo
alter table public.registos drop constraint if exists registos_tipo_check;
alter table public.registos add constraint registos_tipo_check check (tipo in (
  'carrinhas', 'viagens', 'abastecimentos', 'despesas', 'custosFixos', 'ferias', 'ocorrencias',
  'salarios', 'processamentos', 'clientes', 'escalas'));

-- Quem pode ver cada tipo de registo
create or replace function public.registo_ver(e uuid, t text, por uuid, d jsonb) returns boolean
language sql stable set search_path = public as $$
  select case t
    when 'carrinhas'      then true
    when 'viagens'        then por = auth.uid() or pode(e, 'viagens_ver_todas') or pode(e, 'financeiro')
    when 'abastecimentos' then por = auth.uid() or pode(e, 'abastecimentos_todos') or pode(e, 'financeiro')
    when 'despesas'       then por = auth.uid() or pode(e, 'financeiro')
    when 'custosFixos'    then pode(e, 'financeiro')
    when 'ferias'         then por = auth.uid() or pode(e, 'ferias_aprovar') or coalesce(d ->> 'estado', 'Pendente') <> 'Pendente'
    when 'ocorrencias'    then por = auth.uid() or pode(e, 'ocorrencias_gerir') or pode(e, 'carrinhas_gerir')
    -- salários: só RH/Contabilidade/Patrão; cada pessoa vê a sua ficha e os seus recibos já fechados
    when 'salarios'       then pode(e, 'salarios') or d ->> 'userId' = auth.uid()::text
    when 'processamentos' then pode(e, 'salarios')
                               or (d ->> 'userId' = auth.uid()::text and d ->> 'estado' in ('Fechado', 'Pago'))
    when 'clientes'       then pode(e, 'clientes') or pode(e, 'viagens_registar') or pode(e, 'viagens_ver_todas') or pode(e, 'financeiro')
    when 'escalas'        then true
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
    when 'ferias'         then pode(e, 'ferias_aprovar')
                               or (por = auth.uid() and coalesce(d ->> 'estado', 'Pendente') in ('Pendente', 'Cancelado'))
    when 'ocorrencias'    then pode(e, 'ocorrencias_gerir') or pode(e, 'carrinhas_gerir')
                               or (por = auth.uid() and coalesce(d ->> 'estado', 'Aberto') = 'Aberto')
    when 'salarios'       then pode(e, 'salarios')
    when 'processamentos' then pode(e, 'salarios')
    when 'clientes'       then pode(e, 'clientes')
    when 'escalas'        then pode(e, 'escalas_gerir')
    else false
  end;
$$;

-- Novas permissões nos papéis que já existem
update public.papeis_permissoes set permissoes = array(select distinct unnest(permissoes || '{salarios}'::text[]))
 where papel in ('rh', 'contabilidade');
update public.papeis_permissoes set permissoes = array(select distinct unnest(permissoes || '{clientes}'::text[]))
 where papel in ('contabilidade', 'logistica', 'marketing');
update public.papeis_permissoes set permissoes = array(select distinct unnest(permissoes || '{escalas_gerir}'::text[]))
 where papel in ('logistica', 'rh');

-- Empresas novas já vêm com estas permissões
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
    (e, 'rh',            '{ferias_aprovar,pessoas_gerir,avisos_aniversarios,avisos_ferias,salarios,escalas_gerir}'),
    (e, 'contabilidade', '{financeiro,precos,viagens_ver_todas,viagens_editar_todas,abastecimentos_todos,despesas_registar,salarios,clientes}'),
    (e, 'logistica',     '{precos,viagens_registar,viagens_ver_todas,viagens_editar_todas,abastecimentos_registar,abastecimentos_todos,despesas_registar,carrinhas_gerir,ocorrencias_gerir,avisos_ferias,clientes,escalas_gerir}'),
    (e, 'condutor',      '{viagens_registar,abastecimentos_registar}'),
    (e, 'mecanico',      '{abastecimentos_registar,abastecimentos_todos,despesas_registar,carrinhas_gerir,ocorrencias_gerir}'),
    (e, 'marketing',     '{viagens_ver_todas,avisos_aniversarios,clientes}');
  return e;
end;
$$;
