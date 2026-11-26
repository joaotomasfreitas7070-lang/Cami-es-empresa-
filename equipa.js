'use strict';
/* =====================================================================
   Equipa: empresa, pessoas, papéis e permissões, férias e folgas,
   problemas das carrinhas. Sincroniza registo a registo com a tabela
   "registos" do Supabase (várias pessoas podem trabalhar ao mesmo tempo).
   As regras de quem vê/altera o quê estão também na base de dados
   (supabase/equipa.sql), por isso não dependem só deste ecrã.
   ===================================================================== */

const PAPEIS = {
  patrao: 'Patrão', rh: 'Recursos Humanos', contabilidade: 'Contabilidade', logistica: 'Logística / Tráfego',
  condutor: 'Condutor', mecanico: 'Mecânico', marketing: 'Marketing',
};
const PERMISSOES = [
  ['financeiro', 'Ver resultados, lucro, custos fixos, parâmetros e todas as despesas'],
  ['precos', 'Ver e definir preços, receitas, pagamentos e faturas das viagens'],
  ['viagens_registar', 'Registar as suas viagens'],
  ['viagens_ver_todas', 'Ver as viagens de todos'],
  ['viagens_editar_todas', 'Alterar as viagens de todos'],
  ['abastecimentos_registar', 'Registar abastecimentos'],
  ['abastecimentos_todos', 'Ver e alterar os abastecimentos de todos'],
  ['despesas_registar', 'Registar despesas'],
  ['carrinhas_gerir', 'Gerir as carrinhas (datas, revisões)'],
  ['ocorrencias_gerir', 'Tratar os problemas das carrinhas'],
  ['ferias_aprovar', 'Aprovar férias e folgas'],
  ['pessoas_gerir', 'Adicionar, alterar e remover pessoas'],
  ['avisos_aniversarios', 'Ser avisado dos aniversários (1 dia antes e no dia)'],
  ['avisos_ferias', 'Ser avisado das férias da equipa (1 semana antes)'],
  ['salarios', 'Ver e processar salários (fichas, recibos, mapa) — dados sensíveis'],
  ['clientes', 'Gerir a lista de clientes'],
  ['escalas_gerir', 'Fazer as escalas e turnos'],
];
const TIPOS_SYNC = ['carrinhas', 'viagens', 'abastecimentos', 'despesas', 'custosFixos', 'ferias', 'ocorrencias',
  'salarios', 'processamentos', 'clientes', 'escalas'];
const URGENCIA = { baixa: ['ok', '🟢 Pode trabalhar'], media: ['medio', '🟠 Ver em breve'], alta: ['mau', '🔴 Parada'] };
const ESTADO_OC = { Aberto: ['mau', 'Por resolver'], 'Em reparação': ['medio', '🔧 Em reparação'], Resolvido: ['ok', '✓ Resolvido'] };
const ESTADO_FER = { Pendente: ['medio', '⏳ À espera'], Aprovado: ['ok', '✓ Aprovado'], Recusado: ['mau', '✕ Recusado'], Cancelado: ['neutro', 'Cancelado'] };

/* ---------- Utilitários ---------- */
// JSON com as chaves ordenadas (a base de dados reordena as chaves; assim as comparações não falham).
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}
const limpo = (r) => Object.fromEntries(Object.entries(r).filter(([k, v]) => k[0] !== '_' && v !== undefined));
const erroDeRede = (e) => !e?.code || /fetch|network|load failed/i.test(e.message || '');
// "2026-11-25T22:10:00.123456+00:00" → Date (o Safari não lê 6 casas decimais)
const lerData = (s) => new Date(String(s).replace(/(\.\d{3})\d+/, '$1'));
const iniciais = (n) => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

// Feriados nacionais de Portugal (fixos + Sexta-feira Santa e Corpo de Deus).
function pascoa(a) {
  const f = Math.floor, G = a % 19, C = f(a / 100);
  const H = (C - f(C / 4) - f((8 * C + 13) / 25) + 19 * G + 15) % 30;
  const I = H - f(H / 28) * (1 - f(29 / (H + 1)) * f((21 - G) / 11));
  const J = (a + f(a / 4) + I + 2 - C + f(C / 4)) % 7, L = I - J;
  const m = 3 + f((L + 40) / 44), d = L + 28 - 31 * f(m / 4);
  return Date.UTC(a, m - 1, d);
}
const _feriados = {};
function feriados(ano) {
  if (_feriados[ano]) return _feriados[ano];
  const s = new Set(['01-01', '04-25', '05-01', '06-10', '08-15', '10-05', '11-01', '12-01', '12-08', '12-25'].map((d) => `${ano}-${d}`));
  const p = pascoa(ano), dia = 864e5;
  [p - 2 * dia, p + 60 * dia].forEach((t) => s.add(new Date(t).toISOString().slice(0, 10)));
  return (_feriados[ano] = s);
}
function diasUteis(ini, fim) {
  if (!ini || !fim || fim < ini) return 0;
  let n = 0;
  const d = new Date(ini + 'T00:00:00Z'), f = new Date(fim + 'T00:00:00Z');
  for (let i = 0; d <= f && i < 400; i++, d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10), dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !feriados(d.getUTCFullYear()).has(iso)) n++;
  }
  return n;
}
const sobrepoe = (a, b) => a.inicio <= b.fim && b.inicio <= a.fim;

