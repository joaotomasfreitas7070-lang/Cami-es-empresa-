// Supabase Edge Function "casas-avisos" — Casas das Obras
//  • De hora a hora (pg_cron): avisa os encarregados na segunda-feira, lembra antes do prazo,
//    avisa quando o prazo termina, manda o resumo ao gestor e apaga as fotos mais antigas.
//  • Chamada pela base de dados quando um relatório é entregue (problemas → gestor)
//    ou quando o gestor comenta (→ encarregado).
//  • Chamada pelo site: chave pública, notificação de teste, "lembrar agora" e criar contas.
// As chaves (VAPID) e o segredo são criados sozinhos na primeira utilização.
import webpush from 'npm:web-push@3.6.7';
import postgres from 'npm:postgres@3.4.5';
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 3 });
const URL_SB = Deno.env.get('SUPABASE_URL')!;
const SERVICO = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SITE = 'https://joaotomasfreitas7070-lang.github.io/Cami-es-empresa-/obras/';
const BUCKET = 'casas-fotos';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const DIAS = ['', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];

// Agora em Portugal: data AAAA-MM-DD, dia da semana (1 = segunda) e hora
function agoraPT() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const dia = `${p.year}-${p.month}-${p.day}`;
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1;
  const segunda = new Date(Date.parse(dia + 'T00:00:00Z') - (dow - 1) * 864e5).toISOString().slice(0, 10);
  return { dia, dow, hora: Number(p.hour) % 24, segunda };
}

// "funcao" = o nome (slug) com que a função foi publicada; o site envia-o para o relógio de hora a hora a chamar bem
async function configurar(funcao?: string) {
  let [c] = await sql`select * from public.casas_push_config where id = 1`;
  if (c?.publica && funcao && /^[a-z0-9-]{1,64}$/.test(funcao) && c.url !== `${URL_SB}/functions/v1/${funcao}`) {
    [c] = await sql`update public.casas_push_config set url = ${`${URL_SB}/functions/v1/${funcao}`} where id = 1 returning *`;
  }
  if (!c?.publica || !c?.segredo) {
    const k = webpush.generateVAPIDKeys();
    const segredo = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const url = `${URL_SB}/functions/v1/${funcao && /^[a-z0-9-]{1,64}$/.test(funcao) ? funcao : 'casas-avisos'}`;
    [c] = await sql`insert into public.casas_push_config (id, url, publica, privada, segredo) values (1, ${url}, ${k.publicKey}, ${k.privateKey}, ${segredo})
      on conflict (id) do update set url = excluded.url,
        publica = coalesce(casas_push_config.publica, excluded.publica), privada = coalesce(casas_push_config.privada, excluded.privada),
        segredo = coalesce(casas_push_config.segredo, excluded.segredo)
      returning *`;
  }
  webpush.setVapidDetails(SITE, c.publica, c.privada);
  return c;
}

type Msg = { titulo: string; corpo: string; tag?: string; urgente?: boolean; abrir?: string };
async function enviar(userIds: (string | null)[], msg: Msg) {
  const ids = [...new Set(userIds.filter(Boolean))] as string[];
  if (!ids.length) return 0;
  const subs = await sql`select * from public.casas_push_subs where user_id = any(${ids}::uuid[])`;
  let n = 0;
  await Promise.all(subs.map(async (s: any) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ ...msg, url: SITE + (msg.abrir || '') }), { TTL: 86400, urgency: msg.urgente ? 'high' : 'normal' });
      n++;
    } catch (e: any) {
      console.error('push recusado', e?.statusCode, e?.body);
      if (e?.statusCode === 404 || e?.statusCode === 410) await sql`delete from public.casas_push_subs where endpoint = ${s.endpoint}`;
    }
  }));
  return n;
}

async function umaVez(chave: string) {
  const r = await sql`insert into public.casas_push_enviados (chave) values (${chave}) on conflict do nothing returning chave`;
  return r.length > 0;
}

const gestores = async () => (await sql`select user_id from public.casas_pessoas where papel = 'gestor' and ativo and user_id is not null`)
  .map((r: any) => r.user_id as string);

