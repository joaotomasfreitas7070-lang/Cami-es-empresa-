// Supabase Edge Function "notificar" — Transportes Freitas
// Envia notificações para os telemóveis (Web Push) e cria/apaga as contas dos funcionários (RH).
//  • Chamada pela base de dados quando há pedidos de férias, problemas nas carrinhas,
//    recibos fechados e turnos novos (com o segredo guardado em push_config).
//  • Chamada todos os dias às 07:30 (pg_cron) para o resumo diário.
//  • Chamada pelo site para obter a chave pública e enviar uma notificação de teste.
// As chaves (VAPID) e o segredo são criados sozinhos na primeira utilização.
import webpush from 'npm:web-push@3.6.7';
import postgres from 'npm:postgres@3.4.5';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 3 });
const SITE = 'https://joaotomasfreitas7070-lang.github.io/Cami-es-empresa-/';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DOCS: [string, string][] = [['seguro', 'Seguro'], ['inspecao', 'Inspeção'], ['iuc', 'IUC']];

const dataPT = (iso?: string) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');
const nomeMes = (m: string) => `${MESES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
// Data de hoje (+/- dias) em Portugal, no formato AAAA-MM-DD
const diaPT = (mais = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() + mais * 864e5));
const diasEntre = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

async function configurar() {
  let [c] = await sql`select * from public.push_config where id = 1`;
  if (!c?.publica || !c?.segredo) {
    const k = webpush.generateVAPIDKeys();
    const segredo = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/notificar`;
    [c] = await sql`insert into public.push_config (id, url, publica, privada, segredo) values (1, ${url}, ${k.publicKey}, ${k.privateKey}, ${segredo})
      on conflict (id) do update set url = excluded.url,
        publica = coalesce(push_config.publica, excluded.publica), privada = coalesce(push_config.privada, excluded.privada),
        segredo = coalesce(push_config.segredo, excluded.segredo)
      returning *`;
  }
  webpush.setVapidDetails(SITE, c.publica, c.privada);
  return c;
}

async function equipa(empresaId: string) {
  const todos = await sql`select user_id, nome, papel, data_nascimento::text as nasc from public.membros where empresa_id = ${empresaId}`;
  const pp = await sql`select papel, permissoes from public.papeis_permissoes where empresa_id = ${empresaId}`;
  const papeis: Record<string, string[]> = Object.fromEntries(pp.map((r: any) => [r.papel, r.permissoes || []]));
  const comConta = todos.filter((m: any) => m.user_id);
  const pode = (m: any, p: string) => m.papel === 'patrao' || (papeis[m.papel] || []).includes(p);
  return {
    todos,
    nome: (uid: string) => todos.find((m: any) => m.user_id === uid)?.nome || 'Alguém',
    com: (...ps: string[]) => comConta.filter((m: any) => ps.some((p) => pode(m, p))).map((m: any) => m.user_id as string),
  };
}

const ultimoEnvio = { subscricoes: 0, recusadas: 0, codigos: [] as (number | string)[] };
async function enviar(userIds: string[], msg: { titulo: string; corpo: string; tag?: string; urgente?: boolean }) {
  const ids = [...new Set(userIds.filter(Boolean))];
  Object.assign(ultimoEnvio, { subscricoes: 0, recusadas: 0, codigos: [] });
  if (!ids.length) return 0;
  const subs = await sql`select * from public.push_subscricoes where user_id = any(${ids}::uuid[])`;
  ultimoEnvio.subscricoes = subs.length;
  let n = 0;
  await Promise.all(subs.map(async (s: any) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ ...msg, url: SITE }), { TTL: 86400, urgency: msg.urgente ? 'high' : 'normal' });
      n++;
    } catch (e: any) {
      ultimoEnvio.recusadas++;
      ultimoEnvio.codigos.push(e?.statusCode || String(e?.message || e).slice(0, 80));
      console.error('push recusado', e?.statusCode, e?.body);
      // Telemóvel que desligou as notificações / desinstalou: apaga a subscrição
      if (e?.statusCode === 404 || e?.statusCode === 410) await sql`delete from public.push_subscricoes where endpoint = ${s.endpoint}`;
    }
  }));
  return n;
}

async function umaVez(chave: string) {
  const r = await sql`insert into public.push_enviados (chave) values (${chave}) on conflict do nothing returning chave`;
  return r.length > 0;
}