// Telemóvel: aceita "912 345 678", "+351 912345678", números estrangeiros…
const soDigitos = (t) => String(t || '').replace(/[\s().-]/g, '');
const telValido = (t) => /^\+?\d{9,15}$/.test(soDigitos(t));
const telWhatsApp = (t) => { const d = soDigitos(t).replace(/^\+/, ''); return d.length === 9 ? '351' + d : d; };
const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const diaMes = (iso) => (iso ? `${Number(String(iso).slice(8, 10))} ${MESES_CURTOS[Number(String(iso).slice(5, 7)) - 1]}` : '');
// Quantos dias faltam para o próximo aniversário de uma data (0 = hoje) e quantos anos faz.
function proximoAniversario(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const hoje = new Date(hojeISO() + 'T00:00:00');
  const naData = (ano) => {
    const bissexto = (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
    return new Date(ano, m - 1, m === 2 && d === 29 && !bissexto ? 28 : d);
  };
  let ano = hoje.getFullYear(), prox = naData(ano);
  if (prox < hoje) prox = naData(++ano);
  return { dias: Math.round((prox - hoje) / 864e5), anos: ano - y };
}
function idade(iso) {
  if (!iso) return null;
  const p = proximoAniversario(iso);
  return p.dias === 0 ? p.anos : p.anos - 1;
}

/* ---------- Módulo ---------- */
const Equipa = {
  user: null, empresa: null, eu: null, membros: [], papeis: {},
  aIniciar: false, aSync: false, timer: null, relogio: null, ultima: null, iniciadoPara: null, filtroOc: 'abertos',

  cli() { return Nuvem.cliente; },
  userId() { return this.empresa ? this.user?.id : undefined; },
  ativa() { return !!this.empresa; },

  /* ----- Permissões ----- */
  pode(p) {
    if (!this.empresa) return true;
    if (!this.eu) return false;
    if (this.eu.papel === 'patrao') return true;
    return (this.papeis[this.eu.papel] || []).includes(p);
  },
  meu(r) { return !r?._por || r._por === this.user?.id; },
  podeEditar(tipo, r) {
    if (!this.empresa) return true;
    const meu = this.meu(r);
    switch (tipo) {
      case 'viagens': return this.pode('viagens_editar_todas') || (meu && this.pode('viagens_registar'));
      case 'abastecimentos': return this.pode('abastecimentos_todos') || (meu && this.pode('abastecimentos_registar'));
      case 'despesas': return this.pode('financeiro') || (meu && this.pode('despesas_registar'));
      case 'carrinhas': return this.pode('carrinhas_gerir');
      case 'ocorrencias': return this.gereProblemas() || (meu && r.estado === 'Aberto');
      case 'ferias': return this.pode('ferias_aprovar') || (meu && r.estado === 'Pendente');
      case 'salarios': case 'processamentos': return this.pode('salarios');
      case 'clientes': return this.pode('clientes');
      case 'escalas': return this.pode('escalas_gerir');
      default: return this.pode('financeiro');
    }
  },
  gereProblemas() { return this.pode('ocorrencias_gerir') || this.pode('carrinhas_gerir'); },
  nomeDe(uid) {
    if (!uid || uid === this.user?.id) return this.eu?.nome || 'Eu';
    return this.membros.find((m) => m.user_id === uid)?.nome || 'Ex-membro';
  },
  autor(r) { return this.empresa && r && !this.meu(r) ? '👤 ' + esc(this.nomeDe(r._por)) : ''; },
  pasta(sub) { return this.empresa ? `${this.empresa.id}/${sub}` : Nuvem.user.id; },

  /* ----- Guardar no dispositivo ----- */
  chave(tipo) { return `frota-${tipo}-${this.empresa.id}`; },
  lerEstado() { try { return JSON.parse(localStorage.getItem(this.chave('sync'))) || {}; } catch (e) { return {}; } },
  gravarEstado(st) { try { localStorage.setItem(this.chave('sync'), JSON.stringify(st)); } catch (e) { /* */ } },
  gravarContexto() {
    try {
      localStorage.setItem('frota-contexto-' + this.user.id,
        JSON.stringify({ empresa: this.empresa, eu: this.eu, membros: this.membros, papeis: this.papeis }));
    } catch (e) { /* */ }
  },
  lerContexto(uid) { try { return JSON.parse(localStorage.getItem('frota-contexto-' + uid)); } catch (e) { return null; } },
  abrirCache() {
    CHAVE_ATUAL = this.chave('emp');
    let d = null;
    try { d = JSON.parse(localStorage.getItem(CHAVE_ATUAL)); } catch (e) { /* */ }
    dados = normalizar(d, true);
    if (!d) dados.parametros = { ...PARAMETROS_BASE, ...(this.empresa.parametros || {}) };
  },

  /* ----- Entrar / sair ----- */
  async iniciar(user) {
    if (this.iniciadoPara === user.id) { if (this.empresa) this.sincronizar(); return; }
    this.iniciadoPara = user.id; this.user = user; this.aIniciar = true;
    let membros;
    try {
      await this.cli().rpc('aceitar_convites');
      const { data, error } = await this.cli().from('membros').select('*').eq('user_id', user.id);
      if (error) throw error;
      membros = data || [];
    } catch (e) {
      this.aIniciar = false;
      // Sem internet: abre a última empresa usada neste dispositivo.
      const ctx = this.lerContexto(user.id);
      if (ctx?.empresa) {
        Object.assign(this, { empresa: ctx.empresa, eu: ctx.eu, membros: ctx.membros || [], papeis: ctx.papeis || {} });
        this.abrirCache();
        Nuvem.estado = 'erro'; Nuvem.erro = 'Sem internet: os dados ficam guardados aqui e são enviados quando houver ligação.';
        this.ligarRelogio();
      } else if (e?.code === '42P01' || e?.code === 'PGRST202' || e?.code === 'PGRST205') {
        // As tabelas da equipa ainda não foram criadas no Supabase: continua como antes.
        Nuvem.sincronizar();
      } else {
        this.iniciadoPara = null; // falhou a ligação: tenta outra vez na próxima sincronização
      }
      desenhar(); Nuvem.ui();
      return;
    }
    this.aIniciar = false;
    if (!membros.length) {
      if (this.empresa) this.sairDaEmpresa(true);
      desenhar();
      Nuvem.sincronizar(); // conta pessoal (sem empresa), como antes
      return;
    }
    let preferida = null;
    try { preferida = localStorage.getItem('frota-empresa-' + user.id); } catch (e) { /* */ }
    await this.entrar(membros.find((m) => m.empresa_id === preferida) || membros[0]);
  },

  async entrar(m) {
    this.empresa = { id: m.empresa_id }; this.eu = m;
    try { localStorage.setItem('frota-empresa-' + this.user.id, m.empresa_id); } catch (e) { /* */ }
    try { if (!(await this.carregarEquipa())) return; } catch (e) { /* sem rede: segue com o que houver */ }
    this.abrirCache();
    desenhar();
    this.ligarRelogio();
    await this.sincronizar();
  },

  ligarRelogio() {
    // vê as alterações dos colegas (pedidos de férias, problemas…) de minuto a minuto
    if (!this.relogio) this.relogio = setInterval(() => { if (document.visibilityState === 'visible') this.sincronizar(); }, 60000);
  },

  sairDaEmpresa(apagarCache = true) {
    clearInterval(this.relogio); this.relogio = null; clearTimeout(this.timer);
    if (apagarCache && this.empresa) {
      ['emp', 'sync'].forEach((t) => { try { localStorage.removeItem(this.chave(t)); } catch (e) { /* */ } });
      try { if (this.user) localStorage.removeItem('frota-contexto-' + this.user.id); } catch (e) { /* */ }
    }
    Object.assign(this, { empresa: null, eu: null, membros: [], papeis: {}, iniciadoPara: null, user: Nuvem.user });
    CHAVE_ATUAL = CHAVE;
    dados = carregar();
    desenhar(); Nuvem.ui();
  },

  async carregarEquipa() {
    const e = this.empresa.id;
    const [m, p, emp] = await Promise.all([
      this.cli().from('membros').select('*').eq('empresa_id', e),
      this.cli().from('papeis_permissoes').select('*').eq('empresa_id', e),
      this.cli().from('empresas').select('*').eq('id', e).maybeSingle(),
    ]);
    for (const r of [m, p, emp]) if (r.error) throw r.error;
    this.membros = (m.data || []).sort((a, b) => a.nome.localeCompare(b.nome));
    this.papeis = Object.fromEntries((p.data || []).map((x) => [x.papel, x.permissoes || []]));
    this.eu = this.membros.find((x) => x.user_id === this.user.id) || null;
    if (!this.eu || !emp.data) {
      aviso('Já não pertence a esta empresa.');
      this.sairDaEmpresa(true);
      Nuvem.sincronizar();
      return false;
    }
    this.empresa = emp.data;
    this.gravarContexto();
    return true;
  },

  async criarEmpresa(nome, meuNome) {
    if (!Nuvem.user) { aviso('Entre primeiro na sua conta.'); return; }
    await Nuvem.sincronizar(); // garante que os dados pessoais estão atualizados
    const { data: id, error } = await this.cli().rpc('criar_empresa', { p_nome: nome, p_meu_nome: meuNome, p_parametros: dados.parametros });
    if (error) {
      aviso(/function|schema/i.test(error.message) ? '❌ Falta correr o ficheiro equipa.sql no Supabase.' : '❌ ' + error.message);
      return;
    }
    // Os dados que já existiam passam para a empresa (são enviados na primeira sincronização).
    try { localStorage.setItem(`frota-emp-${id}`, JSON.stringify(dados)); } catch (e) { /* */ }
    this.iniciadoPara = null;
    await this.iniciar(Nuvem.user);
    aviso('🎉 Empresa criada! Agora adicione as pessoas em Equipa → Pessoas.');
  },

  /* ----- Sincronização ----- */
  agendar() {
    clearTimeout(this.timer);
    Nuvem.estado = 'pendente'; Nuvem.ui();
    this.timer = setTimeout(() => this.sincronizar(), 1500);
  },

  async sincronizar() {
    if (!this.empresa || !Nuvem.user || !this.cli()) return;
    if (this.aSync) { this.agendar(); return; }
    this.aSync = true; Nuvem.estado = 'a sincronizar'; Nuvem.ui();
    let mudou = false;
    try {
      const papelAntes = canon([this.eu?.papel, this.papeis[this.eu?.papel] || []]);
      if (!(await this.carregarEquipa())) return;
      let st = this.lerEstado();
      const perm = canon([this.eu.papel, this.papeis[this.eu.papel] || []]);
      if (st.perm !== perm) {
        // Primeira vez, ou mudou o papel/permissões: recomeça a partir do que está na internet.
        if (st.perm) { TIPOS_SYNC.forEach((t) => { dados[t] = []; }); mudou = true; }
        st = { perm, cursor: null, base: {}, baseParam: null };
      }
      if (papelAntes !== perm) mudou = true;
      mudou = (await this.enviar(st)) || mudou;
      mudou = (await this.receber(st)) || mudou;
      this.gravarEstado(st);
      guardar(false);
      this.ultima = new Date().toISOString();
      Nuvem.estado = 'ok'; Nuvem.erro = '';
    } catch (e) {
      Nuvem.estado = 'erro';
      Nuvem.erro = navigator.onLine === false ? 'Sem internet: os dados ficam guardados aqui e são enviados quando houver ligação.'
        : 'Não foi possível sincronizar (' + (e.message || e) + ').';
    } finally {
      this.aSync = false;
      Nuvem.ui();
      if (mudou) desenhar(); else this.desenhar();
    }
  },

  // Envia o que mudou neste dispositivo desde a última sincronização.
  async enviar(st) {
    const e = this.empresa.id;
    let recusados = 0, mudou = false;
    for (const tipo of TIPOS_SYNC) {
      const base = (st.base[tipo] ||= {});
      const atuais = dados[tipo] || [];
      const ids = new Set();
      const linhas = [];
      atuais.forEach((r) => {
        ids.add(r.id);
        const d = limpo(r), j = canon(d);
        if (base[r.id] !== j) linhas.push({ row: { empresa_id: e, id: r.id, tipo, dados: d, apagado: false }, j });
      });
      Object.keys(base).forEach((id) => {
        if (!ids.has(id)) linhas.push({ row: { empresa_id: e, id, tipo, dados: JSON.parse(base[id]), apagado: true }, j: null });
      });
      if (!linhas.length) continue;
      const aceite = (l) => { if (l.row.apagado) delete base[l.row.id]; else base[l.row.id] = l.j; };
      for (let i = 0; i < linhas.length; i += 400) {
        const lote = linhas.slice(i, i + 400);
        const { error } = await this.cli().from('registos').upsert(lote.map((l) => l.row), { onConflict: 'empresa_id,id' });
        if (!error) { lote.forEach(aceite); continue; }
        if (erroDeRede(error)) throw error;
        // Algum registo foi recusado (sem permissão): envia um a um e repõe os recusados.
        for (const l of lote) {
          const r = await this.cli().from('registos').upsert([l.row], { onConflict: 'empresa_id,id' });
          if (!r.error) { aceite(l); continue; }
          if (erroDeRede(r.error)) throw r.error;
          recusados++; mudou = true;
          const lista = dados[tipo], k = lista.findIndex((x) => x.id === l.row.id);
          if (base[l.row.id]) {
            const original = { ...JSON.parse(base[l.row.id]), id: l.row.id };
            if (k >= 0) lista[k] = { ...original, _por: lista[k]._por }; else lista.push(original);
          } else if (k >= 0) lista.splice(k, 1);
        }
      }
    }
    // Parâmetros (preço objetivo, reserva, ordenado…) ficam na empresa.
    const jp = canon(dados.parametros);
    if (st.baseParam !== jp && this.pode('financeiro')) {
      const { error } = await this.cli().from('empresas').update({ parametros: dados.parametros }).eq('id', e);
      if (error) { if (erroDeRede(error)) throw error; } else { st.baseParam = jp; this.empresa.parametros = { ...dados.parametros }; }
    }
    if (recusados) aviso(`⛔ Sem permissão para alterar ${recusados} registo${recusados > 1 ? 's' : ''}. Ficou como estava.`);
    return mudou;
  },

  // Recebe o que os outros mudaram (só o que esta pessoa pode ver).
  async receber(st) {
    const e = this.empresa.id;
    let mudou = false;
    let desde = st.cursor ? new Date(new Date(st.cursor).getTime() - 120000).toISOString() : '1970-01-01T00:00:00Z';
    for (let pagina = 0; pagina < 50; pagina++) {
      const { data, error } = await this.cli().from('registos').select('id,tipo,dados,apagado,criado_por,atualizado')
        .eq('empresa_id', e).gt('atualizado', desde).order('atualizado', { ascending: true }).limit(1000);
      if (error) throw error;
      for (const row of data) {
        if (!TIPOS_SYNC.includes(row.tipo)) continue;
        const lista = (dados[row.tipo] ||= []), base = (st.base[row.tipo] ||= {});
        const k = lista.findIndex((x) => x.id === row.id);
        const local = k >= 0 ? lista[k] : null;
        const pendente = local ? canon(limpo(local)) !== base[row.id] : base[row.id] !== undefined;
        const quando = lerData(row.atualizado).toISOString();
        if (!st.cursor || quando > st.cursor) st.cursor = quando;
        if (pendente) continue; // há uma alteração deste dispositivo por enviar: ganha a mais recente
        if (row.apagado) {
          if (k >= 0) { lista.splice(k, 1); mudou = true; }
          delete base[row.id];
        } else {
          const j = canon(row.dados);
          if (base[row.id] !== j || !local || local._por !== row.criado_por) mudou = true;
          const novo = { ...row.dados, id: row.id, _por: row.criado_por };
          if (k >= 0) lista[k] = novo; else lista.push(novo);
          base[row.id] = j;
        }
      }
      if (data.length < 1000) break;
      desde = data[data.length - 1].atualizado;
    }
    // Parâmetros da empresa
    const remotos = { ...PARAMETROS_BASE, ...(this.empresa.parametros || {}) };
    const rp = canon(remotos), lp = canon(dados.parametros);
    if (lp !== rp && (st.baseParam == null || lp === st.baseParam || !this.pode('financeiro'))) {
      dados.parametros = remotos; mudou = true;
    }
    if (lp === st.baseParam || st.baseParam == null || !this.pode('financeiro')) st.baseParam = rp;
    return mudou;
  },

  /* ----- Ficheiros (fotos dos problemas) ----- */
  async enviarFoto(id, ficheiro) {
    if (!Nuvem.user) return;
    const ext = (ficheiro.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
    const caminho = `${this.pasta('ocorrencias')}/${id}-${Date.now()}.${ext}`;
    aviso('📤 A enviar a foto…');
    const { error } = await this.cli().storage.from('faturas').upload(caminho, ficheiro, { contentType: ficheiro.type || undefined, upsert: true });
    if (error) { aviso('❌ A foto não foi enviada: ' + error.message); return; }
    const o = dados.ocorrencias.find((x) => x.id === id);
    if (!o) return;
    o.foto = caminho;
    guardar(); desenhar(); aviso('📷 Foto enviada');
  },
  async abrirFicheiro(caminho) {
    if (!caminho || !Nuvem.user) return;
    const janela = window.open('', '_blank'); // o iPhone bloqueia janelas abertas depois de esperar
    const { data, error } = await this.cli().storage.from('faturas').createSignedUrl(caminho, 3600);
    if (error || !data?.signedUrl) { janela?.close(); aviso('❌ Não foi possível abrir o ficheiro.'); return; }
    if (janela) janela.location.href = data.signedUrl; else location.href = data.signedUrl;
  },

  /* ----- Pessoas ----- */
  async guardarPessoa(f, editId) {
    if (!telValido(f.telefone)) { aviso('❌ O telemóvel não parece certo (ex: 912 345 678).'); return false; }
    const anos = idade(f.data_nascimento);
    if (anos == null || anos < 14 || anos > 100) { aviso('❌ Verifique a data de nascimento.'); return false; }
    const registo = {
      nome: f.nome.trim(), email: f.email.trim().toLowerCase(), telefone: f.telefone.trim(), papel: f.papel,
      dias_ferias: Math.max(0, Math.min(60, Math.round(N(f.dias_ferias || 22)))), data_entrada: f.data_entrada || null,
      data_nascimento: f.data_nascimento, contacto_emergencia: (f.contacto_emergencia || '').trim() || null,
    };
    const q = editId
      ? this.cli().from('membros').update(registo).eq('id', editId)
      : this.cli().from('membros').insert({ ...registo, empresa_id: this.empresa.id });
    const { error } = await q;
    if (error) {
      aviso(erroDeRede(error) ? '❌ Precisa de internet para alterar pessoas.'
        : /duplicate|unique/i.test(error.message) ? '❌ Já existe uma pessoa com esse email.'
          : /row-level|policy/i.test(error.message) ? '⛔ Sem permissão para isso.'
            : /data_nascimento|contacto_emergencia|column/i.test(error.message) ? '❌ Falta correr o ficheiro equipa-2.sql no Supabase.'
              : '❌ ' + error.message);
      return false;
    }
    await this.carregarEquipa();
    this.desenhar();
    const senha = (f.senha_inicial || '').trim();
    const membro = this.membros.find((m) => m.email === registo.email);
    if (senha && membro && !membro.user_id) await this.criarConta(membro, senha);
    else aviso(editId ? '✅ Pessoa atualizada' : `✅ ${registo.nome} adicionado. Envie-lhe o convite (📤).`);
    return true;
  },
  async criarConta(m, senha) {
    if (senha.length < 6) { alert('A palavra-passe inicial tem de ter pelo menos 6 caracteres. A pessoa ficou adicionada; envie-lhe o convite 📤.'); return; }
    const { data } = await this.cli().auth.getSession();
    const r = await fetch(Notificacoes.url(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: window.FROTA_NUVEM.chave, Authorization: 'Bearer ' + (data.session?.access_token || '') },
      body: JSON.stringify({ acao: 'criar_conta', empresa_id: this.empresa.id, email: m.email, senha }),
    }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r || !j.ok) {
      alert(`⚠️ ${m.nome} foi adicionado, mas a conta não foi criada automaticamente.\n\n${j.erro && j.erro !== 'Não autorizado' ? j.erro : 'Falta atualizar a função no Supabase (código novo).'}\n\nEnquanto isso, envie o convite 📤 para a pessoa criar a conta.`);
      return;
    }
    await this.carregarEquipa(); this.desenhar();
    const texto = `Olá ${m.nome.split(' ')[0]}! O teu acesso à ${this.empresa.nome}:\n\n📱 ${location.origin + location.pathname}\n✉️ Email: ${m.email}\n🔑 Palavra-passe: ${senha}\n\n` +
      `Na primeira entrada vais escolher a tua palavra-passe e criar o teu PIN. Dica: adiciona o site ao ecrã principal.`;
    if (confirm(`✅ Conta criada!\n\nEmail: ${m.email}\nPalavra-passe: ${senha}\n\nQuer enviar estes dados à pessoa (WhatsApp, SMS…)?`)) {
      if (navigator.share) navigator.share({ text: texto }).catch(() => {});
      else window.open('https://wa.me/' + (m.telefone ? telWhatsApp(m.telefone) : '') + '?text=' + encodeURIComponent(texto), '_blank');
    }
  },
  perfilCompleto(m = this.eu) { return !!(m?.telefone && m?.data_nascimento); },
  async guardarMeuPerfil(f) {
    if (!telValido(f.telefone)) { aviso('❌ O telemóvel não parece certo (ex: 912 345 678).'); return; }
    const anos = idade(f.data_nascimento);
    if (anos == null || anos < 14 || anos > 100) { aviso('❌ Verifique a data de nascimento.'); return; }
    const { error } = await this.cli().rpc('atualizar_meu_perfil', {
      p_telefone: f.telefone.trim(), p_nascimento: f.data_nascimento, p_emergencia: (f.contacto_emergencia || '').trim(),
    });
    if (error) {
      aviso(erroDeRede(error) ? '❌ Precisa de internet para guardar.' : /function|schema/i.test(error.message)
        ? '❌ Falta correr o ficheiro equipa-2.sql no Supabase.' : '❌ ' + error.message);
      return;
    }
    await this.carregarEquipa();
    $('#detMeuPerfil').open = false;
    this.desenhar(); desenharAvisos();
    aviso('✅ Dados guardados. Obrigado!');
  },

  async removerPessoa(id) {
    const m = this.membros.find((x) => x.id === id);
    if (!m) return;
    if (m.user_id === this.user.id) { aviso('Não se pode remover a si próprio.'); return; }
    if (!confirm(`Remover ${m.nome} da empresa?\n\nDeixa de ter acesso logo. As viagens, recibos e registos que fez ficam guardados.`)) return;
    const apagar = !!m.user_id && confirm(`Também quer APAGAR A CONTA de ${m.nome} (${m.email})?\n\n` +
      `OK = apagar a conta: o email e a palavra-passe deixam de existir e não consegue entrar de todo.\n` +
      `Cancelar = só tirar da equipa (a conta fica, mas não vê nada da empresa).`);
    if (apagar) {
      const { data } = await this.cli().auth.getSession();
      const r = await fetch(Notificacoes.url(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: window.FROTA_NUVEM.chave, Authorization: 'Bearer ' + (data.session?.access_token || '') },
        body: JSON.stringify({ acao: 'apagar_conta', empresa_id: this.empresa.id, membro_id: id }),
      }).catch(() => null);
      const j = r ? await r.json().catch(() => ({})) : {};
      if (j.ok) {
        await this.carregarEquipa(); this.desenhar();
        if (j.aviso) alert('⚠️ ' + j.aviso); else aviso(`🗑️ ${m.nome} foi removido e a conta apagada.`);
        return;
      }
      if (j.erro && j.erro !== 'Não autorizado') { aviso('⛔ ' + j.erro); return; }
      // Função antiga no Supabase: tira da equipa e explica como apagar a conta à mão.
      const { error } = await this.cli().from('membros').delete().eq('id', id);
      if (error) { aviso(erroDeRede(error) ? '❌ Precisa de internet.' : '⛔ ' + error.message); return; }
      await this.carregarEquipa(); this.desenhar();
      alert(`${m.nome} saiu da equipa, mas a conta não foi apagada automaticamente (falta atualizar a função no Supabase).\n\nPara a apagar: Supabase → Authentication → Users → ${m.email} → Delete user.`);
      return;
    }
    const { error } = await this.cli().from('membros').delete().eq('id', id);
    if (error) { aviso(erroDeRede(error) ? '❌ Precisa de internet.' : '⛔ ' + error.message); return; }
    await this.carregarEquipa();
    this.desenhar();
    aviso(`${m.nome} foi removido da equipa.`);
  },
  convidar(id) {
    const m = this.membros.find((x) => x.id === id);
    if (!m) return;
    const url = location.origin + location.pathname;
    const texto = `Olá ${m.nome.split(' ')[0]}! Foste adicionado à ${this.empresa.nome} (${PAPEIS[m.papel]}).\n\n` +
      `1. Abre ${url}\n2. Vai a ⚙️ Mais → Guardar na internet\n3. Escreve o email ${m.email}, escolhe uma palavra-passe e toca em "Criar conta"\n` +
      `4. Confirma no email que recebes e depois toca em "Entrar".\n\nDica: adiciona o site ao ecrã principal.`;
    if (navigator.share) navigator.share({ text: texto }).catch(() => {});
    else window.open('https://wa.me/?text=' + encodeURIComponent(texto), '_blank');
  },

  async mudarPermissao(papel, perm, ligar) {
    const atuais = new Set(this.papeis[papel] || []);
    if (ligar) atuais.add(perm); else atuais.delete(perm);
    const lista = PERMISSOES.map(([k]) => k).filter((k) => atuais.has(k));
    const { error } = await this.cli().from('papeis_permissoes').update({ permissoes: lista })
      .eq('empresa_id', this.empresa.id).eq('papel', papel);
    if (error) { aviso(erroDeRede(error) ? '❌ Precisa de internet.' : '⛔ ' + error.message); this.desenhar(); return; }
    this.papeis[papel] = lista;
    this.gravarContexto();
    aviso(`✅ Permissões de ${PAPEIS[papel]} atualizadas`);
  },

  /* ----- Férias ----- */
  saldoFerias(uid = this.user?.id) {
    const ano = hojeISO().slice(0, 4);
    const m = uid === this.user?.id ? this.eu : this.membros.find((x) => x.user_id === uid);
    const total = m?.dias_ferias ?? 22;
    const minhas = dados.ferias.filter((f) => (f._por || this.user?.id) === uid && f.tipo === 'Férias' && (f.inicio || '').startsWith(ano));
    const usados = minhas.filter((f) => f.estado === 'Aprovado').reduce((s, f) => s + N(f.dias), 0);
    const pendentes = minhas.filter((f) => f.estado === 'Pendente').reduce((s, f) => s + N(f.dias), 0);
    return { total, usados, pendentes, restam: total - usados };
  },
  async decidirFerias(id, aprovar) {
    const f = dados.ferias.find((x) => x.id === id);
    if (!f) return;
    let motivo = '';
    if (!aprovar) {
      motivo = prompt('Motivo da recusa (a pessoa vai ver):', '');
      if (motivo === null) return;
    }
    Object.assign(f, { estado: aprovar ? 'Aprovado' : 'Recusado', decididoPor: this.eu?.nome || '', decididoEm: hojeISO(), motivoRecusa: motivo.trim() });
    guardar(); desenhar();
    aviso(aprovar ? '✅ Aprovado' : 'Pedido recusado');
  },

  /* ----- Problemas ----- */
  async mudarOcorrencia(id, estado) {
    const o = dados.ocorrencias.find((x) => x.id === id);
    if (!o) return;
    if (estado === 'Resolvido') {
      const feito = prompt('O que foi feito para resolver?', o.resolucao || '');
      if (feito === null) return;
      o.resolucao = feito.trim();
      if (this.pode('despesas_registar') || this.pode('financeiro')) {
        const custo = prompt('Quanto custou a reparação? (€ — deixe vazio se não teve custo)', '');
        const valor = N(String(custo || '').replace(',', '.'));
        if (valor > 0) {
          o.custo = valor;
          dados.despesas.push({ id: novoId(), _por: this.userId(), carrinhaId: o.carrinhaId, data: hojeISO(), categoria: 'Avaria / reparação',
            valor, descricao: `${o.tipo}: ${o.resolucao || o.descricao}` });
        }
      }
      o.resolvidoEm = hojeISO(); o.resolvidoPor = this.eu?.nome || '';
    }
    o.estado = estado;
    guardar(); desenhar();
    aviso(estado === 'Resolvido' ? '✓ Problema resolvido' : estado === 'Aberto' ? 'Problema reaberto' : '🔧 Em reparação');
  },

  /* ----- Avisos no Painel ----- */
  avisos() {
    if (!this.empresa) return [];
    const out = [];
    if (this.pode('ferias_aprovar')) {
      const n = dados.ferias.filter((f) => f.estado === 'Pendente').length;
      if (n) out.push({ cls: 'medio', icone: '🏖️', txt: `${n} pedido${n > 1 ? 's' : ''} de férias por aprovar`, sub: 'Equipa → Pedidos por aprovar' });
    }
    if (this.gereProblemas()) {
      dados.ocorrencias.filter((o) => o.estado !== 'Resolvido').forEach((o) => out.push({
        cls: o.urgencia === 'alta' ? 'mau' : 'medio', icone: o.urgencia === 'alta' ? '🔴' : '🔧',
        txt: `${o.tipo}: ${o.descricao}`,
        sub: `${dados.carrinhas.find((c) => c.id === o.carrinhaId)?.matricula || ''} · ${this.nomeDe(o._por)} · ${o.estado}`,
      }));
    }
    // 👤 Dados em falta (a própria pessoa e o RH)
    if (this.eu && !this.perfilCompleto()) {
      out.push({ cls: 'medio', icone: '👤', txt: 'Complete os seus dados: telemóvel e data de nascimento', sub: 'Toque aqui → Equipa → Os meus dados', ir: 'equipa', foco: 'detMeuPerfil' });
    }
    if (this.pode('pessoas_gerir')) {
      const faltam = this.membros.filter((m) => m.user_id !== this.user.id && !this.perfilCompleto(m));
      if (faltam.length) {
        out.push({ cls: 'medio', icone: '📋', txt: `Faltam dados de ${faltam.length} pessoa${faltam.length > 1 ? 's' : ''}: ${faltam.map((m) => m.nome.split(' ')[0]).join(', ')}`,
          sub: 'Telemóvel e data de nascimento', ir: 'equipa', foco: 'listaPessoas' });
      }
    }
    // 🎂 Aniversários (1 dia antes e no próprio dia) e anos de casa
    if (this.pode('avisos_aniversarios')) {
      this.membros.filter((m) => m.user_id !== this.user.id).forEach((m) => {
        const tel = m.telefone ? ` · 📞 ${m.telefone}` : '';
        const p = proximoAniversario(m.data_nascimento);
        if (p && p.dias <= 1) {
          out.push({ cls: p.dias === 0 ? 'ok' : 'medio', icone: '🎂', sub: `Faz ${p.anos} anos${tel}`,
            txt: p.dias === 0 ? `Hoje é o aniversário de ${m.nome}!` : `Amanhã é o aniversário de ${m.nome}` });
        }
        const c = proximoAniversario(m.data_entrada);
        if (c && c.dias <= 1 && c.anos >= 1) {
          out.push({ cls: 'ok', icone: '🎉', sub: `Entrou em ${dataPT(m.data_entrada)}`,
            txt: `${c.dias === 0 ? 'Hoje' : 'Amanhã'} ${m.nome} faz ${c.anos} ano${c.anos > 1 ? 's' : ''} na empresa` });
        }
      });
    }
    // 🏖️ Férias da equipa que começam na próxima semana
    if (this.pode('avisos_ferias')) {
      const hoje = hojeISO();
      const daquiASemana = new Date(new Date(hoje + 'T00:00:00').getTime() + 7 * 864e5);
      const limite = `${daquiASemana.getFullYear()}-${String(daquiASemana.getMonth() + 1).padStart(2, '0')}-${String(daquiASemana.getDate()).padStart(2, '0')}`;
      dados.ferias.filter((f) => f.estado === 'Aprovado' && !this.meu(f) && f.inicio >= hoje && f.inicio <= limite)
        .sort((a, b) => a.inicio.localeCompare(b.inicio))
        .forEach((f) => {
          const n = Math.round((new Date(f.inicio + 'T00:00:00') - new Date(hoje + 'T00:00:00')) / 864e5);
          out.push({ cls: 'medio', icone: '🏖️', ir: 'equipa', foco: 'listaAusencias',
            txt: `${this.nomeDe(f._por)}: ${f.tipo.toLowerCase()} ${n === 0 ? 'a partir de hoje' : n === 1 ? 'a partir de amanhã' : `daqui a ${n} dias`}`,
            sub: `${dataPT(f.inicio)} → ${dataPT(f.fim)} · ${f.dias} dia${f.dias === 1 ? '' : 's'} úte${f.dias === 1 ? 'il' : 'is'}` });
        });
    }
    // Os meus turnos de hoje e amanhã
    const hojeT = hojeISO();
    const amanhaT = (() => { const d = new Date(hojeT + 'T00:00:00'); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    (dados.escalas || []).filter((t) => t.userId === this.user.id && (t.data === hojeT || t.data === amanhaT))
      .sort((a, b) => (a.data + a.inicio).localeCompare(b.data + b.inicio))
      .forEach((t) => out.push({ cls: 'ok', icone: '📅', ir: 'equipa', foco: 'listaEscalas',
        txt: `${t.data === hojeT ? 'Hoje' : 'Amanhã'}: turno das ${t.inicio} às ${t.fim}`,
        sub: [dados.carrinhas.find((c) => c.id === t.carrinhaId)?.matricula, t.notas].filter(Boolean).join(' · ') || 'Escala' }));
    // Recibo novo
    const semanaR = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    (dados.processamentos || []).filter((p) => p.userId === this.user.id && ['Fechado', 'Pago'].includes(p.estado) && (p.fechadoEm || '') >= semanaR)
      .forEach((p) => out.push({ cls: 'ok', icone: '🧾', ir: 'equipa', foco: 'listaRecibos',
        txt: `Recibo de ${MESES[Number(p.mes.slice(5, 7)) - 1]} disponível${p.estado === 'Pago' ? ' (pago)' : ''}`,
        sub: 'Toque para ver' }));
    const semana = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    dados.ferias.filter((f) => this.meu(f) && ['Aprovado', 'Recusado'].includes(f.estado) && (f.decididoEm || '') >= semana)
      .forEach((f) => out.push({
        cls: f.estado === 'Aprovado' ? 'ok' : 'mau', icone: f.estado === 'Aprovado' ? '✅' : '✕',
        txt: `${f.tipo} de ${dataPT(f.inicio)} a ${dataPT(f.fim)}: ${f.estado.toLowerCase()}`,
        sub: f.motivoRecusa ? 'Motivo: ' + f.motivoRecusa : `por ${f.decididoPor || 'RH'}`,
      }));
    return out;
  },

  /* ----- Desenhar ----- */
  desenhar() {
    // Mostrar/esconder o que cada pessoa pode usar
    $$('[data-perm]').forEach((el) => { el.hidden = !el.dataset.perm.split('|').some((p) => this.pode(p)); });
    $$('[data-sem-perm]').forEach((el) => { el.hidden = el.dataset.semPerm.split('|').some((p) => this.pode(p)); });
    const ativa = $('#abas button.ativa');
    if (ativa && ativa.hidden) $('#abas button[data-aba="painel"]').click();
    $$('[data-subnav]').forEach((nav) => mostrarSub(nav, null));

    const ok = !!this.empresa;
    $('#equipaAtiva').hidden = !ok;
    $('#equipaInativa').hidden = ok;
    $('#equipaSemConta').hidden = !!Nuvem.user;
    $('#equipaSemEmpresa').hidden = !Nuvem.user || ok || this.aIniciar;
    if (Nuvem.user) $('#meuEmailConvite').textContent = Nuvem.user.email;

    const saud = $('#saudacao');
    saud.hidden = !ok;
    let numEquipa = 0;
    if (!ok) { $('#numEquipa').hidden = true; return; }

    saud.innerHTML = `<span class="avatar">${esc(iniciais(this.eu?.nome))}</span><div><b>Olá, ${esc((this.eu?.nome || '').split(' ')[0])} 👋</b>
      <small>${esc(PAPEIS[this.eu?.papel] || '')} · ${esc(this.empresa.nome || '')}</small></div>`;
    $('#perfil').innerHTML = saud.innerHTML;
    const completo = this.perfilCompleto();
    $('#perfilEstado').innerHTML = completo ? '<span class="badge ok">✓ completo</span>' : '<span class="badge medio">por completar</span>';
    const fp = $('#formMeuPerfil');
    if (!fp.contains(document.activeElement)) {
      fp.elements.telefone.value = this.eu?.telefone || '';
      fp.elements.data_nascimento.value = this.eu?.data_nascimento || '';
      fp.elements.contacto_emergencia.value = this.eu?.contacto_emergencia || '';
    }
    if (!completo && !this._perfilAberto) { $('#detMeuPerfil').open = true; this._perfilAberto = true; }

    this.desenharPainelPessoal();
    this.desenharOcorrencias();
    this.desenharFerias();
    this.desenharPessoas();
    this.desenharPermissoes();

    if (this.pode('ferias_aprovar')) numEquipa += dados.ferias.filter((f) => f.estado === 'Pendente').length;
    if (this.gereProblemas()) numEquipa += dados.ocorrencias.filter((o) => o.estado === 'Aberto').length;
    $('#numEquipa').hidden = !numEquipa;
    $('#numEquipa').textContent = numEquipa > 9 ? '9+' : numEquipa;
  },

  desenharPainelPessoal() {
    if (this.pode('financeiro')) return;
    const vs = dados.viagens.filter((v) => noPeriodo(v.data) && (this.pode('viagens_ver_todas') || this.meu(v)));
    const km = vs.reduce((s, v) => s + N(v.kmCarregado) + N(v.kmVazio), 0);
    const sf = this.saldoFerias();
    const problemas = dados.ocorrencias.filter((o) => o.estado !== 'Resolvido' && (this.gereProblemas() || this.meu(o))).length;
    const fazViagens = this.pode('viagens_registar') || this.pode('viagens_ver_todas');
    const hoje = hojeISO();
    const ausentes = dados.ferias.filter((f) => f.estado === 'Aprovado' && f.inicio <= hoje && f.fim >= hoje).length;
    const porAprovar = dados.ferias.filter((f) => f.estado === 'Pendente').length;
    $('#cartoesPessoais').innerHTML = (fazViagens ? `
      <div class="cartao"><small>${this.pode('viagens_ver_todas') ? 'Viagens' : 'As minhas viagens'}</small><strong>${vs.length}</strong></div>
      <div class="cartao"><small>Km no período</small><strong>${num(km)}</strong></div>` : `
      <div class="cartao"><small>Na equipa</small><strong>${this.membros.length} pessoas</strong></div>
      ${this.pode('ferias_aprovar') ? `<div class="cartao ${porAprovar ? 'vermelho' : ''}"><small>Férias por aprovar</small><strong>${porAprovar}</strong></div>`
        : `<div class="cartao"><small>Ausentes hoje</small><strong>${ausentes}</strong></div>`}`) + `
      <div class="cartao destaque"><small>Férias restam</small><strong class="positivo">${sf.restam} dias</strong></div>
      ${problemas ? `<div class="cartao vermelho"><small>Problemas abertos</small><strong>${problemas}</strong></div>` : ''}`;
  },

  desenharOcorrencias() {
    const ordemEstado = { Aberto: 0, 'Em reparação': 1, Resolvido: 2 };
    const ordemUrg = { alta: 0, media: 1, baixa: 2 };
    let lista = dados.ocorrencias.slice().sort((a, b) => (ordemEstado[a.estado] ?? 3) - (ordemEstado[b.estado] ?? 3)
      || (ordemUrg[a.urgencia] ?? 3) - (ordemUrg[b.urgencia] ?? 3) || (b.data + (b.hora || '')).localeCompare(a.data + (a.hora || '')));
    if (this.filtroOc === 'abertos') lista = lista.filter((o) => o.estado !== 'Resolvido');
    $$('#filtroOcorrencias .chip').forEach((c) => c.classList.toggle('ativo', c.dataset.f === this.filtroOc));
    const gere = this.gereProblemas();
    $('#listaOcorrencias').innerHTML = lista.length ? lista.map((o) => {
      const van = dados.carrinhas.find((c) => c.id === o.carrinhaId);
      const [ucls, utxt] = URGENCIA[o.urgencia] || URGENCIA.media;
      const [ecls, etxt] = ESTADO_OC[o.estado] || ESTADO_OC.Aberto;
      const acoes = gere ? (o.estado === 'Resolvido'
        ? `<button class="mini" data-oc="${o.id}" data-estado="Aberto">↩ Reabrir</button>`
        : `${o.estado === 'Aberto' ? `<button class="mini" data-oc="${o.id}" data-estado="Em reparação">🔧 Em reparação</button>` : ''}
           <button class="mini ok" data-oc="${o.id}" data-estado="Resolvido">✓ Resolvido</button>`) : '';
      return `<div class="item oc urg-${o.urgencia || 'media'}"><div class="info">
          <div class="titulo">${esc(o.tipo)} ${van ? `<span class="placa mini"><i>P</i><span>${esc(van.matricula)}</span></span>` : ''}</div>
          <div class="sub texto">${esc(o.descricao)}</div>
          <div class="sub">${dataPT(o.data)}${o.hora ? ' ' + o.hora : ''} · ${esc(this.nomeDe(o._por))}${o.km ? ' · ' + num(o.km) + ' km' : ''}</div>
          <div class="sub"><span class="badge ${ucls}">${utxt}</span><span class="badge ${ecls}">${etxt}</span>
            ${o.foto ? `<button class="badge neutro abrirFicheiro" data-caminho="${esc(o.foto)}">📷 Foto</button>` : ''}</div>
          ${o.resolucao ? `<div class="sub">✔ ${esc(o.resolucao)}${o.custo ? ' · ' + euro(o.custo) : ''}${o.resolvidoPor ? ' · ' + esc(o.resolvidoPor) : ''}</div>` : ''}
          ${acoes ? `<div class="botoes mini-botoes">${acoes}</div>` : ''}
        </div>
        <div class="direita">${this.podeEditar('ocorrencias', o) ? btnEditar('ocorrencias', o.id) + btnApagar('ocorrencias', o.id) : ''}</div></div>`;
    }).join('') : vazioMsg(this.filtroOc === 'abertos' ? '👍 Nenhum problema por resolver.' : 'Ainda não foram reportados problemas.');
  },

  desenharFerias() {
    const sf = this.saldoFerias();
    $('#saldoFerias').innerHTML = `
      <div class="cartao destaque"><small>Restam ${hojeISO().slice(0, 4)}</small><strong class="positivo">${sf.restam} dias</strong></div>
      <div class="cartao verde"><small>Aprovados</small><strong>${sf.usados} de ${sf.total}</strong></div>
      <div class="cartao"><small>À espera</small><strong>${sf.pendentes} dias</strong></div>`;

    const linha = (f, extra = '', mostrarNome = false) => {
      const [ecls, etxt] = ESTADO_FER[f.estado] || ESTADO_FER.Pendente;
      return `<div class="item"><div class="info">
          <div class="titulo">${mostrarNome ? esc(this.nomeDe(f._por)) + ' · ' : ''}${esc(f.tipo)}</div>
          <div class="sub">${dataPT(f.inicio)}${f.fim !== f.inicio ? ' → ' + dataPT(f.fim) : ''} · ${f.dias} dia${f.dias === 1 ? '' : 's'} úte${f.dias === 1 ? 'il' : 'is'}${f.nota ? ' · ' + esc(f.nota) : ''}</div>
          <div class="sub"><span class="badge ${ecls}">${etxt}</span>${f.motivoRecusa ? ' ' + esc(f.motivoRecusa) : ''}${f.decididoPor && f.estado !== 'Pendente' ? ` <small>· ${esc(f.decididoPor)}</small>` : ''}</div>
          ${extra}</div></div>`;
    };

    const minhas = dados.ferias.filter((f) => this.meu(f)).sort((a, b) => (b.inicio || '').localeCompare(a.inicio || '')).slice(0, 20);
    $('#listaMinhasFerias').innerHTML = minhas.length ? minhas.map((f) => linha(f, f.estado === 'Pendente'
      ? `<div class="botoes mini-botoes"><button class="mini" data-fer-cancelar="${f.id}">Cancelar pedido</button></div>` : '')).join('')
      : vazioMsg('Ainda não pediu férias nem folgas.');

    if (this.pode('ferias_aprovar')) {
      const pend = dados.ferias.filter((f) => f.estado === 'Pendente').sort((a, b) => (a.inicio || '').localeCompare(b.inicio || ''));
      $('#listaAprovar').innerHTML = pend.length ? pend.map((f) => {
        const choques = dados.ferias.filter((o) => o.id !== f.id && o.estado === 'Aprovado' && o._por !== f._por && sobrepoe(o, f))
          .map((o) => this.nomeDe(o._por));
        const sf = this.saldoFerias(f._por || this.user.id);
        return linha(f, `
          ${f.tipo === 'Férias' ? `<div class="sub">Saldo de ${esc(this.nomeDe(f._por))}: restam ${sf.restam} de ${sf.total} dias</div>` : ''}
          ${choques.length ? `<div class="sub negativo">⚠️ Nestes dias também está ausente: ${esc([...new Set(choques)].join(', '))}</div>` : ''}
          <div class="botoes mini-botoes"><button class="mini ok" data-fer-decidir="${f.id}" data-aprovar="1">✓ Aprovar</button>
          <button class="mini mau" data-fer-decidir="${f.id}" data-aprovar="0">✕ Recusar</button></div>`, true);
      }).join('') : vazioMsg('👍 Nenhum pedido à espera.');
    }

    const hoje = hojeISO();
    const aus = dados.ferias.filter((f) => f.estado === 'Aprovado' && (f.fim || '') >= hoje).sort((a, b) => a.inicio.localeCompare(b.inicio)).slice(0, 30);
    $('#listaAusencias').innerHTML = aus.length ? aus.map((f) => `<div class="item"><div class="info">
        <div class="titulo">${f.inicio <= hoje ? '<span class="badge mau">Hoje ausente</span> ' : ''}${esc(this.nomeDe(f._por))}</div>
        <div class="sub">${esc(f.tipo)} · ${dataPT(f.inicio)}${f.fim !== f.inicio ? ' → ' + dataPT(f.fim) : ''} · ${f.dias} dia${f.dias === 1 ? '' : 's'}</div>
      </div></div>`).join('') : vazioMsg('Ninguém ausente nos próximos tempos.');
  },

  desenharPessoas() {
    const ordem = Object.keys(PAPEIS);
    const lista = this.membros.slice().sort((a, b) => ordem.indexOf(a.papel) - ordem.indexOf(b.papel) || a.nome.localeCompare(b.nome));
    const gere = this.pode('pessoas_gerir');
    $('#listaPessoas').innerHTML = lista.map((m) => {
      const podeMexer = gere && (m.papel !== 'patrao' || this.pode('permissoes_gerir'));
      const sf = this.saldoFerias(m.user_id);
      return `<div class="item pessoa"><span class="avatar">${esc(iniciais(m.nome))}</span><div class="info">
          <div class="titulo">${esc(m.nome)}${m.user_id === this.user.id ? ' <small>(eu)</small>' : ''}</div>
          <div class="sub"><span class="badge papel-${m.papel}">${esc(PAPEIS[m.papel])}</span>
            ${m.user_id ? '' : '<span class="badge medio">Convite por aceitar</span>'}</div>
          <div class="sub">${esc(m.email)}${m.data_nascimento ? ` · 🎂 ${diaMes(m.data_nascimento)}${gere ? ` (${idade(m.data_nascimento)} anos)` : ''}` : ''}</div>
          ${gere && m.contacto_emergencia ? `<div class="sub">🆘 Emergência: ${esc(m.contacto_emergencia)}</div>` : ''}
          ${gere && m.user_id ? `<div class="sub">🏖️ ${sf.restam} de ${m.dias_ferias} dias de férias por gozar</div>` : ''}
          ${gere && !this.perfilCompleto(m) ? `<div class="sub"><span class="badge medio">⚠️ Falta: ${[!m.telefone && 'telemóvel', !m.data_nascimento && 'data de nascimento'].filter(Boolean).join(' e ')}</span></div>` : ''}
          ${m.telefone && m.user_id !== this.user.id ? `<div class="botoes mini-botoes">
            <a class="mini botao-link" href="tel:${esc(soDigitos(m.telefone))}">📞 Ligar</a>
            <a class="mini botao-link" href="https://wa.me/${esc(telWhatsApp(m.telefone))}" target="_blank" rel="noopener">💬 WhatsApp</a></div>` : ''}
        </div>
        <div class="direita">${podeMexer ? `${m.user_id ? '' : `<button class="icone" data-convite="${m.id}" aria-label="Enviar convite">📤</button>`}
          <button class="icone" data-pessoa-editar="${m.id}" aria-label="Editar">✏️</button>
          ${m.user_id !== this.user.id ? `<button class="icone" data-pessoa-remover="${m.id}" aria-label="Remover">🗑️</button>` : ''}` : ''}</div></div>`;
    }).join('');
    const sel = $('#selPapel');
    const atual = sel.value;
    sel.innerHTML = Object.entries(PAPEIS).filter(([k]) => k !== 'patrao' || this.pode('permissoes_gerir'))
      .map(([k, v]) => `<option value="${k}"${k === 'condutor' ? ' selected' : ''}>${v}</option>`).join('');
    sel.value = atual && [...sel.options].some((o) => o.value === atual) ? atual : 'condutor';
  },

  desenharPermissoes() {
    if (!this.pode('permissoes_gerir')) return;
    const sel = $('#selPapelPermissoes');
    const atual = sel.value || 'condutor';
    if (!sel.options.length) {
      sel.innerHTML = Object.entries(PAPEIS).filter(([k]) => k !== 'patrao').map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    }
    sel.value = atual;
    const tem = new Set(this.papeis[atual] || []);
    $('#listaPermissoes').innerHTML = PERMISSOES.map(([k, txt]) => `<label class="perm"><input type="checkbox" data-perm-chave="${k}" ${tem.has(k) ? 'checked' : ''}>
      <span>${esc(txt)}</span></label>`).join('');
  },
};

/* ---------- Sub-separadores (Equipa: Problemas/Férias/...; Viagens: Viagens/Clientes) ---------- */
const subEscolhido = {};
function mostrarSub(nav, nome) {
  if (!nav) return;
  const chave = nav.dataset.subnav;
  const chips = [...nav.querySelectorAll('[data-sub]')].filter((c) => !c.hidden);
  if (!chips.length) return;
  nome = nome || subEscolhido[chave];
  if (!chips.some((c) => c.dataset.sub === nome)) nome = chips[0].dataset.sub;
  subEscolhido[chave] = nome;
  chips.forEach((c) => c.classList.toggle('ativo', c.dataset.sub === nome));
  nav.parentElement.querySelectorAll(':scope > [data-sub-painel]').forEach((p) => p.classList.toggle('ativo', p.dataset.subPainel === nome));
}
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-subnav] [data-sub]');
  if (c) mostrarSub(c.closest('[data-subnav]'), c.dataset.sub);
});