// Casas por entregar nesta semana, agrupadas por encarregado
async function pendentes(semana: string) {
  const linhas = await sql`
    select p.id as pessoa_id, p.user_id, p.nome as encarregado, c.nome as casa
      from public.casas c join public.casas_pessoas p on p.id = c.encarregado_id and p.ativo
     where c.ativa and not exists (select 1 from public.casas_relatorios r
             where r.casa_id = c.id and r.semana = ${semana}::date and r.entregue_em is not null)
     order by p.nome, c.nome`;
  const por = new Map<string, { user_id: string | null; nome: string; casas: string[] }>();
  for (const l of linhas) {
    if (!por.has(l.pessoa_id)) por.set(l.pessoa_id, { user_id: l.user_id, nome: l.encarregado, casas: [] });
    por.get(l.pessoa_id)!.casas.push(l.casa);
  }
  return por;
}
const lista = (casas: string[]) => casas.slice(0, 4).join(' · ') + (casas.length > 4 ? ` e mais ${casas.length - 4}` : '');
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

async function deHoraAHora() {
  const [g] = await sql`select dia_limite, extract(hour from hora_limite)::int as h, to_char(hora_limite, 'HH24:MI') as hm, guardar_semanas
                          from public.casas_regras where id = 1`;
  const t = agoraPT();
  const prazo = `${DIAS[g.dia_limite]} às ${g.hm}`;
  const antesDoPrazo = t.dow < g.dia_limite || (t.dow === g.dia_limite && t.hora < g.h);
  let enviadas = 0;
  const pend = await pendentes(t.segunda);

  // 1) Segunda-feira de manhã: nova semana
  if (t.dow === 1 && t.hora === 8) {
    for (const [id, p] of pend) {
      if (await umaVez(`inicio:${t.segunda}:${id}`)) {
        enviadas += await enviar([p.user_id], {
          titulo: '📸 Nova semana: fotos das casas',
          corpo: `Tem ${plural(p.casas.length, 'casa', 'casas')} para fotografar até ${prazo}: ${lista(p.casas)}`, tag: 'semana' });
      }
    }
  }
  // 2) Lembretes antes do prazo: véspera às 18h, no dia às 9h e 2 horas antes
  const lembrar = antesDoPrazo && (
    (t.dow === g.dia_limite - 1 && t.hora === 18) ||
    (t.dow === g.dia_limite && (t.hora === 9 || t.hora === g.h - 2)));
  if (lembrar) {
    for (const [id, p] of pend) {
      if (await umaVez(`lembrete:${t.dia}:${t.hora}:${id}`)) {
        enviadas += await enviar([p.user_id], {
          titulo: `⏰ Faltam fotos de ${plural(p.casas.length, 'casa', 'casas')}`,
          corpo: `O prazo é ${prazo}. ${lista(p.casas)}`, tag: 'semana', urgente: t.dow === g.dia_limite });
      }
    }
  }
  // 3) O prazo terminou: avisa quem falhou e manda o resumo ao gestor (uma vez)
  if (!antesDoPrazo && await umaVez(`fim:${t.segunda}`)) {
    const [tot] = await sql`select count(*)::int as n from public.casas where ativa and encarregado_id is not null`;
    let falta = 0;
    const porPessoa: string[] = [];
    for (const [, p] of pend) {
      falta += p.casas.length;
      porPessoa.push(`${p.nome}: ${p.casas.length}`);
      enviadas += await enviar([p.user_id], {
        titulo: `🔴 Prazo terminou — ${plural(p.casas.length, 'casa', 'casas')} em falta`,
        corpo: `Entregue ainda esta semana (fica marcado como atrasado): ${lista(p.casas)}`, tag: 'semana', urgente: true });
    }
    enviadas += await enviar(await gestores(), {
      titulo: falta ? `📊 Prazo terminou: ${falta} de ${tot.n} casas em falta` : `✅ Todas as ${tot.n} casas entregues a tempo`,
      corpo: falta ? porPessoa.join(' · ') : 'Bom trabalho da equipa esta semana.', tag: 'resumo' });
  }
  // 4) Depois do prazo, até domingo: um lembrete por dia às 9h
  if (!antesDoPrazo && t.hora === 9 && t.dow > g.dia_limite) {
    for (const [id, p] of pend) {
      if (await umaVez(`atraso:${t.dia}:${id}`)) {
        enviadas += await enviar([p.user_id], {
          titulo: `🔴 ${plural(p.casas.length, 'relatório atrasado', 'relatórios atrasados')}`,
          corpo: `A semana acaba domingo. ${lista(p.casas)}`, tag: 'semana', urgente: true });
      }
    }
  }
  // 5) Às 3h: apaga do armazenamento as fotos mais antigas do que o prazo de guardar
  if (t.hora === 3 && await umaVez(`limpar:${t.dia}`)) await limpar(g.guardar_semanas);
  return enviadas;
}