// Um registo mudou (chamado pela base de dados)
async function registo(ev: any) {
  const [r] = await sql`select tipo, dados, criado_por, apagado from public.registos where empresa_id = ${ev.empresa_id} and id = ${ev.id}`;
  if (!r || r.apagado) return 0;
  const d = r.dados, autor = r.criado_por as string, eq = await equipa(ev.empresa_id);
  const semAutor = (ids: string[]) => ids.filter((u) => u !== autor);
  switch (r.tipo) {
    case 'ferias':
      if (ev.op === 'INSERT' && d.estado === 'Pendente') {
        return enviar(semAutor(eq.com('ferias_aprovar')), {
          titulo: `🏖️ Pedido de ${String(d.tipo || 'férias').toLowerCase()}`,
          corpo: `${eq.nome(autor)}: ${dataPT(d.inicio)} → ${dataPT(d.fim)} (${d.dias} ${d.dias === 1 ? 'dia útil' : 'dias úteis'}). Toque para aprovar.`, tag: 'ferias-' + ev.id });
      }
      if (ev.op === 'UPDATE' && ev.antes === 'Pendente' && ['Aprovado', 'Recusado'].includes(d.estado)) {
        return enviar([autor], {
          titulo: d.estado === 'Aprovado' ? '✅ Pedido aprovado' : '✕ Pedido recusado',
          corpo: `${d.tipo} de ${dataPT(d.inicio)} a ${dataPT(d.fim)}${d.motivoRecusa ? ' — ' + d.motivoRecusa : ''}`, tag: 'ferias-' + ev.id });
      }
      return 0;
    case 'ocorrencias': {
      const [van] = await sql`select dados->>'matricula' as m from public.registos where empresa_id = ${ev.empresa_id} and id = ${d.carrinhaId || ''}`;
      const na = van?.m ? ' na ' + van.m : '';
      if (ev.op === 'INSERT') {
        return enviar(semAutor(eq.com('ocorrencias_gerir', 'carrinhas_gerir')), {
          titulo: `${d.urgencia === 'alta' ? '🔴 Carrinha parada' : '🔧 Problema'}${na}`,
          corpo: `${d.tipo}: ${d.descricao} (${eq.nome(autor)})`, urgente: d.urgencia === 'alta', tag: 'oc-' + ev.id });
      }
      if (ev.op === 'UPDATE' && ev.antes !== 'Resolvido' && d.estado === 'Resolvido') {
        return enviar([autor], { titulo: '✓ Problema resolvido', corpo: `${d.tipo}${na}${d.resolucao ? ': ' + d.resolucao : ''}`, tag: 'oc-' + ev.id });
      }
      return 0;
    }
    case 'processamentos':
      if (ev.antes === 'Rascunho' && d.estado === 'Fechado' && d.userId) {
        return enviar([d.userId], { titulo: '🧾 Recibo disponível', corpo: `O seu recibo de ${nomeMes(d.mes)} já está no site.`, tag: 'rec-' + ev.id });
      }
      return 0;
    case 'escalas':
      // vários turnos marcados de uma vez → uma só notificação
      if (ev.op === 'INSERT' && d.userId && d.userId !== autor && await umaVez(`esc:${d.userId}:${new Date().toISOString().slice(0, 16)}`)) {
        return enviar([d.userId], { titulo: '📅 Escala atualizada', corpo: `Tem turno a ${dataPT(d.data)} das ${d.inicio} às ${d.fim}. Veja a escala no site.`, tag: 'escala' });
      }
      return 0;
  }
  return 0;
}