/* ---------- Formulários e botões ---------- */
ligarFormulario('#formOcorrencias', 'ocorrencias', (f, editId) => {
  const antiga = editId ? dados.ocorrencias.find((x) => x.id === editId) : null;
  const id = editId || novoId();
  const foto = f.fotoFile && f.fotoFile.size ? f.fotoFile : null;
  if (foto) setTimeout(() => Equipa.enviarFoto(id, foto), 0);
  const agora = new Date();
  return {
    id, carrinhaId: f.carrinhaId, tipo: f.tipo, urgencia: f.urgencia, descricao: f.descricao.trim(), km: f.km === '' ? null : N(f.km),
    data: antiga?.data || hojeISO(), hora: antiga?.hora || `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`,
    estado: antiga?.estado || 'Aberto', foto: antiga?.foto || null, resolucao: antiga?.resolucao || '', custo: antiga?.custo || 0,
  };
}, '⚠️ Aviso enviado. Obrigado!');

ligarFormulario('#formFerias', 'ferias', (f) => {
  if (f.fim < f.inicio) { aviso('A data "Até" tem de ser igual ou depois de "De".'); return null; }
  const dias = diasUteis(f.inicio, f.fim);
  if (!dias && !confirm('Esse período só tem fins de semana/feriados (0 dias úteis). Enviar mesmo assim?')) return null;
  if (f.tipo === 'Férias') {
    const sf = Equipa.saldoFerias();
    if (dias > sf.restam - sf.pendentes &&
        !confirm(`Pediu ${dias} dias mas só tem ${sf.restam - sf.pendentes} disponíveis este ano. Enviar mesmo assim?`)) return null;
  }
  return { tipo: f.tipo, inicio: f.inicio, fim: f.fim, dias, nota: f.nota.trim(), estado: 'Pendente', pedidoEm: hojeISO() };
}, '🏖️ Pedido enviado. Vai receber a resposta aqui.');

