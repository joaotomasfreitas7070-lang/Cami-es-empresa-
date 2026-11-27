-- =====================================================================
--  Transportes Freitas — valores do plano novo (carrinha < 2 500 kg, sociedade)
--  Cole tudo no Supabase → SQL Editor → New query → Run (uma vez).
--  Só mexe nos PARÂMETROS e nos CUSTOS FIXOS. Viagens, abastecimentos,
--  despesas e tudo o resto ficam como estão.
-- =====================================================================

-- 1) Parâmetros (Mais → Parâmetros)
update public.empresas
   set parametros = coalesce(parametros, '{}'::jsonb) || '{
     "consumo": 7, "precoGasoleo": 2.10, "precoObjetivo": 0.85, "reserva": 0.08,
     "ordenado": 1000, "ss": 11, "irs": 15, "encargos": 25.675, "subsidios": "1"
   }'::jsonb;

-- 2) Custos fixos: os antigos (incluindo o Wtransnet) saem; entram os novos (487 €/mês)
--    (ficam marcados como apagados para desaparecerem também dos telemóveis)
update public.registos set apagado = true
 where tipo = 'custosFixos' and not apagado and id not like 'fixo-plano-%';

insert into public.registos (empresa_id, id, tipo, dados)
select e.id, 'fixo-plano-' || x.n, 'custosFixos',
       jsonb_build_object('id', 'fixo-plano-' || x.n, 'nome', x.nome, 'valor', x.valor, 'periodo', 'Mensal')
  from public.empresas e
 cross join (values
   (1, 'Seguro da carrinha', 150),               -- seguros: provisórios até chegarem as cotações
   (2, 'Seguro de mercadorias (CMR)', 100),
   (3, 'Seguro de responsabilidade civil', 50),
   (4, 'Seguro de acidentes de trabalho', 50),
   (5, 'Contabilista', 60),
   (6, 'IUC e inspeção (provisão)', 15),
   (7, 'Claude Pro', 22),
   (8, 'Outros fixos', 40)
 ) as x(n, nome, valor)
on conflict (empresa_id, id) do update set dados = excluded.dados, apagado = false;

-- 3) Confirmar: deve mostrar 8 linhas e o total 487
select e.nome as empresa, count(*) as linhas, sum((r.dados->>'valor')::numeric) as total_mes
  from public.registos r join public.empresas e on e.id = r.empresa_id
 where r.tipo = 'custosFixos' and not r.apagado
 group by e.nome;