// Resumo de todas as manhãs
async function diario() {
  const hoje = diaPT(), amanha = diaPT(1), semana = diaPT(7);
  if (!(await umaVez('diario:' + hoje))) return 0;
  let total = 0;
  for (const { id: e } of await sql`select id from public.empresas`) {
    const eq = await equipa(e);
    const regs = await sql`select tipo, dados, criado_por from public.registos
      where empresa_id = ${e} and not apagado and tipo in ('ferias', 'ocorrencias', 'carrinhas', 'escalas')`;
    const linhas = new Map<string, string[]>();
    const juntar = (ids: string[], txt: string) => ids.forEach((u) => { if (!linhas.has(u)) linhas.set(u, []); linhas.get(u)!.push(txt); });

    for (const m of eq.todos) {
      if (!m.nasc) continue;
      const quem = eq.com('avisos_aniversarios').filter((u) => u !== m.user_id);
      if (m.nasc.slice(5) === amanha.slice(5)) juntar(quem, `🎂 Amanhã é o aniversário de ${m.nome}`);
      if (m.nasc.slice(5) === hoje.slice(5)) juntar(quem, `🎂 Hoje é o aniversário de ${m.nome}`);
    }
    let pendentes = 0, paradas = 0, abertos = 0;
    for (const r of regs) {
      const d = r.dados;
      if (r.tipo === 'ferias' && d.estado === 'Pendente') pendentes++;
      if (r.tipo === 'ferias' && d.estado === 'Aprovado' && (d.inicio === semana || d.inicio === amanha)) {
        juntar(eq.com('avisos_ferias').filter((u) => u !== r.criado_por),
          `🏖️ ${eq.nome(r.criado_por)}: ${String(d.tipo).toLowerCase()} a partir de ${d.inicio === amanha ? 'amanhã' : dataPT(d.inicio)}`);
      }
      if (r.tipo === 'escalas' && d.data === hoje && d.userId) juntar([d.userId], `📅 Hoje tem turno das ${d.inicio} às ${d.fim}`);
      if (r.tipo === 'ocorrencias' && d.estado !== 'Resolvido') { abertos++; if (d.urgencia === 'alta') paradas++; }
      if (r.tipo === 'carrinhas') {
        for (const [campo, nome] of DOCS) {
          if (!d[campo]) continue;
          const dias = diasEntre(hoje, d[campo]);
          if ([30, 7, 1, 0].includes(dias) || dias === -1) {
            juntar(eq.com('carrinhas_gerir'), `🚐 ${d.matricula}: ${nome} ${dias === 0 ? 'termina hoje' : dias < 0 ? 'expirou ontem' : `termina em ${dias} dia${dias > 1 ? 's' : ''}`}`);
          }
        }
      }
    }
    if (pendentes) juntar(eq.com('ferias_aprovar'), `🏖️ ${pendentes} pedido${pendentes > 1 ? 's' : ''} de férias por aprovar`);
    if (abertos) juntar(eq.com('ocorrencias_gerir'), paradas ? `🔴 ${paradas} carrinha${paradas > 1 ? 's' : ''} parada${paradas > 1 ? 's' : ''} · ${abertos} problema${abertos > 1 ? 's' : ''} por resolver` : `🔧 ${abertos} problema${abertos > 1 ? 's' : ''} por resolver`);

    for (const [u, l] of linhas) {
      total += await enviar([u], l.length === 1
        ? { titulo: l[0], corpo: 'Toque para abrir o site.', tag: 'diario' }
        : { titulo: `☀️ Bom dia! ${l.length} avisos`, corpo: l.join('\n'), tag: 'diario' });
    }
  }
  return total;
}

// Quem está a pedir (para a notificação de teste)
async function utilizador(token: string, chaveDoSite: string) {
  if (!token) return null;
  for (const apikey of [chaveDoSite, Deno.env.get('SUPABASE_ANON_KEY') || ''].filter(Boolean)) {
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey } });
    if (r.ok) return (await r.json()).id as string;
  }
  return null;
}

// O RH/Patrão cria a conta de um funcionário com o email e uma palavra-passe inicial.
// Só funciona para pessoas já adicionadas na empresa, e só por quem tem a permissão "pessoas_gerir".
async function criarConta(callerId: string, corpo: any) {
  const email = String(corpo.email || '').trim().toLowerCase();
  const senha = String(corpo.senha || '');
  if (!email || senha.length < 6) return { status: 400, erro: 'Email e palavra-passe (mínimo 6 caracteres) são obrigatórios.' };
  const [alvo] = await sql`select empresa_id, papel, nome, user_id from public.membros where empresa_id = ${corpo.empresa_id} and email = ${email}`;
  if (!alvo) return { status: 404, erro: 'Adicione primeiro a pessoa na lista da equipa.' };
  const [eu] = await sql`select m.papel, coalesce(pp.permissoes, '{}') as permissoes from public.membros m
    left join public.papeis_permissoes pp on pp.empresa_id = m.empresa_id and pp.papel = m.papel
    where m.empresa_id = ${corpo.empresa_id} and m.user_id = ${callerId}`;
  const patrao = eu?.papel === 'patrao';
  if (!eu || !(patrao || eu.permissoes.includes('pessoas_gerir'))) return { status: 403, erro: 'Sem permissão para criar contas.' };
  if (alvo.papel === 'patrao' && !patrao) return { status: 403, erro: 'Só o Patrão pode criar a conta de outro Patrão.' };
  if (alvo.user_id) return { status: 409, erro: 'Esta pessoa já tem conta. Se se esqueceu da palavra-passe, use "Esqueci-me da palavra-passe".' };
  const chave = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: chave, Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: senha, email_confirm: true, user_metadata: { nome: alvo.nome, trocar_senha: true } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = String(j.msg || j.message || j.error_description || j.error || r.status);
    return { status: 409, erro: /already|registered|exists/i.test(msg) ? 'Já existe uma conta com este email. A pessoa pode entrar com a palavra-passe dela (ou "Esqueci-me da palavra-passe").' : 'Não foi possível criar a conta: ' + msg };
  }
  // Liga já a conta à pessoa da equipa
  await sql.begin(async (t: any) => {
    await t`select set_config('app.sistema', '1', true)`;
    await t`update public.membros set user_id = ${j.id} where empresa_id = ${corpo.empresa_id} and email = ${email} and user_id is null`;
  });
  return { status: 200, ok: true };
}

