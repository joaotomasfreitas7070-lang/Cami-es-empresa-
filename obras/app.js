/* Casas das Obras — fotos semanais das casas dos trabalhadores
   Encarregados: tiram as fotos de cada casa todas as semanas e respondem às perguntas.
   Gestor: vê quem entregou, quem está atrasado, os problemas, e gere casas, pessoas e regras. */
'use strict';

const NUVEM = window.CASAS_NUVEM;
const sb = supabase.createClient(NUVEM.url, NUVEM.chave);
const BUCKET = 'casas-fotos';
const DIAS = ['', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado', 'domingo'];
const PAISES = { PT: 'Portugal', ES: 'Espanha', FR: 'França' };
const ESTADOS = { bom: 'Bom', atencao: 'Precisa de atenção', mau: 'Mau' };

const E = {
  sessao: null, eu: null, regras: null,
  casas: [], pessoas: [], rels: [], fotosSemana: new Map(),
  semana: null, aba: 'semana', filtro: { texto: '', pais: '', pessoa: '', estado: '' }, selecionadas: new Set(),
};

/* ------------------------------------------------------------ utilidades */
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = () => $('#app');
const pl = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

function aviso(txt, erro = false) {
  const a = $('#aviso');
  a.textContent = txt; a.className = 'aviso' + (erro ? ' erro' : ''); a.hidden = false;
  clearTimeout(aviso.t); aviso.t = setTimeout(() => (a.hidden = true), erro ? 6000 : 3000);
}
const falhou = (e) => { console.error(e); aviso(e?.message || String(e), true); };

// Datas: semanas começam à segunda-feira; prazos na hora de Portugal
const isoDia = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function diaLisboa(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function somaDias(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function segundaDe(iso) { const d = new Date(iso + 'T12:00:00Z'); const w = (d.getUTCDay() + 6) % 7; return somaDias(iso, -w); }
const semanaAtual = () => segundaDe(diaLisboa());
// Data/hora de Lisboa → instante
function emLisboa(iso, hm) {
  const palpite = Date.parse(`${iso}T${hm}:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(palpite)).map((x) => [x.type, x.value]));
  const visto = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
  return new Date(palpite - (visto - palpite));
}
const horaLimite = () => String(E.regras?.hora_limite || '18:00').slice(0, 5);
const prazoDe = (semana) => emLisboa(somaDias(semana, (E.regras?.dia_limite || 5) - 1), horaLimite());
const fimDaSemana = (semana) => emLisboa(somaDias(semana, 7), '00:00');
const dm = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const nomeSemana = (s) => `${dm(s)} a ${dm(somaDias(s, 6))}`;
const dataHora = (t) => t ? new Date(t).toLocaleString('pt-PT', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
function falta(ms) {
  const h = Math.floor(ms / 36e5), d = Math.floor(h / 24);
  if (d >= 1) return `${pl(d, 'dia', 'dias')} e ${pl(h % 24, 'hora', 'horas')}`;
  if (h >= 1) return pl(h, 'hora', 'horas');
  return pl(Math.max(1, Math.floor(ms / 6e4)), 'minuto', 'minutos');
}

// Busca tudo (o Supabase devolve no máximo 1000 linhas de cada vez)
async function todos(fazer) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await fazer().range(i, i + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

/* ------------------------------------------------------------ estado das casas */
// Estado de uma casa numa semana: ok | atraso | curso | pendente | falta
function estadoCasa(casaId, semana, rel = relDe(casaId, semana)) {
  if (rel?.entregue_em) {
    return new Date(rel.entregue_em) > new Date(rel.prazo || prazoDe(semana))
      ? { k: 'atraso', txt: 'Entregue com atraso' } : { k: 'ok', txt: 'Entregue' };
  }
  const agora = new Date();
  if (agora > fimDaSemana(semana)) return { k: 'falta', txt: 'Não entregue' };
  if (agora > prazoDe(semana)) return { k: 'falta', txt: 'Em falta (atrasado)' };
  const n = rel ? (E.fotosSemana.get(rel.id) || 0) : 0;
  return n ? { k: 'curso', txt: `Em curso · ${pl(n, 'foto', 'fotos')}` } : { k: 'pendente', txt: 'Por entregar' };
}
const relDe = (casaId, semana) => E.rels.find((r) => r.casa_id === casaId && r.semana === semana);
const chip = (st) => `<span class="chip ${st.k}">${esc(st.txt)}</span>`;
const temProblema = (r) => r && r.entregue_em && (r.estado !== 'bom' || (r.problema || '').trim());
const pessoaNome = (id) => E.pessoas.find((p) => p.id === id)?.nome || '';
const casaDe = (id) => E.casas.find((c) => c.id === id);

/* ------------------------------------------------------------ arranque e entrada */
async function arrancar() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  sb.auth.onAuthStateChange((ev, s) => {
    if (ev === 'PASSWORD_RECOVERY') return setTimeout(() => novaSenha(), 0);
    if (ev === 'SIGNED_OUT') { E.sessao = null; E.eu = null; ecraEntrar(); }
    else if (s) E.sessao = s;
  });
  const { data } = await sb.auth.getSession();
  E.sessao = data.session;
  const conv = location.hash.match(/convite=([A-Za-z0-9]{20,})/);
  if (conv) return ecraConvite(conv[1]);
  if (!E.sessao) return ecraEntrar();
  await depoisDeEntrar();
}

function ecraEntrar(msg = '') {
  $('#topo').hidden = true;
  app().innerHTML = `
  <div class="entrar"><form class="cartao" id="fEntrar">
    <div class="linha"><img class="logo" src="img/icon-192.png" alt=""><div><h1>Casas das Obras</h1><p class="suave">Fotos semanais das casas</p></div></div>
    ${msg ? `<p class="problema">${esc(msg)}</p>` : ''}
    <label class="campo">Email<input type="email" name="email" autocomplete="username" required></label>
    <label class="campo">Palavra-passe<input type="password" name="senha" autocomplete="current-password" required></label>
    <button class="b p grande" type="submit">Entrar</button>
    <button class="b" type="button" id="esqueci">Esqueci-me da palavra-passe</button>
    <button class="b" type="button" id="criarConta">Criar conta</button>
  </form></div>`;
  $('#criarConta').onclick = async () => {
    const email = $('#fEntrar [name=email]').value.trim(), senha = $('#fEntrar [name=senha]').value;
    if (!email || senha.length < 6) return aviso('Escreva o email e uma palavra-passe (mínimo 6 caracteres) e carregue outra vez em "Criar conta".', true);
    const { data, error } = await sb.auth.signUp({ email, password: senha, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) return falhou(/registered|exists/i.test(error.message) ? new Error('Já existe uma conta com este email: use "Entrar".') : error);
    if (data.session) { E.sessao = data.session; return depoisDeEntrar(); }
    ecraEntrar('Enviámos um email para ' + email + '. Abra-o e carregue no link para confirmar a conta; depois entre aqui.');
  };
  $('#fEntrar').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target), b = ev.target.querySelector('[type=submit]');
    b.disabled = true; b.textContent = 'A entrar…';
    const { data, error } = await sb.auth.signInWithPassword({ email: f.get('email').trim(), password: f.get('senha') });
    if (error) { b.disabled = false; b.textContent = 'Entrar'; return aviso(/invalid/i.test(error.message) ? 'Email ou palavra-passe errados.' : error.message, true); }
    E.sessao = data.session; depoisDeEntrar();
  };
  $('#esqueci').onclick = async () => {
    const email = $('#fEntrar [name=email]').value.trim();
    if (!email) return aviso('Escreva primeiro o seu email.', true);
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    error ? falhou(error) : aviso('Enviámos um email para escolher uma palavra-passe nova.');
  };
}

// O encarregado abriu o link pessoal: escolhe a palavra-passe e fica com conta
async function ecraConvite(token) {
  $('#topo').hidden = true;
  app().innerHTML = '<p class="a-carregar">A abrir o convite…</p>';
  const { data: info, error } = await sb.rpc('casas_convite_info', { token });
  const limpar = () => history.replaceState(null, '', location.pathname);
  if (error || !info) {
    limpar();
    return ecraEntrar('Este link já foi usado ou já não é válido. Se já criou a sua conta, entre com o seu email e palavra-passe. Se não, peça um link novo ao gestor.');
  }
  app().innerHTML = `
  <div class="entrar"><form class="cartao" id="fConvite">
    <div class="linha"><img class="logo" src="img/icon-192.png" alt=""><div><h1>Olá ${esc(info.nome.split(' ')[0])}!</h1><p class="suave">Casas das Obras</p></div></div>
    <p>Foi convidado para enviar todas as semanas as fotos das casas das obras. Escolha a sua palavra-passe para criar a conta.</p>
    <label class="campo">O seu email${info.email ? '' : ' (vai usá-lo para entrar)'}<input type="email" name="email" autocomplete="username" required value="${esc(info.email || '')}" ${info.email ? 'readonly' : ''}></label>
    <label class="campo">Escolha uma palavra-passe (mínimo 6)<input type="password" name="senha" minlength="6" autocomplete="new-password" required></label>
    <label class="campo">Repita a palavra-passe<input type="password" name="senha2" minlength="6" autocomplete="new-password" required></label>
    <button class="b p grande" type="submit">Criar a minha conta</button>
    <p class="suave peq">Guarde bem a palavra-passe: vai usá-la sempre para entrar.</p>
  </form></div>`;
  $('#fConvite').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target), b = ev.target.querySelector('[type=submit]');
    const email = f.get('email').trim().toLowerCase(), senha = f.get('senha');
    if (senha !== f.get('senha2')) return aviso('As palavras-passe não são iguais.', true);
    b.disabled = true; b.textContent = 'A criar a conta…';
    const { data, error: e1 } = await sb.functions.invoke(NUVEM.funcao, { body: { acao: 'aceitar_convite', token, email, senha } });
    let erro = data?.erro;
    if (e1 && !erro) { try { erro = (await e1.context.json()).erro; } catch (e) { erro = 'Não foi possível criar a conta. Tente outra vez.'; } }
    if (erro) { b.disabled = false; b.textContent = 'Criar a minha conta'; return aviso(erro, true); }
    if (E.sessao) await sb.auth.signOut({ scope: 'local' });
    const r = await sb.auth.signInWithPassword({ email: data.email || email, password: senha });
    limpar();
    if (r.error) return ecraEntrar('Conta criada! Entre agora com o seu email e a palavra-passe que escolheu.');
    E.sessao = r.data.session;
    aviso('✅ Conta criada!');
    depoisDeEntrar();
  };
}

function novaSenha() {
  janela(`<form id="fSenha"><h2>Nova palavra-passe</h2>
    <label class="campo">Palavra-passe nova<input type="password" name="s" minlength="6" required autocomplete="new-password"></label>
    <button class="b p" type="submit">Guardar</button></form>`);
  $('#fSenha').onsubmit = async (ev) => {
    ev.preventDefault();
    const { error } = await sb.auth.updateUser({ password: new FormData(ev.target).get('s') });
    if (error) return falhou(error);
    fecharJanela(); aviso('Palavra-passe alterada.'); depoisDeEntrar();
  };
}

async function depoisDeEntrar() {
  app().innerHTML = '<p class="a-carregar">A carregar…</p>';
  const { data, error } = await sb.rpc('casas_ligar');
  if (error) return ecraEntrar(/casas_ligar/.test(error.message) ? 'A base de dados ainda não está preparada: corra o ficheiro 1-criar-tabelas.sql no Supabase.' : error.message);
  E.eu = data.pessoa;
  if (!E.eu || !E.eu.ativo) {
    $('#topo').hidden = true;
    const email = E.sessao?.user?.email || '';
    if (!data.ha_gestor) {
      app().innerHTML = `<div class="entrar"><form class="cartao" id="fGestor"><h1>Bem-vindo!</h1>
        <p>Ainda não há nenhum gestor. Como é a primeira pessoa a entrar, fica como <b>gestor</b>: vê todas as casas, adiciona os encarregados e define as regras.</p>
        <label class="campo">O seu nome<input name="nome" required value="${esc(E.sessao?.user?.user_metadata?.nome || '')}"></label>
        <button class="b p grande">Começar como gestor</button>
        <button class="b" type="button" data-sair>Sair</button></form></div>`;
      $('#fGestor').onsubmit = async (ev) => {
        ev.preventDefault();
        const { error: e2 } = await sb.rpc('casas_primeiro_gestor', { nome: new FormData(ev.target).get('nome').trim() });
        e2 ? falhou(e2) : depoisDeEntrar();
      };
    } else {
      app().innerHTML = `<div class="entrar"><div class="cartao"><h1>Sem acesso</h1>
        <p>A conta <b>${esc(email)}</b> ainda não foi adicionada. Peça ao gestor para o adicionar em <b>Pessoas</b> com este email e volte a entrar.</p>
        <button class="b" type="button" data-sair>Sair</button></div></div>`;
    }
    document.querySelectorAll('[data-sair]').forEach((b) => (b.onclick = () => sb.auth.signOut()));
    return;
  }
  $('#topo').hidden = false;
  $('#botaoConta').textContent = (E.eu.papel === 'gestor' ? '⭐ ' : '👷 ') + E.eu.nome.split(' ')[0];
  $('#botaoConta').onclick = ecraConta;
  try {
    await carregar();
  } catch (e) { return falhou(e); }
  E.semana = semanaAtual();
  const m = location.hash.match(/rel=([0-9a-f-]{36})/);
  if (m) { history.replaceState(null, '', location.pathname); return abrirRelatorioPorId(m[1]); }
  inicio();
}

async function carregar() {
  const [{ data: regras, error: e1 }, casas, pessoas] = await Promise.all([
    sb.from('casas_regras').select('*').eq('id', 1).single(),
    todos(() => sb.from('casas').select('*').order('pais').order('nome')),
    E.eu.papel === 'gestor' ? todos(() => sb.from('casas_pessoas').select('*').order('nome')) : Promise.resolve([E.eu]),
  ]);
  if (e1) throw e1;
  E.regras = regras; E.casas = casas; E.pessoas = pessoas;
  await carregarRelatorios();
}

// Relatórios das últimas 9 semanas + contagem de fotos da semana à vista
async function carregarRelatorios(semanaVista = E.semana || semanaAtual()) {
  const desde = somaDias(semanaAtual(), -8 * 7);
  const de = semanaVista < desde ? semanaVista : desde;
  E.rels = await todos(() => sb.from('casas_relatorios')
    .select('id,casa_id,semana,pessoa_id,estado,problema,entregue_em,prazo,visto_em,problema_resolvido,comentario_gestor,ocupantes')
    .gte('semana', de).order('semana'));
  const fotos = await todos(() => sb.from('casas_fotos').select('relatorio_id').eq('semana', semanaVista));
  E.fotosSemana = new Map();
  fotos.forEach((f) => E.fotosSemana.set(f.relatorio_id, (E.fotosSemana.get(f.relatorio_id) || 0) + 1));
}

function inicio() {
  if (E.eu.papel === 'gestor') { mostrarAbas(); return render(); }
  $('#abas').hidden = true;
  ecraEncarregado();
}
function render() {
  window.scrollTo(0, 0);
  mostrarAbas();
  ({ semana: ecraSemana, problemas: ecraProblemas, casas: ecraCasas, pessoas: ecraPessoas, regras: ecraRegras, minhas: ecraEncarregado })[E.aba]();
}
function mostrarAbas() {
  const abertos = E.rels.filter((r) => temProblema(r) && !r.problema_resolvido).length;
  const minhas = E.casas.some((c) => c.encarregado_id === E.eu.id);
  const abas = [['semana', '📊 Semana'], ['problemas', `⚠️ Problemas${abertos ? `<span class="num">${abertos}</span>` : ''}`],
    ...(minhas ? [['minhas', '📸 As minhas casas']] : []), ['casas', '🏠 Casas'], ['pessoas', '👷 Pessoas'], ['regras', '📋 Regras']];
  const n = $('#abas');
  n.hidden = false;
  n.innerHTML = abas.map(([k, t]) => `<button type="button" data-aba="${k}" class="${E.aba === k ? 'ativa' : ''}">${t}</button>`).join('');
  n.querySelectorAll('button').forEach((b) => (b.onclick = () => { E.aba = b.dataset.aba; E.selecionadas.clear(); render(); }));
}

/* ------------------------------------------------------------ encarregado */
function cartaoPrazo(semana, casasMinhas) {
  const prazo = prazoDe(semana), agora = new Date();
  const feitas = casasMinhas.filter((c) => relDe(c.id, semana)?.entregue_em).length;
  const todas = feitas === casasMinhas.length && casasMinhas.length;
  const passou = agora > prazo;
  const cls = todas ? 'ok' : passou ? 'falta' : '';
  const linha = todas ? '✅ Todas as casas entregues esta semana. Obrigado!'
    : passou ? `🔴 O prazo terminou (${DIAS[E.regras.dia_limite]} às ${horaLimite()}). Entregue ainda hoje: fica marcado como atrasado.`
      : `⏰ Prazo: <b>${DIAS[E.regras.dia_limite]} às ${horaLimite()}</b> — faltam ${falta(prazo - agora)}`;
  return `<section class="prazo ${cls}">
    <div class="linha entre"><h2>Semana de ${nomeSemana(semana)}</h2><span class="gr">${feitas}/${casasMinhas.length}</span></div>
    <p>${linha}</p></section>`;
}

function regrasHTML() {
  const g = E.regras;
  return `<section class="cartao"><h2>📋 Regras</h2>
    <ul class="regras">
      <li>Todas as semanas, até <b>${DIAS[g.dia_limite]} às ${horaLimite()}</b>.</li>
      <li>Mínimo de <b>${g.min_fotos} fotos</b> por casa, com pelo menos uma de: ${g.divisoes.map(esc).join(', ')}.</li>
      ${g.so_fotos_recentes ? '<li>Só são aceites fotos tiradas <b>nesta semana</b>.</li>' : ''}
      ${g.carimbo ? '<li>Cada foto fica com a data, hora e nome da casa.</li>' : ''}
      <li>Responder a todas as perguntas e escolher o estado da casa.</li>
    </ul>
    <p class="texto-livre suave">${esc(g.texto)}</p></section>`;
}

function ecraEncarregado() {
  const s = semanaAtual();
  const minhas = E.casas.filter((c) => c.encarregado_id === E.eu.id && c.ativa);
  const ordem = { falta: 0, pendente: 1, curso: 2, atraso: 3, ok: 4 };
  const lst = minhas.map((c) => ({ c, st: estadoCasa(c.id, s) })).sort((a, b) => ordem[a.st.k] - ordem[b.st.k]);
  app().innerHTML = `
    ${cartaoPrazo(s, minhas)}
    ${avisosDesligados() ? `<section class="cartao destaque"><p><b>🔔 Ligue os avisos</b> para ser lembrado quando faltarem fotos.</p>
      <button class="b p" type="button" id="ligarAvisos">Ligar avisos neste telemóvel</button></section>` : ''}
    <section class="lista">
      ${lst.length ? lst.map(({ c, st }) => `<button class="item" type="button" data-casa="${c.id}">
        <span class="t">${esc(c.nome)}</span><span class="d">${chip(st)}</span>
        <span class="s">${esc(c.obra || '')}</span></button>`).join('')
      : '<div class="cartao"><p>Ainda não tem casas atribuídas. Fale com o gestor.</p></div>'}
    </section>
    ${regrasHTML()}`;
  app().querySelectorAll('[data-casa]').forEach((b) => (b.onclick = () => abrirCasa(b.dataset.casa, s)));
  $('#ligarAvisos')?.addEventListener('click', ligarAvisos);
}

/* ------------------------------------------------------------ uma casa numa semana */
async function abrirRelatorioPorId(id) {
  const { data, error } = await sb.from('casas_relatorios').select('casa_id,semana').eq('id', id).maybeSingle();
  if (error || !data) { inicio(); return aviso('Relatório não encontrado.', true); }
  if (!E.rels.some((r) => r.id === id)) { E.semana = data.semana; await carregarRelatorios(data.semana); }
  abrirCasa(data.casa_id, data.semana);
}

async function abrirCasa(casaId, semana) {
  const casa = casaDe(casaId);
  if (!casa) return aviso('Casa não encontrada.', true);
  app().innerHTML = '<p class="a-carregar">A abrir…</p>';
  window.scrollTo(0, 0);
  const { data: rel, error } = await sb.from('casas_relatorios').select('*').eq('casa_id', casaId).eq('semana', semana).maybeSingle();
  if (error) return falhou(error);
  const fotos = rel ? await todos(() => sb.from('casas_fotos').select('*').eq('relatorio_id', rel.id).order('criado_em')) : [];
  const podeEditar = !rel?.entregue_em && semana === semanaAtual() && (casa.encarregado_id === E.eu.id || E.eu.papel === 'gestor');
  const ctx = { casa, semana, rel, fotos, urls: new Map() };
  await assinar(ctx, fotos);
  podeEditar ? formulario(ctx) : verRelatorio(ctx);
}

async function assinar(ctx, fotos) {
  const caminhos = fotos.filter((f) => !f.apagada_em && !ctx.urls.has(f.caminho)).map((f) => f.caminho);
  if (!caminhos.length) return;
  const { data } = await sb.storage.from(BUCKET).createSignedUrls(caminhos, 3600);
  (data || []).forEach((d) => d.signedUrl && ctx.urls.set(d.path, d.signedUrl));
}

function voltar() {
  if (E.eu.papel === 'gestor') { carregarRelatorios(E.semana).then(render).catch(falhou); }
  else carregarRelatorios(semanaAtual()).then(ecraEncarregado).catch(falhou);
}
const cabecalhoCasa = (ctx) => `
  <div class="linha"><button class="b peq" type="button" id="voltar">‹ Voltar</button></div>
  <section class="cartao"><div><h1>${esc(ctx.casa.nome)}</h1>
    <p class="suave">${esc(ctx.casa.morada && ctx.casa.morada !== ctx.casa.nome ? ctx.casa.morada + ' · ' : '')}${esc(PAISES[ctx.casa.pais] || ctx.casa.pais)}</p>
    <p class="suave peq">${esc(ctx.casa.obra || '')}</p></div>
    <div class="linha entre"><span>Semana de <b>${nomeSemana(ctx.semana)}</b></span>${chip(estadoCasa(ctx.casa.id, ctx.semana, ctx.rel))}</div>
  </section>`;

function fotoHTML(ctx, f, apagar) {
  if (f.apagada_em) return '<div class="foto envio">apagada<br>(antiga)</div>';
  const u = ctx.urls.get(f.caminho) || f.local || '';
  return `<div class="foto" data-foto="${f.id}"><img src="${esc(u)}" alt="${esc(f.divisao)}" loading="lazy">
    ${apagar ? `<button class="x" type="button" data-apagar="${f.id}" aria-label="Apagar foto">✕</button>` : ''}</div>`;
}
function divisoes(ctx) {
  const extra = [...new Set(ctx.fotos.map((f) => f.divisao))].filter((d) => !E.regras.divisoes.includes(d) && d !== 'Outras');
  return [...E.regras.divisoes, ...extra, 'Outras'];
}

function formulario(ctx) {
  const g = E.regras, rel = ctx.rel || {};
  const resp = { ...(rel.respostas || {}) };
  const dados = { estado: rel.estado || null, ocupantes: rel.ocupantes ?? '', problema: rel.problema || '', observacoes: rel.observacoes || '' };
  app().innerHTML = `${cabecalhoCasa(ctx)}
    <section class="cartao" id="secFotos"><h2>📷 Fotos</h2><p class="suave peq">Toque em “Tirar foto” em cada divisão. Mínimo ${g.min_fotos} no total.</p>
      ${divisoes(ctx).map((d) => `<div class="divisao" data-div="${esc(d)}">
        <div class="linha entre"><h3>${esc(d)}${g.divisoes.includes(d) ? '' : ' <span class="suave peq">(opcional)</span>'}</h3><span class="suave peq" data-conta></span></div>
        <div class="fotos" data-lista></div>
        <div class="linha">
          <label class="b p peq">📷 Tirar foto<input type="file" accept="image/*" capture="environment" hidden data-tirar></label>
          <label class="b peq">🖼️ Da galeria<input type="file" accept="image/*" multiple hidden data-tirar></label>
        </div></div>`).join('')}
    </section>
    <section class="cartao"><h2>✅ Perguntas</h2><div>
      ${g.perguntas.map((q, i) => `<div class="pergunta"><span>${esc(q)}</span>
        <div class="seg" data-q="${i}">${['Sim', 'Não'].map((v) => `<button type="button" data-v="${v}" class="${resp[q] === v ? 'sel' : ''}">${v}</button>`).join('')}</div></div>`).join('')}
    </div></section>
    <section class="cartao"><h2>🏠 Estado geral da casa</h2>
      <div class="seg" id="estado">${Object.entries(ESTADOS).map(([k, t]) => `<button type="button" data-v="${k}" class="${k} ${dados.estado === k ? 'sel' : ''}">${t}</button>`).join('')}</div>
      <label class="campo">Quantas pessoas estão a viver na casa?<input type="number" min="0" max="50" inputmode="numeric" id="ocupantes" value="${esc(dados.ocupantes)}"></label>
      <label class="campo">Há algum problema? (o gestor recebe logo um aviso)<textarea id="problema" placeholder="Ex.: esquentador avariado, janela partida, queixa do senhorio…">${esc(dados.problema)}</textarea></label>
      <label class="campo">Observações<textarea id="observacoes">${esc(dados.observacoes)}</textarea></label>
    </section>
    <section class="cartao destaque"><h2>Antes de entregar</h2><ul class="verif" id="verif"></ul>
      <button class="b p grande cheio" type="button" id="entregar">Entregar relatório</button>
      <p class="suave peq">Depois de entregue, já não pode alterar. As respostas ficam guardadas enquanto preenche.</p>
    </section>`;
  $('#voltar').onclick = voltar;

  const desenharFotos = () => {
    app().querySelectorAll('.divisao').forEach((el) => {
      const d = el.dataset.div, fs = ctx.fotos.filter((f) => f.divisao === d);
      el.querySelector('[data-lista]').innerHTML = fs.map((f) => fotoHTML(ctx, f, true)).join('') + (ctx.aEnviar?.[d] ? `<div class="foto envio">a enviar ${ctx.aEnviar[d]}…</div>` : '');
      el.querySelector('[data-conta]').innerHTML = fs.length ? pl(fs.length, 'foto', 'fotos') : (g.divisoes.includes(d) ? '<span class="foto-vazia">falta</span>' : '');
    });
    ligarVisor(ctx);
    verificar();
  };
  const verificar = () => {
    const n = ctx.fotos.length, faltam = g.divisoes.filter((d) => !ctx.fotos.some((f) => f.divisao === d));
    const semResp = g.perguntas.filter((q) => !resp[q]).length;
    const itens = [
      [n >= g.min_fotos, `Fotos: ${n} de ${g.min_fotos}`],
      [!faltam.length, faltam.length ? `Faltam fotos de: ${faltam.join(', ')}` : 'Todas as divisões fotografadas'],
      [!semResp, semResp ? `Faltam ${pl(semResp, 'resposta', 'respostas')}` : 'Perguntas respondidas'],
      [!!dados.estado, dados.estado ? `Estado: ${ESTADOS[dados.estado]}` : 'Escolher o estado geral'],
    ];
    $('#verif').innerHTML = itens.map(([ok, t]) => `<li class="${ok ? 'feito' : ''}">${esc(t)}</li>`).join('');
    $('#entregar').disabled = !itens.every(([ok]) => ok);
  };

  // garante que o relatório existe antes de juntar fotos
  const garantir = async () => {
    if (ctx.rel) return ctx.rel;
    const { data, error } = await sb.from('casas_relatorios').insert({ casa_id: ctx.casa.id, semana: ctx.semana }).select().single();
    if (error) {
      if (error.code === '23505') { // outra pessoa/telemóvel criou entretanto
        const r = await sb.from('casas_relatorios').select('*').eq('casa_id', ctx.casa.id).eq('semana', ctx.semana).single();
        if (r.error) throw r.error; ctx.rel = r.data; return ctx.rel;
      }
      throw error;
    }
    ctx.rel = data; return data;
  };
  let tGuardar;
  const guardar = (ja) => {
    clearTimeout(tGuardar);
    const fazer = async () => {
      try {
        const r = await garantir();
        const { error } = await sb.from('casas_relatorios').update({
          respostas: resp, estado: dados.estado, ocupantes: dados.ocupantes === '' ? null : Number(dados.ocupantes),
          problema: dados.problema.trim() || null, observacoes: dados.observacoes.trim() || null,
        }).eq('id', r.id);
        if (error) throw error;
      } catch (e) { falhou(e); }
    };
    return ja ? fazer() : (tGuardar = setTimeout(fazer, 700));
  };

  app().querySelectorAll('[data-q]').forEach((s) => s.querySelectorAll('button').forEach((b) => (b.onclick = () => {
    resp[g.perguntas[s.dataset.q]] = b.dataset.v;
    s.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
    verificar(); guardar();
  })));
  $('#estado').querySelectorAll('button').forEach((b) => (b.onclick = () => {
    dados.estado = b.dataset.v;
    $('#estado').querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
    verificar(); guardar();
  }));
  ['ocupantes', 'problema', 'observacoes'].forEach((k) => ($('#' + k).oninput = (ev) => { dados[k] = ev.target.value; guardar(); }));

  app().querySelectorAll('[data-tirar]').forEach((inp) => (inp.onchange = async () => {
    const d = inp.closest('.divisao').dataset.div, ficheiros = [...inp.files];
    inp.value = '';
    if (!ficheiros.length) return;
    ctx.aEnviar = ctx.aEnviar || {};
    for (const f of ficheiros) {
      if (g.so_fotos_recentes && f.lastModified && f.lastModified < emLisboa(ctx.semana, '00:00').getTime()) {
        aviso(`Foto recusada: foi tirada a ${new Date(f.lastModified).toLocaleDateString('pt-PT')}. Só são aceites fotos desta semana.`, true);
        continue;
      }
      ctx.aEnviar[d] = (ctx.aEnviar[d] || 0) + 1; desenharFotos();
      try {
        const r = await garantir();
        const blob = await prepararFoto(f, ctx.casa, d);
        const caminho = `${ctx.casa.id}/${ctx.semana}/${(crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2))}.jpg`;
        const up = await sb.storage.from(BUCKET).upload(caminho, blob, { contentType: 'image/jpeg', upsert: false });
        if (up.error) throw up.error;
        const { data, error } = await sb.from('casas_fotos').insert({
          relatorio_id: r.id, casa_id: ctx.casa.id, semana: ctx.semana, divisao: d, caminho,
          tirada_em: new Date(f.lastModified || Date.now()).toISOString(),
        }).select().single();
        if (error) { await sb.storage.from(BUCKET).remove([caminho]); throw error; }
        data.local = URL.createObjectURL(blob);
        ctx.fotos.push(data);
      } catch (e) { falhou(e); }
      ctx.aEnviar[d]--; desenharFotos();
    }
  }));
  $('#secFotos').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-apagar]');
    if (!b) return;
    ev.stopPropagation();
    if (!confirm('Apagar esta foto?')) return;
    const f = ctx.fotos.find((x) => x.id === b.dataset.apagar);
    const { error } = await sb.from('casas_fotos').delete().eq('id', f.id);
    if (error) return falhou(error);
    await sb.storage.from(BUCKET).remove([f.caminho]);
    ctx.fotos = ctx.fotos.filter((x) => x !== f); desenharFotos();
  }, true);

  $('#entregar').onclick = async () => {
    const b = $('#entregar');
    b.disabled = true; b.textContent = 'A entregar…';
    try {
      await guardar(true);
      const { data, error } = await sb.rpc('casas_entregar', { rel: ctx.rel.id });
      if (error) throw error;
      aviso(data.atrasado ? 'Entregue (com atraso).' : '✅ Relatório entregue. Obrigado!');
      voltar();
    } catch (e) { falhou(e); b.disabled = false; b.textContent = 'Entregar relatório'; }
  };
  desenharFotos();
}

// Reduz a foto (para não gastar dados nem espaço) e escreve a data/hora e a casa
async function prepararFoto(ficheiro, casa, divisao) {
  const url = URL.createObjectURL(ficheiro);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const max = 1600, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    c.drawImage(img, 0, 0, w, h);
    if (E.regras.carimbo) {
      const fs = Math.max(14, Math.round(w / 45)), pad = Math.round(fs * 0.6);
      const quando = new Date(ficheiro.lastModified || Date.now()).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const linhas = [`${quando} · ${divisao}`, casa.nome.slice(0, 70)];
      const alt = linhas.length * fs * 1.3 + pad * 2;
      c.fillStyle = 'rgba(0,0,0,.55)';
      c.fillRect(0, h - alt, w, alt);
      c.fillStyle = '#fff';
      c.font = `600 ${fs}px Inter, system-ui, sans-serif`;
      c.textBaseline = 'top';
      linhas.forEach((t, i) => c.fillText(t, pad, h - alt + pad + i * fs * 1.3, w - pad * 2));
    }
    return await new Promise((ok, mal) => cv.toBlob((b) => (b ? ok(b) : mal(new Error('Não foi possível ler a foto.'))), 'image/jpeg', 0.72));
  } finally { URL.revokeObjectURL(url); }
}

function verRelatorio(ctx) {
  const r = ctx.rel, gestor = E.eu.papel === 'gestor';
  const historico = E.rels.filter((x) => x.casa_id === ctx.casa.id && x.semana !== ctx.semana).sort((a, b) => b.semana.localeCompare(a.semana));
  const podeAgora = !r?.entregue_em && ctx.semana === semanaAtual();
  app().innerHTML = `${cabecalhoCasa(ctx)}
    ${!r?.entregue_em ? `<section class="cartao"><p>${podeAgora ? 'Este relatório ainda não foi entregue.' : 'Não foi entregue nenhum relatório nesta semana.'}</p>
      ${ctx.casa.encarregado_id ? `<p class="suave">Encarregado: ${esc(pessoaNome(ctx.casa.encarregado_id))}</p>` : '<p class="problema">Esta casa não tem encarregado.</p>'}</section>` : `
    <section class="cartao">
      <div class="linha entre"><span>Entregue por <b>${esc(pessoaNome(r.pessoa_id) || (r.pessoa_id === E.eu.id ? E.eu.nome : '—'))}</b></span><span class="suave peq">${dataHora(r.entregue_em)}</span></div>
      <div class="linha"><span class="chip ${r.estado === 'bom' ? 'ok' : r.estado === 'mau' ? 'falta' : 'atraso'}">Estado: ${ESTADOS[r.estado] || '—'}</span>
        ${r.ocupantes != null ? `<span class="chip">👥 ${pl(r.ocupantes, 'pessoa', 'pessoas')}</span>` : ''}
        ${r.visto_em ? '<span class="chip ok">✓ Visto pelo gestor</span>' : ''}</div>
      ${(r.problema || '').trim() ? `<div class="problema"><b>Problema:</b> ${esc(r.problema)}${r.problema_resolvido ? ' <span class="chip ok">resolvido</span>' : ''}</div>` : ''}
      ${r.observacoes ? `<p><b>Observações:</b> ${esc(r.observacoes)}</p>` : ''}
      ${r.comentario_gestor ? `<p class="prazo"><span><b>💬 Gestor:</b> ${esc(r.comentario_gestor)}</span></p>` : ''}
    </section>`}
    ${ctx.fotos.length ? `<section class="cartao"><h2>📷 Fotos (${ctx.fotos.length})</h2>
      ${divisoes(ctx).filter((d) => ctx.fotos.some((f) => f.divisao === d)).map((d) => `<div class="divisao"><h3>${esc(d)}</h3>
        <div class="fotos">${ctx.fotos.filter((f) => f.divisao === d).map((f) => fotoHTML(ctx, f, false)).join('')}</div></div>`).join('')}
    </section>` : ''}
    ${r?.entregue_em ? `<section class="cartao"><h2>✅ Respostas</h2><table class="tabela"><tbody>
      ${Object.entries(r.respostas || {}).map(([q, v]) => `<tr><td>${esc(q)}</td><td class="n gr">${esc(v)}</td></tr>`).join('')}
    </tbody></table></section>` : ''}
    ${gestor && r?.entregue_em ? `<section class="cartao destaque"><h2>Gestor</h2>
      <label class="campo">Comentário para o encarregado (recebe um aviso)<textarea id="comentario">${esc(r.comentario_gestor || '')}</textarea></label>
      <div class="linha">
        <button class="b p" type="button" id="gVisto">${r.visto_em ? 'Guardar' : '✓ Marcar como visto'}</button>
        ${temProblema(r) ? `<button class="b" type="button" id="gResolvido">${r.problema_resolvido ? 'Reabrir problema' : '✔ Problema resolvido'}</button>` : ''}
        <button class="b perigo" type="button" id="gReabrir">Devolver para refazer</button>
      </div></section>` : ''}
    ${gestor && podeAgora ? `<section class="cartao"><button class="b p" type="button" id="gFazer">Preencher eu este relatório</button></section>` : ''}
    ${historico.length ? `<section class="cartao"><h2>Semanas anteriores</h2><div class="lista">
      ${historico.map((h) => `<button class="item" type="button" data-sem="${h.semana}"><span class="t">${nomeSemana(h.semana)}</span>
        <span class="d">${chip(estadoCasa(ctx.casa.id, h.semana, h))}</span><span class="s">${h.estado ? ESTADOS[h.estado] : ''}${(h.problema || '').trim() ? ' · ⚠️ ' + esc(h.problema) : ''}</span></button>`).join('')}
    </div></section>` : ''}`;
  $('#voltar').onclick = voltar;
  ligarVisor(ctx);
  app().querySelectorAll('[data-sem]').forEach((b) => (b.onclick = () => abrirCasa(ctx.casa.id, b.dataset.sem)));
  $('#gFazer')?.addEventListener('click', () => formulario(ctx));
  const mudar = async (campos, txt) => {
    const { error } = await sb.from('casas_relatorios').update(campos).eq('id', r.id);
    if (error) return falhou(error);
    aviso(txt); abrirCasa(ctx.casa.id, ctx.semana);
  };
  $('#gVisto')?.addEventListener('click', () => mudar({ visto_em: r.visto_em || new Date().toISOString(), comentario_gestor: $('#comentario').value.trim() || null }, 'Guardado.'));
  $('#gResolvido')?.addEventListener('click', () => mudar({ problema_resolvido: !r.problema_resolvido }, r.problema_resolvido ? 'Problema reaberto.' : 'Problema marcado como resolvido.'));
  $('#gReabrir')?.addEventListener('click', () => {
    if (ctx.semana !== semanaAtual()) return aviso('Só é possível devolver relatórios da semana atual.', true);
    if (!confirm('Devolver o relatório ao encarregado para refazer? Volta a ficar por entregar.')) return;
    mudar({ entregue_em: null, comentario_gestor: $('#comentario').value.trim() || 'Relatório devolvido: refaça, por favor.' }, 'Relatório devolvido.');
  });
}

/* ------------------------------------------------------------ visor de fotos */
function ligarVisor(ctx) {
  app().querySelectorAll('[data-foto]').forEach((el) => (el.onclick = (ev) => {
    if (ev.target.closest('[data-apagar]')) return;
    const lista = ctx.fotos.filter((f) => !f.apagada_em);
    let i = lista.findIndex((f) => f.id === el.dataset.foto);
    const v = $('#visor'), img = v.querySelector('img');
    const mostrar = () => {
      const f = lista[i];
      img.src = ctx.urls.get(f.caminho) || f.local || '';
      v.querySelector('.visor-legenda').textContent = `${f.divisao} · ${dataHora(f.tirada_em || f.criado_em)} · ${i + 1}/${lista.length}`;
    };
    v.hidden = false; mostrar();
    v.querySelector('.visor-fechar').onclick = () => (v.hidden = true);
    v.querySelector('.visor-ant').onclick = () => { i = (i - 1 + lista.length) % lista.length; mostrar(); };
    v.querySelector('.visor-seg').onclick = () => { i = (i + 1) % lista.length; mostrar(); };
  }));
}
document.addEventListener('keydown', (e) => {
  const v = $('#visor');
  if (v.hidden) return;
  if (e.key === 'Escape') v.hidden = true;
  if (e.key === 'ArrowLeft') v.querySelector('.visor-ant').click();
  if (e.key === 'ArrowRight') v.querySelector('.visor-seg').click();
});

/* ------------------------------------------------------------ gestor: semana */
function linhasSemana(semana) {
  return E.casas.filter((c) => c.ativa).map((c) => {
    const rel = relDe(c.id, semana);
    return { c, rel, st: estadoCasa(c.id, semana, rel) };
  });
}

function cumprimento(pessoaId, semanas = 8) {
  const minhas = E.casas.filter((c) => c.ativa && c.encarregado_id === pessoaId);
  let total = 0, aTempo = 0;
  for (let k = 1; k <= semanas; k++) {
    const s = somaDias(semanaAtual(), -7 * k);
    for (const c of minhas) {
      if (c.criado_em && c.criado_em.slice(0, 10) > somaDias(s, 6)) continue;
      total++;
      if (estadoCasa(c.id, s).k === 'ok') aTempo++;
    }
  }
  return total ? Math.round((aTempo / total) * 100) : null;
}

function ecraSemana() {
  const s = E.semana, f = E.filtro;
  const linhas = linhasSemana(s);
  const conta = (k) => linhas.filter((l) => l.st.k === k).length;
  const prob = linhas.filter((l) => temProblema(l.rel)).length;
  const semEnc = linhas.filter((l) => !l.c.encarregado_id).length;
  const n = linhas.length || 1;
  const filtradas = linhas.filter(({ c, st, rel }) => {
    if (f.texto && !`${c.nome} ${c.morada} ${c.obra} ${c.cc}`.toLowerCase().includes(f.texto.toLowerCase())) return false;
    if (f.pais && c.pais !== f.pais) return false;
    if (f.pessoa && (f.pessoa === '-' ? c.encarregado_id : c.encarregado_id !== f.pessoa)) return false;
    if (f.estado === 'problema') return temProblema(rel);
    if (f.estado === 'porver') return rel?.entregue_em && !rel.visto_em;
    if (f.estado === 'aberto') return ['pendente', 'curso'].includes(st.k);
    if (f.estado && st.k !== f.estado) return false;
    return true;
  });
  const ordem = { falta: 0, pendente: 1, curso: 2, atraso: 3, ok: 4 };
  filtradas.sort((a, b) => ordem[a.st.k] - ordem[b.st.k] || (a.c.nome).localeCompare(b.c.nome));
  const atual = s === semanaAtual();
  const encarregados = E.pessoas.filter((p) => p.ativo && E.casas.some((c) => c.ativa && c.encarregado_id === p.id));
  const kpi = (k, num, txt, cls = '') => `<button type="button" class="kpi ${cls} ${f.estado === k ? 'sel' : ''}" data-k="${k}"><span class="num-grande">${num}</span><span class="suave peq">${txt}</span></button>`;

  app().innerHTML = `
    <section class="linha entre">
      <div><h1>Semana de ${nomeSemana(s)}</h1><p class="suave">Prazo: ${DIAS[E.regras.dia_limite]} ${dm(somaDias(s, E.regras.dia_limite - 1))} às ${horaLimite()}${atual && new Date() < prazoDe(s) ? ` · faltam ${falta(prazoDe(s) - new Date())}` : ''}</p></div>
      <div class="semana-nav"><button class="b" type="button" id="sAnt" aria-label="Semana anterior">‹</button>
        ${atual ? '' : '<button class="b" type="button" id="sHoje">Esta semana</button>'}
        <button class="b" type="button" id="sSeg" aria-label="Semana seguinte" ${atual ? 'disabled' : ''}>›</button></div>
    </section>
    <div class="barra" title="Entregues a tempo / com atraso"><span class="ok" style="width:${(conta('ok') / n) * 100}%"></span><span class="atraso" style="width:${(conta('atraso') / n) * 100}%"></span></div>
    <section class="kpis">
      ${kpi('ok', conta('ok'), 'Entregues a tempo', 'ok')}
      ${kpi('atraso', conta('atraso'), 'Com atraso', 'atraso')}
      ${new Date() > prazoDe(s) ? kpi('falta', conta('falta'), 'Em falta', 'falta') : kpi('aberto', conta('pendente') + conta('curso'), 'Por entregar')}
      ${kpi('problema', prob, '⚠️ Com problemas', prob ? 'falta' : '')}
      ${kpi('porver', linhas.filter((l) => l.rel?.entregue_em && !l.rel.visto_em).length, 'Por ver')}
    </section>
    ${semEnc ? `<p class="problema">${pl(semEnc, 'casa ativa não tem', 'casas ativas não têm')} encarregado — <a href="#" id="irCasas">atribuir em Casas</a>.</p>` : ''}
    <section class="filtros">
      <input type="search" id="fTexto" placeholder="Procurar casa, morada, obra…" value="${esc(f.texto)}">
      <select id="fPais"><option value="">Todos os países</option>${[...new Set(E.casas.map((c) => c.pais))].map((p) => `<option value="${esc(p)}" ${f.pais === p ? 'selected' : ''}>${esc(PAISES[p] || p)}</option>`).join('')}</select>
      <select id="fPessoa"><option value="">Todos os encarregados</option><option value="-" ${f.pessoa === '-' ? 'selected' : ''}>Sem encarregado</option>${E.pessoas.filter((p) => p.ativo).map((p) => `<option value="${p.id}" ${f.pessoa === p.id ? 'selected' : ''}>${esc(p.nome)}</option>`).join('')}</select>
      ${f.estado ? '<button class="b peq" type="button" id="fLimpar">✕ Limpar filtro</button>' : ''}
    </section>
    <section class="lista">
      ${filtradas.map(({ c, rel, st }) => `<button class="item" type="button" data-casa="${c.id}">
        <span class="t">${temProblema(rel) && !rel.problema_resolvido ? '⚠️ ' : ''}${esc(c.nome)}</span>
        <span class="d">${chip(st)}${rel?.entregue_em && !rel.visto_em ? '<span class="chip curso">por ver</span>' : ''}</span>
        <span class="s">${esc(pessoaNome(c.encarregado_id) || 'Sem encarregado')} · ${esc(c.obra || '')}</span></button>`).join('') || '<p class="suave">Nenhuma casa com estes filtros.</p>'}
    </section>
    ${encarregados.length ? `<section class="cartao"><h2>Cumprimento por encarregado</h2><div class="rolar"><table class="tabela">
      <thead><tr><th>Encarregado</th><th class="n">Esta semana</th><th class="n">Em falta</th><th class="n">A tempo (8 sem.)</th><th></th></tr></thead><tbody>
      ${encarregados.map((p) => {
        const ls = linhas.filter((l) => l.c.encarregado_id === p.id), cu = cumprimento(p.id);
        const feitas = ls.filter((l) => ['ok', 'atraso'].includes(l.st.k)).length, emFalta = ls.length - feitas;
        return `<tr><td>${esc(p.nome)}</td><td class="n">${feitas}/${ls.length}</td><td class="n">${emFalta ? `<b style="color:var(--mal)">${emFalta}</b>` : '0'}</td>
          <td class="n">${cu == null ? '—' : `<b style="color:${cu >= 90 ? 'var(--ok)' : cu >= 70 ? 'var(--atr)' : 'var(--mal)'}">${cu}%</b>`}</td>
          <td class="n">${atual && emFalta ? `<button class="b peq" type="button" data-lembrar="${p.id}">🔔 Lembrar</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div></section>` : ''}`;

  const mudarSemana = async (nova) => { E.semana = nova; app().innerHTML = '<p class="a-carregar">A carregar…</p>'; try { await carregarRelatorios(nova); } catch (e) { falhou(e); } render(); };
  $('#sAnt').onclick = () => mudarSemana(somaDias(s, -7));
  $('#sSeg').onclick = () => mudarSemana(somaDias(s, 7));
  $('#sHoje')?.addEventListener('click', () => mudarSemana(semanaAtual()));
  $('#irCasas')?.addEventListener('click', (e) => { e.preventDefault(); E.aba = 'casas'; E.filtro.pessoa = '-'; render(); });
  app().querySelectorAll('.kpi').forEach((b) => (b.onclick = () => { f.estado = f.estado === b.dataset.k ? '' : b.dataset.k; render(); }));
  $('#fLimpar')?.addEventListener('click', () => { f.estado = ''; render(); });
  $('#fTexto').oninput = (e) => { f.texto = e.target.value; const pos = e.target.selectionStart; render(); const i = $('#fTexto'); i.focus(); i.setSelectionRange(pos, pos); };
  $('#fPais').onchange = (e) => { f.pais = e.target.value; render(); };
  $('#fPessoa').onchange = (e) => { f.pessoa = e.target.value; render(); };
  app().querySelectorAll('[data-casa]').forEach((b) => (b.onclick = () => abrirCasa(b.dataset.casa, s)));
  app().querySelectorAll('[data-lembrar]').forEach((b) => (b.onclick = () => lembrar(b.dataset.lembrar)));
}

async function lembrar(pessoaId) {
  const p = E.pessoas.find((x) => x.id === pessoaId);
  const { data, error } = await sb.functions.invoke(NUVEM.funcao, { body: { acao: 'lembrar', pessoa_id: pessoaId } });
  if (error) return falhou(new Error('Não foi possível enviar o aviso (a função dos avisos está publicada?).'));
  if (data.enviadas) return aviso(`🔔 Aviso enviado a ${p.nome}.`);
  const pend = E.casas.filter((c) => c.ativa && c.encarregado_id === pessoaId && !relDe(c.id, semanaAtual())?.entregue_em).map((c) => c.nome);
  if (p.telefone && confirm(`${data.aviso || 'Aviso não entregue.'}\n\nEnviar mensagem por WhatsApp?`)) {
    whatsapp(p.telefone, `Olá ${p.nome.split(' ')[0]}, faltam as fotos desta semana de: ${pend.join(', ')}. Prazo: ${DIAS[E.regras.dia_limite]} às ${horaLimite()}. ${location.origin + location.pathname}`);
  } else if (data.aviso) aviso(data.aviso, true);
}
function whatsapp(tel, txt) {
  let n = String(tel).replace(/\D/g, '');
  if (n.length === 9) n = '351' + n;
  window.open(`https://wa.me/${n}?text=${encodeURIComponent(txt)}`, '_blank');
}

/* ------------------------------------------------------------ gestor: problemas */
async function ecraProblemas() {
  app().innerHTML = '<p class="a-carregar">A carregar…</p>';
  let lst;
  try {
    lst = await todos(() => sb.from('casas_relatorios').select('id,casa_id,semana,pessoa_id,estado,problema,entregue_em,problema_resolvido')
      .not('entregue_em', 'is', null).eq('problema_resolvido', false).order('semana', { ascending: false }));
  } catch (e) { return falhou(e); }
  lst = lst.filter(temProblema);
  // Só o mais recente de cada casa
  const vistas = new Set();
  const atuais = lst.filter((r) => (vistas.has(r.casa_id) ? false : vistas.add(r.casa_id)));
  app().innerHTML = `<section><h1>⚠️ Problemas por resolver</h1><p class="suave">Relatórios com estado “atenção”/“mau” ou com um problema escrito. Abra e marque como resolvido.</p></section>
    <section class="lista">${atuais.map((r) => {
      const c = casaDe(r.casa_id) || { nome: '?' };
      return `<button class="item" type="button" data-rel="${r.id}"><span class="t">${r.estado === 'mau' ? '🔴' : '⚠️'} ${esc(c.nome)}</span>
        <span class="d"><span class="chip ${r.estado === 'mau' ? 'falta' : 'atraso'}">${ESTADOS[r.estado]}</span><span class="suave peq">${nomeSemana(r.semana)}</span></span>
        <span class="s">${esc((r.problema || '').trim() || 'Sem descrição')} · ${esc(pessoaNome(r.pessoa_id))}</span></button>`;
    }).join('') || '<div class="cartao"><p>✅ Não há problemas por resolver.</p></div>'}</section>`;
  app().querySelectorAll('[data-rel]').forEach((b) => (b.onclick = () => abrirRelatorioPorId(b.dataset.rel)));
}

/* ------------------------------------------------------------ gestor: casas */
function ecraCasas() {
  const f = E.filtro;
  const lst = E.casas.filter((c) => {
    if (f.texto && !`${c.nome} ${c.morada} ${c.obra} ${c.cc}`.toLowerCase().includes(f.texto.toLowerCase())) return false;
    if (f.pais && c.pais !== f.pais) return false;
    if (f.pessoa && (f.pessoa === '-' ? c.encarregado_id : c.encarregado_id !== f.pessoa)) return false;
    return true;
  });
  const opcoesPessoa = (sel) => `<option value="">— Sem encarregado —</option>` + E.pessoas.filter((p) => p.ativo).map((p) => `<option value="${p.id}" ${sel === p.id ? 'selected' : ''}>${esc(p.nome)}</option>`).join('');
  app().innerHTML = `
    <section class="linha entre"><div><h1>🏠 Casas</h1><p class="suave">${E.casas.filter((c) => c.ativa).length} ativas · ${E.casas.filter((c) => !c.ativa).length} desativadas</p></div>
      <button class="b p" type="button" id="novaCasa">+ Nova casa</button></section>
    <section class="filtros">
      <input type="search" id="fTexto" placeholder="Procurar…" value="${esc(f.texto)}">
      <select id="fPais"><option value="">Todos os países</option>${[...new Set(E.casas.map((c) => c.pais))].map((p) => `<option value="${esc(p)}" ${f.pais === p ? 'selected' : ''}>${esc(PAISES[p] || p)}</option>`).join('')}</select>
      <select id="fPessoa"><option value="">Todos</option><option value="-" ${f.pessoa === '-' ? 'selected' : ''}>Sem encarregado</option>${E.pessoas.filter((p) => p.ativo).map((p) => `<option value="${p.id}" ${f.pessoa === p.id ? 'selected' : ''}>${esc(p.nome)}</option>`).join('')}</select>
    </section>
    <p class="suave peq">Marque várias casas (☐) para atribuir o mesmo encarregado de uma vez.</p>
    <section class="cartao rolar" style="padding:8px 12px"><table class="tabela"><thead><tr><th><input type="checkbox" id="todas" aria-label="Marcar todas"></th><th>Casa</th><th>Encarregado</th><th></th></tr></thead><tbody>
      ${lst.map((c) => `<tr style="${c.ativa ? '' : 'opacity:.5'}"><td><input type="checkbox" data-sel="${c.id}" ${E.selecionadas.has(c.id) ? 'checked' : ''}></td>
        <td><b>${esc(c.nome)}</b><br><span class="suave peq">${esc(c.pais)} · ${esc(c.obra || '')}${c.ativa ? '' : ' · desativada'}</span></td>
        <td><select data-enc="${c.id}" style="min-width:120px;max-width:44vw">${opcoesPessoa(c.encarregado_id)}</select></td>
        <td class="n"><button class="b peq" type="button" data-editar="${c.id}" aria-label="Editar">✏️</button></td></tr>`).join('')}
    </tbody></table></section>
    <div class="barra-baixo" id="barraSel" ${E.selecionadas.size ? '' : 'hidden'}><div>
      <b id="nSel">${E.selecionadas.size}</b> marcadas
      <select id="encVarias">${opcoesPessoa('')}</select>
      <button class="b p" type="button" id="atribuir">Atribuir</button></div></div>`;
  $('#fTexto').oninput = (e) => { f.texto = e.target.value; const pos = e.target.selectionStart; render(); const i = $('#fTexto'); i.focus(); i.setSelectionRange(pos, pos); };
  $('#fPais').onchange = (e) => { f.pais = e.target.value; render(); };
  $('#fPessoa').onchange = (e) => { f.pessoa = e.target.value; render(); };
  $('#novaCasa').onclick = () => editarCasa();
  app().querySelectorAll('[data-editar]').forEach((b) => (b.onclick = () => editarCasa(casaDe(b.dataset.editar))));
  app().querySelectorAll('[data-enc]').forEach((s) => (s.onchange = async () => {
    const { error } = await sb.from('casas').update({ encarregado_id: s.value || null }).eq('id', s.dataset.enc);
    if (error) return falhou(error);
    casaDe(s.dataset.enc).encarregado_id = s.value || null; aviso('Encarregado atualizado.');
  }));
  const contar = () => { $('#nSel').textContent = E.selecionadas.size; $('#barraSel').hidden = !E.selecionadas.size; };
  app().querySelectorAll('[data-sel]').forEach((c) => (c.onchange = () => { c.checked ? E.selecionadas.add(c.dataset.sel) : E.selecionadas.delete(c.dataset.sel); contar(); }));
  $('#todas').onchange = (e) => { lst.forEach((c) => (e.target.checked ? E.selecionadas.add(c.id) : E.selecionadas.delete(c.id))); render(); };
  $('#atribuir').onclick = async () => {
    const ids = [...E.selecionadas], enc = $('#encVarias').value || null;
    const { error } = await sb.from('casas').update({ encarregado_id: enc }).in('id', ids);
    if (error) return falhou(error);
    ids.forEach((id) => (casaDe(id).encarregado_id = enc));
    E.selecionadas.clear(); aviso(`${pl(ids.length, 'casa atualizada', 'casas atualizadas')}.`); render();
  };
}

function editarCasa(c = {}) {
  janela(`<form id="fCasa"><h2>${c.id ? 'Editar casa' : 'Nova casa'}</h2>
    <label class="campo">Nome (como a equipa conhece a casa)<input name="nome" required value="${esc(c.nome || '')}"></label>
    <label class="campo">Morada<input name="morada" value="${esc(c.morada || '')}"></label>
    <div class="grelha2">
      <label class="campo">País<select name="pais">${Object.entries(PAISES).map(([k, t]) => `<option value="${esc(k)}" ${(c.pais || 'PT') === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label class="campo">Centro de custo (CC)<input name="cc" value="${esc(c.cc || '')}"></label>
    </div>
    <label class="campo">Obra(s)<input name="obra" value="${esc(c.obra || '')}"></label>
    <label class="campo">Notas (só o gestor vê)<textarea name="notas">${esc(c.notas || '')}</textarea></label>
    <label class="linha"><input type="checkbox" name="ativa" ${c.ativa === false ? '' : 'checked'}> Casa ativa (desmarque quando a casa for entregue)</label>
    <div class="linha"><button class="b p" type="submit">Guardar</button><button class="b" type="button" data-fechar>Cancelar</button></div></form>`);
  $('#fCasa').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const d = { nome: f.get('nome').trim(), morada: f.get('morada').trim(), pais: f.get('pais'), cc: f.get('cc').trim(), obra: f.get('obra').trim(), notas: f.get('notas').trim(), ativa: !!f.get('ativa') };
    const q = c.id ? sb.from('casas').update(d).eq('id', c.id).select().single() : sb.from('casas').insert(d).select().single();
    const { data, error } = await q;
    if (error) return falhou(error);
    if (c.id) Object.assign(c, data); else E.casas.push(data);
    fecharJanela(); aviso('Casa guardada.'); render();
  };
}

/* ------------------------------------------------------------ gestor: pessoas */
function ecraPessoas() {
  app().innerHTML = `
    <section class="linha entre"><div><h1>👷 Pessoas</h1><p class="suave">Encarregados que fotografam as casas, e gestores.</p></div>
      <button class="b p" type="button" id="novaPessoa">+ Adicionar</button></section>
    <section class="lista">${E.pessoas.map((p) => {
      const n = E.casas.filter((c) => c.ativa && c.encarregado_id === p.id).length, cu = cumprimento(p.id);
      return `<div class="cartao" style="${p.ativo ? '' : 'opacity:.55'}">
        <div class="linha entre"><div><h3>${esc(p.nome)} ${p.papel === 'gestor' ? '<span class="chip curso">gestor</span>' : ''} ${p.ativo ? '' : '<span class="chip">desativado</span>'}</h3>
          <p class="suave peq">${esc(p.email || 'sem email')}${p.telefone ? ' · ' + esc(p.telefone) : ''}</p></div>
          <div class="linha">${p.user_id ? '<span class="chip ok">tem conta</span>' : '<span class="chip atraso">sem conta</span>'}</div></div>
        <p class="peq">${pl(n, 'casa', 'casas')}${cu != null ? ` · ${cu}% a tempo nas últimas 8 semanas` : ''}</p>
        <div class="linha">
          <button class="b peq" type="button" data-editar="${p.id}">✏️ Editar</button>
          ${!p.user_id && p.ativo ? `<button class="b peq p" type="button" data-link="${p.id}">🔗 Enviar link</button>` : ''}
          ${p.user_id && (p.telefone || p.email) ? `<button class="b peq p" type="button" data-instr="${p.id}">📨 Enviar instruções</button>` : ''}
          ${p.user_id && n ? `<button class="b peq" type="button" data-lembrar="${p.id}">🔔 Lembrar</button>` : ''}
        </div></div>`;
    }).join('')}</section>`;
  $('#novaPessoa').onclick = () => editarPessoa();
  app().querySelectorAll('[data-editar]').forEach((b) => (b.onclick = () => editarPessoa(E.pessoas.find((p) => p.id === b.dataset.editar))));
  app().querySelectorAll('[data-link]').forEach((b) => (b.onclick = () => enviarLink(E.pessoas.find((p) => p.id === b.dataset.link))));
  app().querySelectorAll('[data-lembrar]').forEach((b) => (b.onclick = () => lembrar(b.dataset.lembrar)));
  app().querySelectorAll('[data-instr]').forEach((b) => (b.onclick = () => enviarInstrucoes(E.pessoas.find((x) => x.id === b.dataset.instr))));
}

function editarPessoa(p = {}) {
  janela(`<form id="fPessoa"><h2>${p.id ? 'Editar pessoa' : 'Adicionar pessoa'}</h2>
    <label class="campo">Nome<input name="nome" required value="${esc(p.nome || '')}"></label>
    <label class="campo">Email (opcional: se ficar vazio, a pessoa escreve o seu ao abrir o link)<input type="email" name="email" value="${esc(p.email || '')}" ${p.user_id ? 'readonly' : ''}></label>
    <label class="campo">Telemóvel (WhatsApp)<input type="tel" name="telefone" value="${esc(p.telefone || '')}" placeholder="912 345 678"></label>
    <label class="campo">Papel<select name="papel">
      <option value="encarregado" ${p.papel !== 'gestor' ? 'selected' : ''}>Encarregado — tira as fotos das suas casas</option>
      <option value="gestor" ${p.papel === 'gestor' ? 'selected' : ''}>Gestor — vê e gere tudo</option></select></label>
    ${p.id && p.id !== E.eu.id ? `<label class="linha"><input type="checkbox" name="ativo" ${p.ativo === false ? '' : 'checked'}> Ativo (desmarque se saiu da empresa: deixa de entrar e as casas ficam sem encarregado)</label>` : ''}
    <div class="linha"><button class="b p" type="submit">Guardar</button><button class="b" type="button" data-fechar>Cancelar</button></div></form>`);
  $('#fPessoa').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const d = { nome: f.get('nome').trim(), email: f.get('email').trim().toLowerCase() || null, telefone: f.get('telefone').trim() || null, papel: f.get('papel') };
    if (p.id && p.id !== E.eu.id) d.ativo = !!f.get('ativo');
    if (p.id === E.eu.id && d.papel !== 'gestor') return aviso('Não pode tirar a si próprio o papel de gestor.', true);
    const { data, error } = p.id ? await sb.from('casas_pessoas').update(d).eq('id', p.id).select().single() : await sb.from('casas_pessoas').insert(d).select().single();
    if (error) return falhou(error.code === '23505' ? new Error('Já existe uma pessoa com este email.') : error);
    if (d.ativo === false) {
      await sb.from('casas').update({ encarregado_id: null }).eq('encarregado_id', p.id);
      E.casas.forEach((c) => c.encarregado_id === p.id && (c.encarregado_id = null));
    }
    if (p.id) Object.assign(p, data); else E.pessoas.push(data);
    fecharJanela(); aviso('Guardado.'); render();
    if (!p.id && data.papel === 'encarregado') enviarLink(data);
  };
}

function criarConta(p) {
  const sugestao = 'Casa' + Math.floor(1000 + Math.random() * 9000);
  janela(`<form id="fConta"><h2>Criar conta de ${esc(p.nome)}</h2>
    <p class="suave">Email: <b>${esc(p.email)}</b>. A seguir pode enviar as instruções por WhatsApp, SMS ou email.</p>
    <label class="campo">Palavra-passe inicial<input name="senha" minlength="6" required value="${sugestao}"></label>
    <div class="linha"><button class="b p" type="submit">Criar conta</button><button class="b" type="button" data-fechar>Cancelar</button></div></form>`);
  $('#fConta').onsubmit = async (ev) => {
    ev.preventDefault();
    const senha = new FormData(ev.target).get('senha');
    const { data, error } = await sb.functions.invoke(NUVEM.funcao, { body: { acao: 'criar_conta', pessoa_id: p.id, senha } });
    let erro = data?.erro;
    if (error && !erro) { try { erro = (await error.context.json()).erro; } catch (e) { erro = 'Não foi possível criar a conta (a função dos avisos está publicada?).'; } }
    if (erro) return aviso(erro, true);
    fecharJanela();
    await carregar(); render();
    aviso(data.jaExistia ? 'Este email já tinha conta: fica ligado quando entrar.' : 'Conta criada.');
    enviarInstrucoes(E.pessoas.find((x) => x.id === p.id) || p, data.jaExistia ? null : senha);
  };
}

// Mensagem com o link e os passos para entrar (enviada pelo telemóvel do gestor)
function mensagemEntrada(p, senha) {
  const link = location.origin + location.pathname, g = E.regras;
  return `Olá ${p.nome.split(' ')[0]}!
A partir de agora, todas as semanas tem de enviar as fotos das casas pelas quais é responsável, neste site:
${link}

COMO ENTRAR
1. Abra o link acima no telemóvel.
2. Email: ${p.email}
3. Palavra-passe: ${senha || 'a que lhe foi dada (se não souber, carregue em "Esqueci-me da palavra-passe" e siga o email que recebe)'}
4. Carregue em "Entrar" (não em "Criar conta").

PÔR NO ECRÃ DO TELEMÓVEL
• iPhone: no Safari, carregue em Partilhar (quadrado com seta) → "Adicionar ao ecrã principal". Abra sempre pelo ícone.
• Android: no Chrome, carregue nos 3 pontos → "Adicionar ao ecrã principal".
Depois carregue em "Ligar avisos" para receber os lembretes.

TODAS AS SEMANAS
• Prazo: ${DIAS[g.dia_limite]} às ${horaLimite()}.
• Em cada casa: fotos de ${g.divisoes.join(', ')} (mínimo ${g.min_fotos} fotos), responder às perguntas e carregar em "Entregar relatório".
• Escreva qualquer problema da casa: o gestor recebe logo um aviso.

Obrigado!`;
}

function mensagemConvite(p, link) {
  const g = E.regras;
  return `Olá ${p.nome.split(' ')[0]}!
A partir de agora, todas as semanas tem de enviar as fotos das casas pelas quais é responsável.

1. Abra este link pessoal no telemóvel (é só para si, não o partilhe):
${link}
2. Escolha a sua palavra-passe e carregue em "Criar a minha conta". Fica logo dentro.
3. Ponha o site no ecrã do telemóvel:
 • iPhone: no Safari, Partilhar (quadrado com seta) → "Adicionar ao ecrã principal".
 • Android: no Chrome, 3 pontos → "Adicionar ao ecrã principal".
4. Abra pelo ícone e carregue em "Ligar avisos" para receber os lembretes.
Das próximas vezes entra com o seu email e a palavra-passe que escolheu.

TODAS AS SEMANAS
• Prazo: ${DIAS[g.dia_limite]} às ${horaLimite()}.
• Em cada casa: fotos de ${g.divisoes.join(', ')} (mínimo ${g.min_fotos}), responder às perguntas e carregar em "Entregar relatório".
• Escreva qualquer problema da casa: o gestor recebe logo um aviso.

Obrigado!`;
}

async function enviarLink(p) {
  let token = p.convite;
  if (!token) {
    const a = new Uint8Array(24); crypto.getRandomValues(a);
    token = Array.from(a, (x) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[x % 56]).join('');
    const { error } = await sb.from('casas_pessoas').update({ convite: token }).eq('id', p.id);
    if (error) return falhou(error);
    p.convite = token;
  }
  enviarInstrucoes(p, null, mensagemConvite(p, `${location.origin + location.pathname}#convite=${token}`));
}

function enviarInstrucoes(p, senha = null, texto = null) {
  const txt = texto || mensagemEntrada(p, senha);
  let n = String(p.telefone || '').replace(/\D/g, '');
  if (n.length === 9) n = '351' + n;
  const assunto = 'Casas das Obras — como entrar no site das fotos';
  janela(`<div><div><h2>📨 Enviar instruções a ${esc(p.nome)}</h2>
    <p class="suave">A mensagem abre já escrita na app do seu telemóvel; só tem de carregar em enviar.${texto ? ' Inclui o link pessoal: a pessoa escolhe a palavra-passe sozinha.' : ''}</p>
    <textarea id="txtInstr" rows="10">${esc(txt)}</textarea>
    <div class="linha">
      ${n ? `<a class="b p" target="_blank" rel="noopener" href="https://wa.me/${n}?text=${encodeURIComponent(txt)}">💬 WhatsApp</a>
             <a class="b" href="sms:+${n}?&body=${encodeURIComponent(txt)}">📱 SMS</a>` : ''}
      ${p.email ? `<a class="b" href="mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent(assunto)}&body=${encodeURIComponent(txt)}">📧 Email</a>` : ''}
      <button class="b" type="button" id="copiarInstr">📋 Copiar</button>
      <button class="b" type="button" data-fechar>Fechar</button>
    </div></div></div>`);
  // se o gestor alterar o texto, os botões usam o texto alterado
  const atualizar = () => {
    const t = $('#txtInstr').value;
    $('#janelaCorpo').querySelectorAll('a.b').forEach((a) => {
      if (a.href.startsWith('https://wa.me/')) a.href = `https://wa.me/${n}?text=${encodeURIComponent(t)}`;
      else if (a.href.startsWith('sms:')) a.href = `sms:+${n}?&body=${encodeURIComponent(t)}`;
      else if (a.href.startsWith('mailto:')) a.href = `mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent(assunto)}&body=${encodeURIComponent(t)}`;
    });
  };
  $('#txtInstr').oninput = atualizar;
  $('#copiarInstr').onclick = async () => {
    try { await navigator.clipboard.writeText($('#txtInstr').value); aviso('Mensagem copiada.'); } catch (e) { $('#txtInstr').select(); }
  };
}

/* ------------------------------------------------------------ gestor: regras */
function ecraRegras() {
  const g = E.regras;
  app().innerHTML = `<form class="cartao" id="fRegras"><h1>📋 Regras</h1>
    <p class="suave">O que os encarregados têm de cumprir todas as semanas. O servidor recusa relatórios que não cumpram.</p>
    <div class="grelha2">
      <label class="campo">Dia limite da semana<select name="dia_limite">${DIAS.slice(1).map((d, i) => `<option value="${i + 1}" ${g.dia_limite === i + 1 ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
      <label class="campo">Hora limite<input type="time" name="hora_limite" value="${horaLimite()}" required></label>
      <label class="campo">Mínimo de fotos por casa<input type="number" name="min_fotos" min="1" max="40" value="${g.min_fotos}" required></label>
      <label class="campo">Guardar as fotos durante (semanas)<input type="number" name="guardar_semanas" min="2" max="520" value="${g.guardar_semanas}" required></label>
    </div>
    <label class="campo">Divisões obrigatórias (uma por linha)<textarea name="divisoes" rows="6">${esc(g.divisoes.join('\n'))}</textarea></label>
    <label class="campo">Perguntas obrigatórias, resposta Sim/Não (uma por linha)<textarea name="perguntas" rows="6">${esc(g.perguntas.join('\n'))}</textarea></label>
    <label class="linha"><input type="checkbox" name="so_fotos_recentes" ${g.so_fotos_recentes ? 'checked' : ''}> Só aceitar fotos tiradas na própria semana</label>
    <label class="linha"><input type="checkbox" name="carimbo" ${g.carimbo ? 'checked' : ''}> Escrever data, hora e nome da casa em cada foto</label>
    <label class="campo">Texto das regras (aparece aos encarregados)<textarea name="texto" rows="6">${esc(g.texto)}</textarea></label>
    <div class="cartao" style="background:var(--campo)"><h3>🔔 Avisos automáticos</h3><ul class="regras peq">
      <li>Segunda-feira às 8h: “nova semana” com a lista das casas.</li>
      <li>Véspera do prazo às 18h, no dia às 9h e 2 horas antes: lembrete a quem ainda tem casas por entregar.</li>
      <li>Quando o prazo termina: aviso a quem falhou e resumo para o gestor.</li>
      <li>Depois do prazo, todos os dias às 9h até domingo: aviso de atraso.</li>
      <li>Relatório com problema ou casa em mau estado: aviso imediato ao gestor.</li></ul></div>
    <button class="b p grande" type="submit">Guardar regras</button></form>`;
  $('#fRegras').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const linhas = (k) => f.get(k).split('\n').map((x) => x.trim()).filter(Boolean);
    const d = {
      dia_limite: Number(f.get('dia_limite')), hora_limite: f.get('hora_limite'), min_fotos: Number(f.get('min_fotos')),
      guardar_semanas: Number(f.get('guardar_semanas')), divisoes: linhas('divisoes'), perguntas: linhas('perguntas'),
      so_fotos_recentes: !!f.get('so_fotos_recentes'), carimbo: !!f.get('carimbo'), texto: f.get('texto').trim(), atualizado_em: new Date().toISOString(),
    };
    if (d.divisoes.length > d.min_fotos) return aviso(`Há ${d.divisoes.length} divisões obrigatórias: o mínimo de fotos tem de ser pelo menos ${d.divisoes.length}.`, true);
    const { data, error } = await sb.from('casas_regras').update(d).eq('id', 1).select().single();
    if (error) return falhou(error);
    E.regras = data; aviso('Regras guardadas.');
  };
}

/* ------------------------------------------------------------ conta e avisos */
const avisosDesligados = () => 'Notification' in window && 'PushManager' in window && Notification.permission !== 'granted';

function ecraConta() {
  const iOSsemApp = /iPhone|iPad/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches;
  janela(`<div><div><h2>${esc(E.eu.nome)}</h2><p class="suave">${esc(E.sessao?.user?.email || '')} · ${E.eu.papel === 'gestor' ? 'Gestor' : 'Encarregado'}</p>
    <div class="cartao"><h3>🔔 Avisos neste telemóvel</h3>
      ${!('PushManager' in window) ? `<p class="suave">${iOSsemApp ? 'No iPhone: Safari → Partilhar → <b>Adicionar ao ecrã principal</b>, abra pelo ícone e volte aqui.' : 'Este navegador não recebe avisos.'}</p>`
      : `<p class="suave">${Notification.permission === 'granted' ? 'Ligados.' : Notification.permission === 'denied' ? 'Bloqueados nas definições do telemóvel.' : 'Desligados.'}</p>
        <button class="b p" type="button" id="cAvisos">${Notification.permission === 'granted' ? 'Enviar aviso de teste' : 'Ligar avisos'}</button>`}
    </div>
    <div class="linha"><button class="b" type="button" id="cSenha">Mudar palavra-passe</button><button class="b perigo" type="button" id="cSair">Sair</button>
      <button class="b" type="button" data-fechar>Fechar</button></div></div></div>`);
  $('#cAvisos')?.addEventListener('click', ligarAvisos);
  $('#cSenha').onclick = () => { fecharJanela(); novaSenha(); };
  $('#cSair').onclick = async () => { fecharJanela(); await sb.auth.signOut(); };
}

async function ligarAvisos() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('No iPhone, adicione primeiro o site ao ecrã principal e abra pelo ícone.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Os avisos não foram autorizados.');
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const { data, error } = await sb.functions.invoke(NUVEM.funcao, { body: { acao: 'iniciar', funcao: NUVEM.funcao } });
    if (error || !data?.publica) throw new Error('O serviço de avisos ainda não está publicado no Supabase.');
    const chave = Uint8Array.from(atob(data.publica.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (data.publica.length % 4)) % 4)), (c) => c.charCodeAt(0));
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chave });
    const j = sub.toJSON();
    const { error: e2 } = await sb.from('casas_push_subs').upsert({ endpoint: j.endpoint, user_id: E.sessao.user.id, p256dh: j.keys.p256dh, auth: j.keys.auth });
    if (e2) throw e2;
    const t = await sb.functions.invoke(NUVEM.funcao, { body: { acao: 'teste' } });
    aviso(t.data?.enviadas ? '🔔 Avisos ligados! Deve ter recebido um aviso de teste.' : 'Avisos ligados.');
    fecharJanela();
    if (E.eu.papel !== 'gestor') ecraEncarregado();
  } catch (e) { falhou(e); }
}

/* ------------------------------------------------------------ janelas */
function janela(html) {
  const j = $('#janela');
  $('#janelaCorpo').innerHTML = html;
  $('#janelaCorpo').querySelectorAll('[data-fechar]').forEach((b) => (b.onclick = fecharJanela));
  if (!j.open) j.showModal();
}
function fecharJanela() { const j = $('#janela'); if (j.open) j.close(); }

arrancar().catch(falhou);
