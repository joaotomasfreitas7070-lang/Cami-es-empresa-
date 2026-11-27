-- =====================================================================
--  Transportes Freitas — atualização 4: documentos do condutor
--  Cole tudo no Supabase → SQL Editor → New query → Run (uma vez).
--  Não apaga dados: só acrescenta campos e uma função.
-- =====================================================================

alter table public.membros add column if not exists carta_validade date;
alter table public.membros add column if not exists carta_categorias text;
alter table public.membros add column if not exists cqm_validade date;
alter table public.membros add column if not exists tacografo_validade date;
alter table public.membros add column if not exists exame_medico_validade date;

-- Cada pessoa pode atualizar as datas dos seus próprios documentos (sem mexer no resto)
create or replace function public.atualizar_meus_documentos(
  p_carta date, p_categorias text, p_cqm date, p_tacografo date, p_exame date)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Sem sessão iniciada'; end if;
  update membros
     set carta_validade = p_carta, carta_categorias = nullif(trim(p_categorias), ''),
         cqm_validade = p_cqm, tacografo_validade = p_tacografo, exame_medico_validade = p_exame
   where user_id = auth.uid();
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.atualizar_meus_documentos(date, text, date, date, date) from anon;