// O RH/Patrão tira uma pessoa da equipa e apaga a conta dela (email + palavra-passe).
// O trabalho que a pessoa fez (viagens, recibos…) fica guardado.
async function apagarConta(callerId: string, corpo: any) {
  const [alvo] = await sql`select id, user_id, papel, nome from public.membros where empresa_id = ${corpo.empresa_id} and id = ${corpo.membro_id}`;
  if (!alvo) return { status: 404, erro: 'Pessoa não encontrada.' };
  const [eu] = await sql`select m.papel, coalesce(pp.permissoes, '{}') as permissoes from public.membros m
    left join public.papeis_permissoes pp on pp.empresa_id = m.empresa_id and pp.papel = m.papel
    where m.empresa_id = ${corpo.empresa_id} and m.user_id = ${callerId}`;
  const patrao = eu?.papel === 'patrao';
  if (!eu || !(patrao || eu.permissoes.includes('pessoas_gerir'))) return { status: 403, erro: 'Sem permissão para remover pessoas.' };
  if (alvo.papel === 'patrao' && !patrao) return { status: 403, erro: 'Só o Patrão pode remover outro Patrão.' };
  if (alvo.user_id === callerId) return { status: 400, erro: 'Não se pode remover a si próprio.' };
  await sql`delete from public.membros where id = ${alvo.id}`;
  if (!alvo.user_id) return { status: 200, ok: true, contaApagada: false };
  await sql`delete from public.push_subscricoes where user_id = ${alvo.user_id}`;
  // Se a pessoa ainda pertencer a outra empresa, a conta não é apagada.
  const [outra] = await sql`select 1 from public.membros where user_id = ${alvo.user_id} limit 1`;
  if (outra) return { status: 200, ok: true, contaApagada: false };
  const chave = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/admin/users/${alvo.user_id}`, {
    method: 'DELETE', headers: { apikey: chave, Authorization: `Bearer ${chave}` },
  });
  return { status: 200, ok: true, contaApagada: r.ok, aviso: r.ok ? undefined : 'Saiu da equipa, mas a conta não foi apagada (apague em Authentication → Users).' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
  try {
    const c = await configurar();
    const corpo = await req.json().catch(() => ({}));
    if (corpo.acao === 'iniciar') return json({ publica: c.publica });
    if (corpo.acao === 'teste') {
      const uid = await utilizador((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), req.headers.get('apikey') || '');
      if (!uid) return json({ erro: 'Sem sessão' }, 401);
      const enviadas = await enviar([uid], { titulo: '🔔 Notificações ligadas', corpo: 'Vai receber aqui os avisos da Transportes Freitas.' });
      return json({ enviadas, ...ultimoEnvio });
    }
    if (corpo.acao === 'apagar_conta') {
      const uid = await utilizador((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), req.headers.get('apikey') || '');
      if (!uid) return json({ erro: 'Sem sessão' }, 401);
      const r = await apagarConta(uid, corpo);
      return json(r, r.status);
    }
    if (corpo.acao === 'criar_conta') {
      const uid = await utilizador((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), req.headers.get('apikey') || '');
      if (!uid) return json({ erro: 'Sem sessão' }, 401);
      const r = await criarConta(uid, corpo);
      return json(r, r.status);
    }
    if (req.headers.get('x-segredo') !== c.segredo) return json({ erro: 'Não autorizado' }, 401);
    if (corpo.evento === 'registo') return json({ enviadas: await registo(corpo) });
    if (corpo.evento === 'diario') return json({ enviadas: await diario() });
    return json({ erro: 'Pedido desconhecido' }, 400);
  } catch (e) {
    console.error(e);
    return json({ erro: String((e as Error)?.message || e) }, 500);
  }
});