$('#formFerias').addEventListener('input', () => {
  const f = $('#formFerias').elements;
  if (f.inicio.value && !f.fim.value) f.fim.value = f.inicio.value;
  const d = diasUteis(f.inicio.value, f.fim.value);
  $('#infoDiasFerias').innerHTML = f.inicio.value && f.fim.value
    ? (f.fim.value < f.inicio.value ? '⚠️ A data "Até" é antes de "De".' : `<b>${d} dia${d === 1 ? '' : 's'} úte${d === 1 ? 'il' : 'is'}</b> (sem fins de semana nem feriados)`) : '';
});

$('#formPessoas').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const ok = await Equipa.guardarPessoa(Object.fromEntries(new FormData(form)), form.dataset.editId);
  if (ok) { sairEdicao(form); form.elements.dias_ferias.value = 22; $('#blocoSenhaInicial').hidden = false; }
});
$('#formPessoas .cancelar').addEventListener('click', () => { sairEdicao($('#formPessoas')); $('#formPessoas').elements.dias_ferias.value = 22; $('#blocoSenhaInicial').hidden = false; });

$('#formCriarEmpresa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  if (!confirm(`Criar a empresa "${f.empresa}"?\n\nOs dados que já tem neste site passam para a empresa e fica como Patrão.`)) return;
  const b = e.target.querySelector('button[type=submit]');
  b.disabled = true;
  try { await Equipa.criarEmpresa(f.empresa.trim(), f.nome.trim()); } finally { b.disabled = false; }
});