async function limpar(semanas: number) {
  const sb = createClient(URL_SB, SERVICO, { auth: { persistSession: false } });
  for (let volta = 0; volta < 20; volta++) {
    const velhas = await sql`select id, caminho from public.casas_fotos
      where apagada_em is null and semana < (current_date - ${semanas * 7}::int) limit 500`;
    if (!velhas.length) return;
    const { error } = await sb.storage.from(BUCKET).remove(velhas.map((f: any) => f.caminho));
    if (error) { console.error('limpeza', error); return; }
    await sql`update public.casas_fotos set apagada_em = now() where id = any(${velhas.map((f: any) => f.id)}::uuid[])`;
  }
}

// Relatório entregue: se houver problemas avisa logo o gestor
async function entregue(id: string) {
  const [r] = await sql`select r.estado, r.problema, r.entregue_em > r.prazo as atrasado, c.nome as casa, p.nome as quem
    from public.casas_relatorios r join public.casas c on c.id = r.casa_id left join public.casas_pessoas p on p.id = r.pessoa_id
    where r.id = ${id}`;
  if (!r) return 0;
  const problema = (r.problema || '').trim();
  if (r.estado === 'bom' && !problema) return 0;
  return enviar(await gestores(), {
    titulo: `${r.estado === 'mau' ? '🔴' : '⚠️'} ${r.casa}`,
    corpo: `${problema || (r.estado === 'mau' ? 'Casa em mau estado' : 'Precisa de atenção')} — ${r.quem || 'encarregado'}`,
    urgente: r.estado === 'mau', tag: 'rel-' + id, abrir: '#rel=' + id });
}

async function comentario(id: string) {
  const [r] = await sql`select r.comentario_gestor, c.nome as casa, p.user_id
    from public.casas_relatorios r join public.casas c on c.id = r.casa_id left join public.casas_pessoas p on p.id = r.pessoa_id
    where r.id = ${id}`;
  if (!r?.user_id) return 0;
  return enviar([r.user_id], { titulo: `💬 ${r.casa}`, corpo: r.comentario_gestor, tag: 'rel-' + id, abrir: '#rel=' + id });
}