$('#filtroOcorrencias').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (c) { Equipa.filtroOc = c.dataset.f; Equipa.desenharOcorrencias(); }
});
$('#selPapelPermissoes').addEventListener('change', () => Equipa.desenharPermissoes());
$('#listaPermissoes').addEventListener('change', (e) => {
  const c = e.target.closest('[data-perm-chave]');
  if (c) Equipa.mudarPermissao($('#selPapelPermissoes').value, c.dataset.permChave, c.checked);
});

$('#formMeuPerfil').addEventListener('submit', (e) => {
  e.preventDefault();
  Equipa.guardarMeuPerfil(Object.fromEntries(new FormData(e.target)));
});

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, a, .aviso-item[data-ir]');
  if (!t) return;
  const d = t.dataset;
  if (d.ir) {
    $(`#abas button[data-aba="${d.ir}"]`).click();
    if (d.foco) setTimeout(() => {
      const el = $('#' + d.foco);
      if (!el) return;
      const painel = el.closest('[data-sub-painel]');
      if (painel) mostrarSub(painel.parentElement.querySelector(':scope > [data-subnav]'), painel.dataset.subPainel);
      if (el.tagName === 'DETAILS') el.open = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
  } else if (d.oc) Equipa.mudarOcorrencia(d.oc, d.estado);
  else if (d.ferDecidir) Equipa.decidirFerias(d.ferDecidir, d.aprovar === '1');
  else if (d.ferCancelar) {
    const f = dados.ferias.find((x) => x.id === d.ferCancelar);
    if (f && confirm('Cancelar este pedido?')) { f.estado = 'Cancelado'; guardar(); desenhar(); aviso('Pedido cancelado'); }
  } else if (d.convite) Equipa.convidar(d.convite);
  else if (d.pessoaRemover) Equipa.removerPessoa(d.pessoaRemover);
  else if (d.pessoaEditar) {
    const m = Equipa.membros.find((x) => x.id === d.pessoaEditar);
    const form = $('#formPessoas');
    if (!m) return;
    ['nome', 'email', 'telefone', 'papel', 'dias_ferias', 'data_entrada', 'data_nascimento', 'contacto_emergencia'].forEach((k) => { form.elements[k].value = m[k] ?? ''; });
    form.dataset.editId = m.id;
    $('#blocoSenhaInicial').hidden = !!m.user_id;
    form.querySelector('.tituloForm').textContent = '✏️ A editar ' + m.nome;
    form.querySelector('.cancelar').hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (t.classList.contains('abrirFicheiro')) Equipa.abrirFicheiro(d.caminho);
});

/* (o arranque está no fim de rh.js) */