// Quem está a pedir (pelo token da sessão)
async function utilizador(req: Request) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  for (const apikey of [req.headers.get('apikey') || '', Deno.env.get('SUPABASE_ANON_KEY') || ''].filter(Boolean)) {
    const r = await fetch(`${URL_SB}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey } });
    if (r.ok) return (await r.json()).id as string;
  }
  return null;
}
const eGestor = async (uid: string) =>
  (await sql`select 1 from public.casas_pessoas where user_id = ${uid} and papel = 'gestor' and ativo`).length > 0;

// O gestor cria a conta de um encarregado (email da ficha + palavra-passe inicial)
async function criarConta(corpo: any) {
  const senha = String(corpo.senha || '');
  const [p] = await sql`select id, nome, email, user_id from public.casas_pessoas where id = ${corpo.pessoa_id}`;
  if (!p) return { status: 404, erro: 'Pessoa não encontrada.' };
  if (!p.email) return { status: 400, erro: 'Ponha primeiro o email na ficha da pessoa.' };
  if (senha.length < 6) return { status: 400, erro: 'A palavra-passe tem de ter pelo menos 6 caracteres.' };
  if (p.user_id) return { status: 409, erro: 'Esta pessoa já tem conta.' };
  const r = await fetch(`${URL_SB}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICO, Authorization: `Bearer ${SERVICO}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: p.email, password: senha, email_confirm: true, user_metadata: { nome: p.nome } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = String(j.msg || j.message || j.error_description || j.error || r.status);
    if (!/already|registered|exists/i.test(m)) return { status: 409, erro: 'Não foi possível criar a conta: ' + m };
    // Já tem conta neste projeto (ex.: site dos transportes): fica ligada quando entrar com essa conta
    return { status: 200, ok: true, jaExistia: true };
  }
  await sql`update public.casas_pessoas set user_id = ${j.id} where id = ${p.id} and user_id is null`;
  return { status: 200, ok: true };
}

// O encarregado abriu o link do convite e escolheu a palavra-passe: cria a conta já confirmada
async function aceitarConvite(corpo: any) {
  const token = String(corpo.token || '');
  const senha = String(corpo.senha || '');
  if (token.length < 20) return { status: 400, erro: 'Link inválido.' };
  const [p] = await sql`select id, nome, email, user_id, ativo from public.casas_pessoas where convite = ${token}`;
  if (!p || !p.ativo || p.user_id) return { status: 404, erro: 'Este link já foi usado ou já não é válido. Peça um novo ao gestor, ou entre com o seu email e palavra-passe.' };
  const email = String(p.email || corpo.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { status: 400, erro: 'Escreva um email válido.' };
  if (senha.length < 6) return { status: 400, erro: 'A palavra-passe tem de ter pelo menos 6 caracteres.' };
  const [outra] = await sql`select 1 from public.casas_pessoas where lower(email) = ${email} and id <> ${p.id}`;
  if (outra) return { status: 409, erro: 'Este email já está a ser usado por outra pessoa.' };
  const r = await fetch(`${URL_SB}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICO, Authorization: `Bearer ${SERVICO}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: senha, email_confirm: true, user_metadata: { nome: p.nome } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = String(j.msg || j.message || j.error_description || j.error || r.status);
    return { status: 409, erro: /already|registered|exists/i.test(m) ? 'Já existe uma conta com este email: volte ao início e carregue em "Entrar".' : 'Não foi possível criar a conta: ' + m };
  }
  await sql`update public.casas_pessoas set user_id = ${j.id}, email = ${email}, convite = null where id = ${p.id}`;
  return { status: 200, ok: true, email };
}

async function lembrarAgora(pessoaId: string) {
  const t = agoraPT();
  const p = [...(await pendentes(t.segunda)).entries()].find(([id]) => id === pessoaId)?.[1];
  if (!p) return { status: 200, enviadas: 0, aviso: 'Esta pessoa já entregou todas as casas desta semana.' };
  if (!p.user_id) return { status: 200, enviadas: 0, aviso: 'Esta pessoa ainda não entrou no site.' };
  const enviadas = await enviar([p.user_id], {
    titulo: `📸 O gestor pede as fotos de ${plural(p.casas.length, 'casa', 'casas')}`, corpo: lista(p.casas), urgente: true, tag: 'semana' });
  return { status: 200, enviadas, aviso: enviadas ? undefined : 'Esta pessoa não tem as notificações ligadas no telemóvel.' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
  try {
    const corpo = await req.json().catch(() => ({}));
    const c = await configurar(corpo.acao === 'iniciar' ? corpo.funcao : undefined);
    if (corpo.acao === 'iniciar') return json({ publica: c.publica });
    if (corpo.acao === 'aceitar_convite') { const r = await aceitarConvite(corpo); return json(r, r.status); }
    if (corpo.acao) {
      const uid = await utilizador(req);
      if (!uid) return json({ erro: 'Sem sessão' }, 401);
      if (corpo.acao === 'teste') {
        return json({ enviadas: await enviar([uid], { titulo: '🔔 Avisos ligados', corpo: 'Vai receber aqui os lembretes das fotos das casas.' }) });
      }
      if (!(await eGestor(uid))) return json({ erro: 'Só o gestor pode fazer isto.' }, 403);
      if (corpo.acao === 'criar_conta') { const r = await criarConta(corpo); return json(r, r.status); }
      if (corpo.acao === 'lembrar') { const r = await lembrarAgora(corpo.pessoa_id); return json(r, r.status); }
      return json({ erro: 'Pedido desconhecido' }, 400);
    }
    if (req.headers.get('x-segredo') !== c.segredo) return json({ erro: 'Não autorizado' }, 401);
    if (corpo.evento === 'hora') return json({ enviadas: await deHoraAHora() });
    if (corpo.evento === 'entregue') return json({ enviadas: await entregue(corpo.id) });
    if (corpo.evento === 'comentario') return json({ enviadas: await comentario(corpo.id) });
    return json({ erro: 'Pedido desconhecido' }, 400);
  } catch (e) {
    console.error(e);
    return json({ erro: String((e as Error)?.message || e) }, 500);
  }
});
