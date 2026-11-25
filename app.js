'use strict';

/* ================= Dados ================= */
const CHAVE = 'gestao-frota-v1';

const PARAMETROS_BASE = {
  precoObjetivo: 0.85, reserva: 0.10, consumo: 7, precoGasoleo: 2.10,
  ordenado: 1000, ss: 11, irs: 15, encargos: 25.675, subsidios: '1',
};
const FIXOS_BASE = [
  ['Seguro da carrinha', 200], ['Seguro de mercadorias (CMR)', 0], ['IUC', 12], ['Inspeção periódica', 8],
  ['Contabilista', 80], ['Wtransnet (cargas)', 40], ['Claude Pro', 22], ['Outros fixos', 50],
];
const CATEGORIAS_RESERVA = ['Manutenção / revisão', 'Pneus', 'Avaria / reparação', 'Manutenção'];

const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// semPadroes = true na empresa (os custos fixos vêm da internet, não se inventam).
function normalizar(d, semPadroes = false) {
  d = d && typeof d === 'object' ? d : {};
  const out = {
    carrinhas: d.carrinhas || [], viagens: d.viagens || [], abastecimentos: d.abastecimentos || [],
    despesas: d.despesas || [], ferias: d.ferias || [], ocorrencias: d.ocorrencias || [],
    custosFixos: d.custosFixos || (semPadroes ? [] : FIXOS_BASE.map(([nome, valor]) => ({ id: novoId(), nome, valor, periodo: 'Mensal' }))),
    parametros: { ...PARAMETROS_BASE, ...(d.parametros || {}) },
    ultimaCopia: d.ultimaCopia || null,
    alterado: d.alterado || null,
  };
  // Versão anterior: as "receitas" passam a ser viagens.
  (d.receitas || []).forEach((r) => out.viagens.push({
    id: r.id, data: r.data, carrinhaId: r.carrinhaId || '', cliente: r.cliente || '', origem: '', destino: '',
    kmCarregado: 0, kmVazio: 0, receita: r.valor || 0, portagens: 0, alimentacao: 0, outros: 0,
    fatura: '', estado: 'Pago', notas: r.descricao || '',
  }));
  return out;
}

function carregar() {
  try { return normalizar(JSON.parse(localStorage.getItem(CHAVE))); } catch (e) { return normalizar(null); }
}
let dados = carregar();
// Onde os dados ficam guardados neste dispositivo: CHAVE (só este dispositivo / conta pessoal)
// ou uma chave própria da empresa quando se entra numa empresa.
let CHAVE_ATUAL = CHAVE;
const emEquipa = () => typeof Equipa !== 'undefined' && Equipa.ativa();
// Permissões da pessoa (sem empresa, pode tudo).
const pode = (p) => (typeof Equipa === 'undefined' ? true : Equipa.pode(p));
const podeEditar = (tipo, r) => (typeof Equipa === 'undefined' ? true : Equipa.podeEditar(tipo, r));

// marcar = true quando o utilizador alterou algo (para enviar para a internet).
function guardar(marcar = true) {
  if (marcar && !emEquipa()) { dados.alterado = new Date().toISOString(); Sync.set({ pendente: true }); }
  try { localStorage.setItem(CHAVE_ATUAL, JSON.stringify(dados)); } catch (e) { aviso('⚠️ Não foi possível guardar neste navegador.'); }
  if (marcar) {
    if (emEquipa()) Equipa.agendar();
    else if (typeof Nuvem !== 'undefined') Nuvem.agendar();
  }
}

// Estado da sincronização (fica fora dos dados).
const Sync = {
  CH: 'gestao-frota-sync',
  get() { try { return JSON.parse(localStorage.getItem(this.CH)) || {}; } catch (e) { return {}; } },
  set(o) { try { localStorage.setItem(this.CH, JSON.stringify({ ...this.get(), ...o })); } catch (e) { /* */ } },
};
guardar(false);
// Pede ao navegador para não apagar estes dados automaticamente.
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* sem suporte */ }

/* ================= Utilitários ================= */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const euroFmt = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });
const euro = (v) => euroFmt.format(v || 0);
const num = (v, c = 0) => new Intl.NumberFormat('pt-PT', { minimumFractionDigits: c, maximumFractionDigits: c }).format(v || 0);
const pct = (v) => (v == null ? '—' : num(v * 100, 0) + ' %');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hojeISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const dataPT = (d) => (d ? d.split('-').reverse().join('/') : '');
const N = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function nomeCarrinha(id) {
  if (!id) return '';
  const c = dados.carrinhas.find((x) => x.id === id);
  return c ? c.matricula + (c.modelo ? ' · ' + c.modelo : '') : '(apagada)';
}

let tAviso;
function aviso(texto) {
  const el = $('#aviso');
  el.textContent = texto; el.hidden = false;
  clearTimeout(tAviso); tAviso = setTimeout(() => (el.hidden = true), 2400);
}

/* ================= Período ================= */
let mes = hojeISO().slice(0, 7); // '' = tudo
const noPeriodo = (data) => !mes || (data || '').startsWith(mes);

function mesesNoPeriodo() {
  if (mes) return 1;
  const s = new Set();
  [...dados.viagens, ...dados.abastecimentos, ...dados.despesas].forEach((x) => x.data && s.add(x.data.slice(0, 7)));
  return s.size;
}

/* ================= Cálculos ================= */
const P = () => dados.parametros;

function custoOrdenadoMes() {
  const p = P();
  const liq = 1 - N(p.ss) / 100 - N(p.irs) / 100;
  if (liq <= 0) return 0;
  return (N(p.ordenado) / liq) * (1 + N(p.encargos) / 100) * (String(p.subsidios) === '1' ? 14 / 12 : 1);
}

const DIVISOR = { Mensal: 1, Trimestral: 3, Semestral: 6, Anual: 12 };
const fixosMes = () => dados.custosFixos.reduce((s, f) => s + N(f.valor) / (DIVISOR[f.periodo] || 1), 0);

// Abastecimentos ordenados por km, com a distância desde o anterior da mesma carrinha.
function abastecimentosComDistancia() {
  const grupos = {};
  dados.abastecimentos.forEach((a) => (grupos[a.carrinhaId] ||= []).push(a));
  const out = [];
  Object.values(grupos).forEach((lista) => {
    lista.sort((a, b) => a.km - b.km || a.data.localeCompare(b.data));
    lista.forEach((a, i) => {
      const dist = i > 0 ? a.km - lista[i - 1].km : 0;
      out.push({ ...a, dist: dist > 0 ? dist : 0, temAnterior: dist > 0 });
    });
  });
  return out;
}

// Custo de gasóleo por km: média real (abastecimentos) da carrinha → da frota → parâmetros.
function gasoleoPorKm(carrinhaId) {
  const abast = abastecimentosComDistancia().filter((a) => a.temAnterior);
  const calc = (lista) => {
    const km = lista.reduce((s, a) => s + a.dist, 0);
    return km > 0 ? lista.reduce((s, a) => s + a.valor, 0) / km : null;
  };
  return (carrinhaId ? calc(abast.filter((a) => a.carrinhaId === carrinhaId)) : null)
    ?? calc(abast)
    ?? (N(P().consumo) / 100) * N(P().precoGasoleo);
}

// Estados de pagamento: Pendente → Pago 50% → Pago.
const ESTADOS = ['Pendente', 'Pago 50%', 'Pago'];
const ESTADO_UI = { Pendente: ['mau', '⏳ Por cobrar'], 'Pago 50%': ['medio', '◐ Pago 50%'], Pago: ['ok', '✓ Pago'] };
function porCobrarViagem(v) {
  if (v.estado === 'Pago') return 0;
  return v.estado === 'Pago 50%' ? N(v.receita) / 2 : N(v.receita);
}

function calcViagem(v) {
  const kmTotal = N(v.kmCarregado) + N(v.kmVazio);
  const gasoleo = kmTotal * gasoleoPorKm(v.carrinhaId);
  const diretos = N(v.portagens) + N(v.alimentacao) + N(v.outros);
  const gastos = gasoleo + diretos;
  const lucro = N(v.receita) - gastos;
  const kc = N(v.kmCarregado);
  const precoKm = kc > 0 ? N(v.receita) / kc : null;
  let aval = null;
  if (lucro < 0) aval = { txt: 'PREJUÍZO', cls: 'mau' };
  else if (precoKm != null) aval = precoKm >= N(P().precoObjetivo) - 1e-9 ? { txt: 'OK', cls: 'ok' } : { txt: 'Abaixo do objetivo', cls: 'medio' };
  else if (N(v.receita) > 0) aval = { txt: 'OK', cls: 'ok' };
  return {
    kmTotal, gasoleo, diretos, gastos, lucro, precoKm, aval,
    minimoKm: kc > 0 ? gastos / kc : null,
    margem: N(v.receita) > 0 ? lucro / N(v.receita) : null,
  };
}

function resumoPeriodo(carrinhaId /* undefined = todas */) {
  const daCarrinha = (x) => carrinhaId === undefined || x.carrinhaId === carrinhaId;
  const viagens = dados.viagens.filter((v) => noPeriodo(v.data) && daCarrinha(v));
  const abast = abastecimentosComDistancia().filter((a) => noPeriodo(a.data) && daCarrinha(a));
  const desp = dados.despesas.filter((d) => noPeriodo(d.data) && daCarrinha(d));

  const r = { viagens: viagens.length, receita: 0, portagens: 0, alimentacao: 0, outros: 0, gasoleoEst: 0,
    kmCarregado: 0, kmVazio: 0, porCobrar: 0, lucroViagens: 0, receitaComKm: 0 };
  viagens.forEach((v) => {
    const c = calcViagem(v);
    r.receita += N(v.receita); r.portagens += N(v.portagens); r.alimentacao += N(v.alimentacao); r.outros += N(v.outros);
    r.gasoleoEst += c.gasoleo; r.kmCarregado += N(v.kmCarregado); r.kmVazio += N(v.kmVazio); r.lucroViagens += c.lucro;
    if (N(v.kmCarregado) > 0) r.receitaComKm += N(v.receita);
    r.porCobrar += porCobrarViagem(v);
  });
  r.km = r.kmCarregado + r.kmVazio;
  r.pctVazio = r.km > 0 ? r.kmVazio / r.km : null;
  r.precoKm = r.kmCarregado > 0 ? r.receitaComKm / r.kmCarregado : null;

  // Gasóleo: o que foi pago nos abastecimentos; se não houver, a estimativa das viagens.
  r.gasoleoReal = abast.reduce((s, a) => s + a.valor, 0);
  r.gasoleoEstimado = abast.length === 0;
  r.gasoleo = r.gasoleoEstimado ? r.gasoleoEst : r.gasoleoReal;
  const kmMedia = abast.reduce((s, a) => s + a.dist, 0);
  const litrosMedia = abast.filter((a) => a.temAnterior).reduce((s, a) => s + a.litros, 0);
  r.media = kmMedia > 0 && litrosMedia > 0 ? (litrosMedia / kmMedia) * 100 : null;

  r.manutencaoPaga = desp.filter((d) => CATEGORIAS_RESERVA.includes(d.categoria)).reduce((s, d) => s + d.valor, 0);
  r.outrasDespesas = desp.filter((d) => !CATEGORIAS_RESERVA.includes(d.categoria)).reduce((s, d) => s + d.valor, 0);
  r.porCategoria = {};
  desp.filter((d) => !CATEGORIAS_RESERVA.includes(d.categoria))
    .forEach((d) => (r.porCategoria[d.categoria] = (r.porCategoria[d.categoria] || 0) + d.valor));

  const meses = carrinhaId === undefined ? mesesNoPeriodo() : 0;
  r.meses = meses;
  r.fixos = fixosMes() * meses;
  r.reserva = r.km * N(P().reserva);
  r.gastosViagens = r.portagens + r.alimentacao + r.outros + r.gasoleo;
  r.gastos = r.gastosViagens + r.outrasDespesas + r.fixos + r.reserva;
  r.lucro = r.receita - r.gastos;
  r.ordenado = custoOrdenadoMes() * meses;
  r.sobra = r.lucro - r.ordenado;
  r.ordenadoPossivel = r.lucro > 0 && r.ordenado > 0 ? (r.lucro / r.ordenado) * N(P().ordenado) : 0;
  return r;
}

function saldoReserva() {
  const km = dados.viagens.reduce((s, v) => s + N(v.kmCarregado) + N(v.kmVazio), 0);
  const pago = dados.despesas.filter((d) => CATEGORIAS_RESERVA.includes(d.categoria)).reduce((s, d) => s + d.valor, 0);
  return km * N(P().reserva) - pago;
}

// Semana do mês (segunda a domingo), como no Excel.
function semanaDoMes(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  const offset = (new Date(a, m - 1, 1).getDay() + 6) % 7;
  return Math.floor((d - 1 + offset) / 7) + 1;
}

/* ================= Desenhar ================= */
const cls = (v) => (v >= 0 ? 'positivo' : 'negativo');

function preencherSelects() {
  $$('.selCarrinha').forEach((sel) => {
    const atual = sel.value;
    let html = '';
    if (sel.classList.contains('comGeral')) html = '<option value="">Geral (empresa)</option>';
    else if (sel.classList.contains('semCarrinha')) html = '<option value="">—</option>';
    else if (!dados.carrinhas.length) html = '<option value="">Adicione uma carrinha em ⚙️ Mais</option>';
    html += dados.carrinhas.map((c) => `<option value="${c.id}">${esc(nomeCarrinha(c.id))}</option>`).join('');
    sel.innerHTML = html;
    if ([...sel.options].some((o) => o.value === atual) && atual) sel.value = atual;
    else if (dados.carrinhas.length && !sel.classList.contains('comGeral')) sel.value = dados.carrinhas[0].id;
  });
  const unicos = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('#sugClientes').innerHTML = unicos(dados.viagens.map((v) => v.cliente)).map((c) => `<option value="${esc(c)}">`).join('');
  $('#sugLocais').innerHTML = unicos(dados.viagens.flatMap((v) => [v.origem, v.destino])).map((c) => `<option value="${esc(c)}">`).join('');
}

function linhaR(rotulo, valor, extra = '') {
  return `<div class="r ${extra}"><span>${rotulo}</span><b>${valor}</b></div>`;
}

// Km atual de uma carrinha (último registo do conta-quilómetros).
function kmAtual(id) {
  const kms = dados.abastecimentos.filter((a) => a.carrinhaId === id).map((a) => N(a.km));
  return kms.length ? Math.max(...kms) : null;
}

// Estado dos documentos e da revisão de uma carrinha.
const DOCS = [['seguro', 'Seguro'], ['inspecao', 'Inspeção'], ['iuc', 'IUC']];
function estadoDocs(c) {
  const out = [];
  const hoje = new Date(hojeISO());
  DOCS.forEach(([campo, nome]) => {
    if (!c[campo]) return;
    const dias = Math.round((new Date(c[campo]) - hoje) / 864e5);
    if (dias < 0) out.push({ cls: 'mau', txt: `${nome} expirou há ${-dias} dia${dias === -1 ? '' : 's'}`, alerta: true });
    else if (dias <= 30) out.push({ cls: 'medio', txt: `${nome} termina em ${dias} dia${dias === 1 ? '' : 's'} (${dataPT(c[campo])})`, alerta: true });
    else out.push({ cls: 'ok', txt: `${nome} até ${dataPT(c[campo])}` });
  });
  if (c.revisaoKm) {
    const km = kmAtual(c.id);
    if (km == null) out.push({ cls: 'neutro', txt: `Revisão aos ${num(c.revisaoKm)} km` });
    else {
      const falta = c.revisaoKm - km;
      if (falta <= 0) out.push({ cls: 'mau', txt: `Revisão em atraso (${num(-falta)} km)`, alerta: true });
      else if (falta <= 1500) out.push({ cls: 'medio', txt: `Revisão daqui a ${num(falta)} km`, alerta: true });
      else out.push({ cls: 'ok', txt: `Revisão daqui a ${num(falta)} km` });
    }
  }
  return out;
}

function desenharAvisos() {
  const avisos = [];
  if (pode('carrinhas_gerir') || pode('ocorrencias_gerir')) {
    dados.carrinhas.forEach((c) => estadoDocs(c).filter((d) => d.alerta)
      .forEach((d) => avisos.push({ ...d, matricula: c.matricula })));
  }
  if (typeof Equipa !== 'undefined') avisos.push(...Equipa.avisos());
  const peso = { mau: 0, medio: 1, ok: 2 };
  avisos.sort((a, b) => (peso[a.cls] ?? 1) - (peso[b.cls] ?? 1));
  $('#blocoAvisos').hidden = !avisos.length;
  $('#listaAvisos').innerHTML = avisos.map((a) => `<div class="aviso-item ${a.cls}">${a.icone || (a.cls === 'mau' ? '⛔' : '⚠️')}
    <div><b>${esc(a.txt)}</b><small>${esc(a.sub ?? a.matricula)}</small></div></div>`).join('');
}

function desenharPainel() {
  desenharAvisos();
  const t = resumoPeriodo();
  $('#totReceita').textContent = euro(t.receita);
  $('#totGastos').textContent = euro(t.gastos);
  $('#totLucro').textContent = euro(t.lucro);
  $('#totLucro').className = cls(t.lucro);
  $('#totKm').textContent = `${num(t.km)} (${pct(t.pctVazio)})`;
  $('#totMedia').textContent = t.media == null ? '—' : num(t.media, 1) + ' L';
  $('#totPrecoKm').textContent = t.precoKm == null ? '—' : euro(t.precoKm);
  $('#totPrecoKm').className = t.precoKm == null ? '' : t.precoKm >= N(P().precoObjetivo) ? 'positivo' : 'negativo';

  if (mes) { const [a, m] = mes.split('-'); $('#tituloPeriodo').textContent = `de ${MESES[Number(m) - 1]} ${a}`; }
  else $('#tituloPeriodo').textContent = `(tudo · ${t.meses} ${t.meses === 1 ? 'mês' : 'meses'})`;

  const reserva = saldoReserva();
  $('#resultado').innerHTML = [
    linhaR(`Receita das viagens (${t.viagens})`, euro(t.receita)),
    linhaR(`− Gasóleo${t.gasoleoEstimado ? ' <small>(estimado)</small>' : ''}`, euro(t.gasoleo)),
    linhaR('− Portagens', euro(t.portagens)),
    linhaR('− Comida / estadia', euro(t.alimentacao)),
    t.outros ? linhaR('− Outros das viagens', euro(t.outros)) : '',
    t.outrasDespesas ? linhaR('− Outras despesas', euro(t.outrasDespesas)) : '',
    linhaR('− Custos fixos', euro(t.fixos)),
    linhaR(`− Reserva de manutenção (${num(t.km)} km)`, euro(t.reserva)),
    linhaR('LUCRO antes do ordenado', `<span class="${cls(t.lucro)}">${euro(t.lucro)}</span>`, 'forte'),
    linhaR('− Custo do ordenado', euro(t.ordenado)),
    linhaR('Sobra / falta depois do ordenado', `<span class="${cls(t.sobra)}">${euro(t.sobra)}</span>`, 'forte'),
    linhaR('Ordenado líquido que a empresa aguenta', euro(t.ordenadoPossivel / Math.max(t.meses, 1)) + (t.meses > 1 ? '/mês' : '')),
    linhaR('Faturas por cobrar', `<span class="${t.porCobrar > 0 ? 'negativo' : ''}">${euro(t.porCobrar)}</span>`),
    t.manutencaoPaga ? linhaR('Manutenção paga (saiu da reserva)', euro(t.manutencaoPaga)) : '',
    linhaR('Saldo da reserva de manutenção (total)', `<span class="${cls(reserva)}">${euro(reserva)}</span>`),
  ].join('');

  // Por semana
  $('#blocoSemanas').hidden = !mes;
  if (mes) {
    const semanas = {};
    dados.viagens.filter((v) => noPeriodo(v.data)).forEach((v) => {
      const s = semanaDoMes(v.data);
      const w = (semanas[s] ||= { n: 0, kc: 0, kv: 0, receita: 0, lucro: 0, rk: 0 });
      const c = calcViagem(v);
      w.n++; w.kc += N(v.kmCarregado); w.kv += N(v.kmVazio); w.receita += N(v.receita); w.lucro += c.lucro; if (N(v.kmCarregado) > 0) w.rk += N(v.receita);
    });
    const [a, m] = mes.split('-').map(Number);
    const ultimo = new Date(a, m, 0).getDate();
    const nSem = semanaDoMes(`${mes}-${String(ultimo).padStart(2, '0')}`);
    const offset = (new Date(a, m - 1, 1).getDay() + 6) % 7;
    let html = '<tr><th>Semana</th><th>Nº</th><th>Km</th><th>Receita</th><th>€/km</th><th>Lucro*</th></tr>';
    const tot = { n: 0, kc: 0, kv: 0, receita: 0, lucro: 0, rk: 0 };
    for (let s = 1; s <= nSem; s++) {
      const w = semanas[s] || { n: 0, kc: 0, kv: 0, receita: 0, lucro: 0, rk: 0 };
      Object.keys(tot).forEach((k) => (tot[k] += w[k]));
      const ini = Math.max(1, (s - 1) * 7 - offset + 1);
      const fim = Math.min(ultimo, s * 7 - offset);
      html += `<tr><td>${ini}–${fim}</td><td>${w.n}</td><td>${num(w.kc + w.kv)}</td>
        <td>${euro(w.receita)}</td><td>${w.kc ? euro(w.rk / w.kc) : '—'}</td>
        <td class="${w.n ? cls(w.lucro) : ''}">${euro(w.lucro)}</td></tr>`;
    }
    html += `<tr class="total"><td>Total</td><td>${tot.n}</td><td>${num(tot.kc + tot.kv)}</td><td>${euro(tot.receita)}</td>
      <td>${tot.kc ? euro(tot.rk / tot.kc) : '—'}</td><td class="${cls(tot.lucro)}">${euro(tot.lucro)}</td></tr>`;
    $('#tabelaSemanas').innerHTML = html + '<caption style="caption-side:bottom;text-align:left;padding:8px;color:var(--suave);font-size:.78rem">* Lucro das viagens, antes de custos fixos e reserva.</caption>';
  }

  // Por carrinha (só faz sentido com 2 ou mais)
  $('#blocoCarrinhas').hidden = dados.carrinhas.length < 2;
  $('#listaPainel').innerHTML = dados.carrinhas.map((c) => {
    const r = resumoPeriodo(c.id);
    return `<div class="item carrinha-painel">
      <div class="linha"><span class="titulo">${esc(nomeCarrinha(c.id))}</span>
        <span class="valor ${cls(r.lucroViagens)}">${euro(r.lucroViagens)}</span></div>
      <div class="grelha">
        <div><small>Viagens</small><b>${r.viagens}</b></div>
        <div><small>Km</small><b>${num(r.km)}</b></div>
        <div><small>Média</small><b>${r.media == null ? '—' : num(r.media, 1) + ' L/100'}</b></div>
        <div><small>Receita</small><b>${euro(r.receita)}</b></div>
        <div><small>Gasóleo</small><b>${euro(r.gasoleo)}</b></div>
        <div><small>€/km carregado</small><b>${r.precoKm == null ? '—' : euro(r.precoKm)}</b></div>
      </div></div>`;
  }).join('');

  // Para onde vai o dinheiro
  const cats = { 'Gasóleo': t.gasoleo, 'Portagens': t.portagens, 'Comida / estadia': t.alimentacao,
    'Outros (viagens)': t.outros, 'Custos fixos': t.fixos, 'Reserva manutenção': t.reserva, ...t.porCategoria };
  const ent = Object.entries(cats).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...ent.map(([, v]) => v), 1);
  $('#categoriasPainel').innerHTML = ent.length
    ? ent.map(([k, v]) => `<div class="barra-linha"><span>${esc(k)}</span>
        <div class="barra-fundo"><div class="barra" style="width:${(v / max) * 100}%"></div></div><b>${euro(v)}</b></div>`).join('')
    : '<div class="vazio">Sem gastos neste período.</div>';

  // Todos os meses (histórico)
  const todos = new Set();
  [...dados.viagens, ...dados.abastecimentos, ...dados.despesas].forEach((x) => x.data && todos.add(x.data.slice(0, 7)));
  const guardaMes = mes;
  let hm = '<tr><th>Mês</th><th>Viagens</th><th>Receita</th><th>Lucro*</th><th>Sobra**</th></tr>';
  [...todos].sort().reverse().forEach((m) => {
    mes = m;
    const r = resumoPeriodo();
    const [a, mm] = m.split('-');
    hm += `<tr data-mes="${m}" class="${m === guardaMes ? 'atual' : ''}"><td>${MESES[Number(mm) - 1].slice(0, 3)} ${a}</td><td>${r.viagens}</td>
      <td>${euro(r.receita)}</td><td class="${cls(r.lucro)}">${euro(r.lucro)}</td><td class="${cls(r.sobra)}">${euro(r.sobra)}</td></tr>`;
  });
  mes = guardaMes;
  $('#tabelaMeses').innerHTML = todos.size
    ? hm + '<caption style="caption-side:bottom;text-align:left;padding:8px;color:var(--suave);font-size:.78rem">* Lucro antes do ordenado. ** Depois do ordenado.</caption>'
    : '<tr><td>Ainda não há registos.</td></tr>';

  // Lembrete de cópia de segurança
  const total = dados.viagens.length + dados.abastecimentos.length + dados.despesas.length;
  const dias = dados.ultimaCopia ? Math.floor((Date.now() - new Date(dados.ultimaCopia)) / 864e5) : null;
  const mostrar = total >= 3 && (dias == null || dias >= 7) && !Nuvem.user;
  $('#bannerCopia').hidden = !mostrar;
  if (mostrar) $('#bannerTexto').textContent = dias == null ? 'Ainda não guardou nenhuma cópia dos dados.' : `Última cópia há ${dias} dias.`;
  $('#infoUltimaCopia').textContent = dados.ultimaCopia
    ? `Última cópia guardada: ${new Date(dados.ultimaCopia).toLocaleString('pt-PT')}`
    : 'Ainda não guardou nenhuma cópia.';
}

const porDataDesc = (a, b) => (b.data || '').localeCompare(a.data || '');
const btnEditar = (tipo, id) => `<button class="icone editar" data-tipo="${tipo}" data-id="${id}" aria-label="Editar">✏️</button>`;
const btnApagar = (tipo, id) => `<button class="icone apagar" data-tipo="${tipo}" data-id="${id}" aria-label="Apagar">🗑️</button>`;
const vazioMsg = (m) => `<div class="vazio">${m}</div>`;

function desenharListas() {
  // Viagens
  const precos = pode('precos');
  const vs = dados.viagens.filter((v) => noPeriodo(v.data)).sort(porDataDesc);
  $('#listaViagens').innerHTML = vs.length ? vs.map((v) => {
    const c = calcViagem(v);
    const rota = v.origem || v.destino ? `${esc(v.origem || '?')} → ${esc(v.destino || '?')}` : esc(v.cliente || 'Viagem');
    const detalhes = [dataPT(v.data), v.cliente && (v.origem || v.destino) ? esc(v.cliente) : '',
      c.kmTotal ? `${num(c.kmTotal)} km${N(v.kmVazio) ? ` (${num(v.kmVazio)} vazio)` : ''}` : '',
      precos && c.precoKm != null ? `${euro(c.precoKm)}/km` : '', precos && v.fatura ? 'Fat. ' + esc(v.fatura) : '',
      dados.carrinhas.length > 1 && v.carrinhaId ? esc(nomeCarrinha(v.carrinhaId)) : '',
      typeof Equipa !== 'undefined' ? Equipa.autor(v) : ''].filter(Boolean).join(' · ');
    const botoes = podeEditar('viagens', v) ? btnEditar('viagens', v.id) + btnApagar('viagens', v.id) : '';
    return `<div class="item"><div class="info">
        <div class="titulo">${rota}</div><div class="sub">${detalhes}</div>
        <div class="sub">${precos && c.aval ? `<span class="badge ${c.aval.cls}">${c.aval.txt}</span> ` : ''}
          ${precos ? `<button class="badge estado ${(ESTADO_UI[v.estado] || ESTADO_UI.Pendente)[0]}" data-id="${v.id}">${(ESTADO_UI[v.estado] || ESTADO_UI.Pendente)[1]}</button>` : ''}
          ${precos && v.faturaFicheiro ? `<button class="badge neutro abrirFatura" data-id="${v.id}">📄 Fatura${v.fatura ? ' ' + esc(v.fatura) : ''}</button>` : ''}
          ${v.notas ? ' ' + esc(v.notas) : ''}</div>
      </div>
      <div class="direita">${precos ? `<span class="valor">${euro(v.receita)}</span>
        <small class="${cls(c.lucro)}">lucro ${euro(c.lucro)}</small>` : `<span class="valor">${num(c.kmTotal)} km</span>`}
        <div>${botoes}</div></div></div>`;
  }).join('') : vazioMsg('Sem viagens neste período.');

  // Abastecimentos
  const ab = abastecimentosComDistancia().filter((a) => noPeriodo(a.data)).sort(porDataDesc);
  $('#listaAbastecer').innerHTML = ab.length ? ab.map((a) => `<div class="item"><div class="info">
      <div class="titulo">${esc(nomeCarrinha(a.carrinhaId))}</div>
      <div class="sub">${dataPT(a.data)} · ${num(a.km)} km · ${num(a.litros, 2)} L · ${a.litros ? euro(a.valor / a.litros) + '/L' : ''}
        ${a.temAnterior ? ` · +${num(a.dist)} km · <b>${num((a.litros / a.dist) * 100, 1)} L/100km</b>` : ''}</div></div>
      <div class="direita"><span class="valor negativo">${euro(a.valor)}</span>
        <div>${podeEditar('abastecimentos', a) ? btnEditar('abastecimentos', a.id) + btnApagar('abastecimentos', a.id) : ''}</div></div></div>`).join('')
    : vazioMsg('Sem abastecimentos neste período.');

  // Despesas
  const ds = dados.despesas.filter((d) => noPeriodo(d.data)).sort(porDataDesc);
  $('#listaDespesas').innerHTML = ds.length ? ds.map((d) => `<div class="item"><div class="info">
      <div class="titulo">${esc(d.categoria)}</div>
      <div class="sub">${dataPT(d.data)} · ${esc(nomeCarrinha(d.carrinhaId) || 'Geral')}${d.descricao ? ' · ' + esc(d.descricao) : ''}
        ${CATEGORIAS_RESERVA.includes(d.categoria) ? ' · <i>da reserva</i>' : ''}</div></div>
      <div class="direita"><span class="valor negativo">${euro(d.valor)}</span>
        <div>${podeEditar('despesas', d) ? btnEditar('despesas', d.id) + btnApagar('despesas', d.id) : ''}</div></div></div>`).join('')
    : vazioMsg('Sem despesas neste período.');

  // Carrinhas
  $('#listaCarrinhas').innerHTML = dados.carrinhas.length ? dados.carrinhas.map((c) => {
    const km = kmAtual(c.id);
    const docs = estadoDocs(c).map((d) => `<span class="badge ${d.cls}">${d.txt}</span>`).join('');
    return `<div class="item van"><div class="linha">
        <span class="placa"><i>P</i><span>${esc(c.matricula)}</span></span>
        <div>${pode('carrinhas_gerir') ? btnEditar('carrinhas', c.id) + btnApagar('carrinhas', c.id) : ''}</div></div>
      <div class="modelo">${esc(c.modelo || 'Modelo por indicar')}${km != null ? ' · ' + num(km) + ' km' : ''}</div>
      <div class="docs">${docs || '<span class="badge neutro">Sem datas registadas</span>'}</div></div>`;
  }).join('') : vazioMsg('Ainda não adicionou carrinhas.');
}

function desenharFixos() {
  $('#listaFixos').innerHTML = dados.custosFixos.map((f) => `<div class="fixo" data-id="${f.id}">
      <input class="fixoNome" data-campo="nome" value="${esc(f.nome)}" placeholder="Nome do custo" aria-label="Nome">
      <input data-campo="valor" type="number" step="0.01" inputmode="decimal" value="${f.valor}" aria-label="Valor (€)">
      <select data-campo="periodo" aria-label="Periodicidade">${Object.keys(DIVISOR)
        .map((k) => `<option ${k === f.periodo ? 'selected' : ''}>${k}</option>`).join('')}</select>
      ${btnApagar('custosFixos', f.id)}</div>`).join('') || vazioMsg('Sem custos fixos.');
  $('#totalFixos').textContent = euro(fixosMes());
}

function desenharParametros() {
  const form = $('#formParametros');
  Object.entries(P()).forEach(([k, v]) => { if (form.elements[k] && document.activeElement !== form.elements[k]) form.elements[k].value = v; });
  $('#custoOrdenado').textContent = euro(custoOrdenadoMes()) + ' por mês';
}

function desenhar() {
  preencherSelects();
  desenharPainel();
  desenharListas();
  desenharFixos();
  desenharParametros();
  atualizarPreview();
  if (typeof Equipa !== 'undefined') Equipa.desenhar();
}

/* ================= Navegação ================= */
$('#abas').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $$('#abas button').forEach((x) => x.classList.toggle('ativa', x === b));
  $$('.aba').forEach((s) => s.classList.toggle('ativa', s.id === b.dataset.aba));
  window.scrollTo(0, 0);
});
$('#filtroMes').value = mes;
$('#filtroMes').addEventListener('change', (e) => { mes = e.target.value; desenhar(); });
$('#btnTodos').addEventListener('click', () => { mes = ''; $('#filtroMes').value = ''; desenhar(); });
function irParaMes(m) { mes = m; $('#filtroMes').value = m; desenhar(); }
function mudarMes(delta) {
  const base = mes || hojeISO().slice(0, 7);
  const [a, m] = base.split('-').map(Number);
  const d = new Date(a, m - 1 + delta, 1);
  irParaMes(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
}
$('#mesAnt').addEventListener('click', () => mudarMes(-1));
$('#mesSeg').addEventListener('click', () => mudarMes(1));
$('#tabelaMeses').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-mes]');
  if (tr) { irParaMes(tr.dataset.mes); window.scrollTo(0, 0); }
});

/* ================= Formulários (novo + editar) ================= */
const FORMS = {};

function sairEdicao(form) {
  delete form.dataset.editId;
  if (form.id === 'formViagens') $('#faturaInfo').textContent = 'Fica guardada na internet. Depois basta tocar em "📄 Fatura" na viagem para a abrir.';
  form.reset();
  if (form.elements.data) form.elements.data.value = hojeISO();
  const t = form.querySelector('.tituloForm');
  if (t) t.textContent = t.dataset.novo;
  form.querySelector('.cancelar') && (form.querySelector('.cancelar').hidden = true);
}

function ligarFormulario(idForm, colecao, montar, msg) {
  const form = $(idForm);
  FORMS[colecao] = form;
  if (form.elements.data) form.elements.data.value = hojeISO();
  form.querySelector('.cancelar')?.addEventListener('click', () => { sairEdicao(form); desenhar(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const registo = montar(Object.fromEntries(new FormData(form)), form.dataset.editId);
    if (!registo) return;
    const editId = form.dataset.editId;
    if (editId) {
      const i = dados[colecao].findIndex((x) => x.id === editId);
      if (i >= 0) {
        const internos = Object.fromEntries(Object.entries(dados[colecao][i]).filter(([k]) => k.startsWith('_')));
        dados[colecao][i] = { ...internos, id: editId, ...registo };
      }
    } else {
      dados[colecao].push({ id: novoId(), _por: typeof Equipa !== 'undefined' ? Equipa.userId() : undefined, ...registo });
    }
    guardar();
    const carrinha = form.elements.carrinhaId?.value;
    sairEdicao(form);
    desenhar();
    if (carrinha !== undefined) form.elements.carrinhaId.value = carrinha;
    atualizarPreview();
    aviso(editId ? '✅ Alterações guardadas' : msg);
  });
}

function editar(tipo, id) {
  const form = FORMS[tipo];
  const reg = dados[tipo].find((x) => x.id === id);
  if (!form || !reg) return;
  form.reset();
  [...form.elements].forEach((el) => {
    if (!el.name || reg[el.name] === undefined || el.type === 'radio') return;
    el.value = reg[el.name] === 0 && el.type === 'number' && !el.required ? '' : reg[el.name] ?? '';
  });
  if (tipo === 'viagens') {
    const tp = reg.tipoPreco || (reg.precoKm != null ? 'km' : 'fechado');
    form.querySelector(`[name=tipoPreco][value=${tp}]`).checked = true;
    form.elements.receita.value = reg.receita || '';
  }
  if (tipo === 'viagens') {
    $('#faturaInfo').textContent = reg.faturaFicheiro
      ? `Fatura guardada: ${reg.faturaNome || 'ficheiro'}. Escolha outro ficheiro só se a quiser substituir.`
      : 'Ainda sem fatura. Escolha o PDF ou tire uma foto.';
  }
  form.dataset.editId = id;
  form.querySelector('.tituloForm').textContent = '✏️ A editar';
  form.querySelector('.cancelar').hidden = false;
  atualizarPreview();
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

ligarFormulario('#formViagens', 'viagens', (f, editId) => {
  const antigaV = editId ? dados.viagens.find((x) => x.id === editId) : null;
  if (!pode('precos')) {
    // Quem não vê preços (ex: condutor) regista só a viagem; os valores ficam para a contabilidade/logística.
    const base = antigaV || { tipoPreco: 'km', receita: 0, precoKm: null, estado: 'Pendente', fatura: '', faturaFicheiro: null, faturaNome: null };
    return {
      tipoPreco: base.tipoPreco, data: f.data, carrinhaId: f.carrinhaId || '', cliente: f.cliente.trim(), origem: f.origem.trim(),
      destino: f.destino.trim(), kmCarregado: N(f.kmCarregado), kmVazio: N(f.kmVazio), receita: N(base.receita), precoKm: base.precoKm ?? null,
      portagens: N(f.portagens), alimentacao: N(f.alimentacao), outros: N(f.outros), fatura: base.fatura || '', estado: base.estado || 'Pendente',
      notas: f.notas.trim(), faturaFicheiro: base.faturaFicheiro || null, faturaNome: base.faturaNome || null,
    };
  }
  const receita = receitaDoForm(f);
  if (receita <= 0) {
    aviso(f.tipoPreco === 'fechado' ? 'Escreva o valor acordado.' : 'Escreva os km carregados e o preço por km.');
    return null;
  }
  const id = editId || novoId();
  const antiga = editId ? dados.viagens.find((x) => x.id === editId) : null;
  const ficheiro = f.faturaFile && f.faturaFile.size ? f.faturaFile : null;
  if (ficheiro) {
    if (!Nuvem.user) { aviso('Para guardar a fatura, entre na conta em ⚙️ Mais.'); return null; }
    setTimeout(() => Nuvem.enviarFatura(id, ficheiro), 0);
  }
  return {
  id, tipoPreco: f.tipoPreco, data: f.data, carrinhaId: f.carrinhaId || '', cliente: f.cliente.trim(), origem: f.origem.trim(), destino: f.destino.trim(),
  kmCarregado: N(f.kmCarregado), kmVazio: N(f.kmVazio), receita, precoKm: f.tipoPreco === 'km' ? N(f.precoKm) : null,
  portagens: N(f.portagens), alimentacao: N(f.alimentacao), outros: N(f.outros),
  fatura: f.fatura.trim(), estado: f.estado, notas: f.notas.trim(),
  faturaFicheiro: antiga?.faturaFicheiro || null, faturaNome: antiga?.faturaNome || null,
  };
}, '🚚 Viagem guardada');

ligarFormulario('#formAbastecer', 'abastecimentos', (f, editId) => {
  if (!f.carrinhaId) { aviso('Adicione primeiro uma carrinha em ⚙️ Mais.'); return null; }
  const km = N(f.km);
  const outros = dados.abastecimentos.filter((a) => a.carrinhaId === f.carrinhaId && a.id !== editId);
  const ultimo = outros.length ? Math.max(...outros.map((a) => a.km)) : null;
  if (!editId && ultimo != null && km <= ultimo &&
      !confirm(`Os km (${num(km)}) são iguais ou inferiores ao último registo (${num(ultimo)}). Guardar mesmo assim?`)) return null;
  return { carrinhaId: f.carrinhaId, data: f.data, km, litros: N(f.litros), valor: N(f.valor) };
}, '⛽ Abastecimento guardado');

ligarFormulario('#formDespesas', 'despesas', (f) => ({
  carrinhaId: f.carrinhaId || '', data: f.data, categoria: f.categoria, valor: N(f.valor), descricao: f.descricao.trim(),
}), '💸 Despesa guardada');

ligarFormulario('#formCarrinhas', 'carrinhas', (f, editId) => {
  const matricula = f.matricula.trim().toUpperCase();
  if (dados.carrinhas.some((c) => c.matricula === matricula && c.id !== editId)) { aviso('Essa matrícula já existe.'); return null; }
  return { matricula, modelo: f.modelo.trim(), seguro: f.seguro, inspecao: f.inspecao, iuc: f.iuc,
    revisaoKm: f.revisaoKm === '' ? null : N(f.revisaoKm) };
}, '🚐 Carrinha guardada');

/* Pré-visualização da viagem (ver se uma carga compensa) */
// Receita conforme a forma de cobrar: km carregado × preço/km, ou valor acordado.
function receitaDoForm(f) {
  if (f.tipoPreco === 'fechado') return N(f.receita);
  return Math.round(N(f.kmCarregado) * N(f.precoKm) * 100) / 100;
}

function mostrarTipoPreco() {
  const form = $('#formViagens');
  const f = Object.fromEntries(new FormData(form));
  const fechado = f.tipoPreco === 'fechado';
  $('#campoPrecoKm').hidden = fechado;
  $('#campoReceita').hidden = !fechado;
  const kc = N(f.kmCarregado);
  const receita = receitaDoForm(f);
  let txt = '';
  if (!fechado && N(f.precoKm) > 0) {
    txt = kc > 0 ? `Receita: ${num(kc)} km × ${euro(N(f.precoKm))} = <b>${euro(receita)}</b>` : 'Escreva os km carregados para calcular a receita.';
  } else if (fechado && receita > 0) {
    txt = `Receita: <b>${euro(receita)}</b>${kc > 0 ? ` · equivale a <b>${euro(receita / kc)}</b> por km carregado` : ''}`;
  }
  $('#infoReceita').innerHTML = txt;
}

function atualizarPreview() {
  mostrarTipoPreco();
  const form = $('#formViagens');
  const f = Object.fromEntries(new FormData(form));
  f.receita = receitaDoForm(f);
  const el = $('#previewViagem');
  if (!N(f.receita) && !N(f.kmCarregado)) { el.innerHTML = ''; return; }
  const c = calcViagem(f);
  el.innerHTML = [
    c.precoKm != null ? `Preço por km carregado: <b>${euro(c.precoKm)}</b> (objetivo ${euro(P().precoObjetivo)})` : '',
    `Gasóleo estimado: <b>${euro(c.gasoleo)}</b> · Gastos totais: <b>${euro(c.gastos)}</b>`,
    c.minimoKm != null ? `Preço mínimo para não perder dinheiro: <b>${euro(c.minimoKm)}/km</b>` : '',
    `Lucro da viagem: <b class="${cls(c.lucro)}">${euro(c.lucro)}</b>${c.margem != null ? ` (${pct(c.margem)})` : ''}
      ${c.aval ? ` <span class="badge ${c.aval.cls}">${c.aval.txt}</span>` : ''}`,
  ].filter(Boolean).join('<br>');
}
$('#formViagens').addEventListener('input', atualizarPreview);

/* Custos fixos */
$('#listaFixos').addEventListener('change', (e) => {
  const linha = e.target.closest('.fixo');
  const campo = e.target.dataset.campo;
  if (!linha || !campo) return;
  const f = dados.custosFixos.find((x) => x.id === linha.dataset.id);
  f[campo] = campo === 'valor' ? N(e.target.value) : e.target.value;
  guardar(); desenhar();
});
$('#btnNovoFixo').addEventListener('click', () => {
  dados.custosFixos.push({ id: novoId(), nome: '', valor: 0, periodo: 'Mensal' });
  guardar(); desenhar();
  $('#listaFixos .fixo:last-child .fixoNome').focus();
});

/* Parâmetros */
$('#formParametros').addEventListener('change', (e) => {
  const { name, value, tagName } = e.target;
  if (!name) return;
  dados.parametros[name] = tagName === 'SELECT' ? value : N(value);
  guardar(); desenhar(); aviso('Parâmetros guardados');
});

/* ================= Cliques nas listas ================= */
document.addEventListener('click', (e) => {
  const estado = e.target.closest('.estado');
  if (estado && pode('precos')) {
    const v = dados.viagens.find((x) => x.id === estado.dataset.id);
    v.estado = ESTADOS[(ESTADOS.indexOf(v.estado) + 1) % ESTADOS.length];
    guardar(); desenhar(); aviso(v.estado === 'Pago' ? '✓ Marcada como paga' : v.estado === 'Pago 50%' ? '◐ Marcada como paga a 50%' : 'Marcada como por cobrar');
    return;
  }
  const fat = e.target.closest('.abrirFatura');
  if (fat) { Nuvem.abrirFatura(dados.viagens.find((x) => x.id === fat.dataset.id)); return; }
  const ed = e.target.closest('.editar');
  if (ed) { editar(ed.dataset.tipo, ed.dataset.id); return; }

  const b = e.target.closest('.apagar');
  if (!b) return;
  const { tipo, id } = b.dataset;
  if (tipo === 'carrinhas') {
    const usada = ['abastecimentos', 'despesas', 'viagens'].some((k) => dados[k].some((x) => x.carrinhaId === id));
    if (!confirm(usada ? 'Esta carrinha tem registos. Apagar a carrinha e os seus abastecimentos? (viagens e despesas ficam guardadas)' : 'Apagar esta carrinha?')) return;
    dados.abastecimentos = dados.abastecimentos.filter((a) => a.carrinhaId !== id);
    ['despesas', 'viagens'].forEach((k) => dados[k].forEach((x) => { if (x.carrinhaId === id) x.carrinhaId = ''; }));
  } else if (!confirm('Apagar este registo?')) return;
  if (tipo === 'viagens') { const v = dados.viagens.find((x) => x.id === id); if (v?.faturaFicheiro) Nuvem.apagarFatura(v.faturaFicheiro); }
  dados[tipo] = dados[tipo].filter((x) => x.id !== id);
  if (FORMS[tipo]?.dataset.editId === id) sairEdicao(FORMS[tipo]);
  guardar(); desenhar(); aviso('Apagado');
});

/* ================= Cópias e exportação ================= */
function descarregar(nome, conteudo, tipo) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nome });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

$$('.btnExportar').forEach((b) => b.addEventListener('click', () => {
  dados.ultimaCopia = new Date().toISOString();
  guardar();
  descarregar(`frota-copia-${hojeISO()}.json`, JSON.stringify(dados, null, 2), 'application/json');
  desenhar();
  aviso('💾 Cópia guardada');
}));

$('#ficheiroImportar').addEventListener('change', async (e) => {
  const ficheiro = e.target.files[0];
  e.target.value = '';
  if (!ficheiro) return;
  try {
    const d = JSON.parse(await ficheiro.text());
    if (!Array.isArray(d.carrinhas)) throw new Error('formato');
    if (!confirm('Isto substitui os dados atuais pelos da cópia. Continuar?')) return;
    dados = normalizar(d);
    guardar(); desenhar(); aviso('✅ Cópia carregada');
  } catch (err) { aviso('❌ Ficheiro inválido'); }
});

function csv(linhas) {
  const dec = (v) => (typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : v);
  return '﻿' + linhas.map((l) => l.map((c) => `"${String(dec(c) ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
}

$('#btnCsvViagens').addEventListener('click', () => {
  const linhas = [['Data', 'Semana do mês', 'Carrinha', 'Cliente', 'Origem (carga)', 'Destino (descarga)', 'Km carregado', 'Km em vazio',
    'Km total', 'Receita (€)', 'Gasóleo estimado (€)', 'Portagens (€)', 'Alimentação / Estadia (€)', 'Outros (€)', 'Gastos totais (€)',
    'LUCRO / PREJUÍZO (€)', 'Margem (%)', 'Preço por km carregado (€)', 'Preço mínimo (€/km)', 'Avaliação', 'Nº fatura', 'Estado pagamento', 'Notas']];
  dados.viagens.filter((v) => noPeriodo(v.data)).sort((a, b) => a.data.localeCompare(b.data)).forEach((v) => {
    const c = calcViagem(v);
    linhas.push([dataPT(v.data), semanaDoMes(v.data), nomeCarrinha(v.carrinhaId), v.cliente, v.origem, v.destino, N(v.kmCarregado), N(v.kmVazio),
      c.kmTotal, N(v.receita), c.gasoleo, N(v.portagens), N(v.alimentacao), N(v.outros), c.gastos, c.lucro,
      c.margem == null ? '' : c.margem * 100, c.precoKm ?? '', c.minimoKm ?? '', c.aval?.txt || '', v.fatura, v.estado, v.notas]);
  });
  descarregar(`viagens-${mes || 'tudo'}.csv`, csv(linhas), 'text/csv;charset=utf-8');
});

$('#btnCsvGastos').addEventListener('click', () => {
  const linhas = [['Tipo', 'Data', 'Carrinha', 'Categoria', 'Descrição', 'Km', 'Litros', 'Valor (€)']];
  dados.abastecimentos.filter((a) => noPeriodo(a.data)).forEach((a) =>
    linhas.push(['Abastecimento', dataPT(a.data), nomeCarrinha(a.carrinhaId), 'Gasóleo', '', a.km, a.litros, a.valor]));
  dados.despesas.filter((d) => noPeriodo(d.data)).forEach((d) =>
    linhas.push(['Despesa', dataPT(d.data), nomeCarrinha(d.carrinhaId) || 'Geral', d.categoria, d.descricao, '', '', d.valor]));
  dados.custosFixos.forEach((f) => linhas.push(['Custo fixo', '', '', f.periodo, f.nome, '', '', N(f.valor)]));
  descarregar(`gastos-${mes || 'tudo'}.csv`, csv(linhas), 'text/csv;charset=utf-8');
});

$('#btnApagarTudo').addEventListener('click', () => {
  if (!confirm('Apagar TODOS os dados (viagens, abastecimentos, despesas, carrinhas)? Guarde uma cópia antes!')) return;
  if (!confirm('Tem mesmo a certeza? Não dá para desfazer.')) return;
  dados = normalizar({ parametros: dados.parametros, custosFixos: dados.custosFixos });
  guardar(); desenhar(); aviso('Dados apagados');
});

/* ================= Internet (Supabase) ================= */
const Nuvem = {
  cliente: null, user: null, timer: null, aEnviar: false, estado: '', erro: '',
  recuperacao: /type=recovery/.test(location.hash), // veio do link do email de recuperação
  CH_EMAIL: 'frota-ultimo-email',

  configurado() {
    const c = window.FROTA_NUVEM || {};
    return !!(c.url && c.chave);
  },

  async iniciar() {
    if (!this.configurado()) return this.ui();
    if (!window.supabase) { this.estado = 'offline'; this.erro = 'Sem ligação à internet.'; return this.ui(); }
    this.cliente = window.supabase.createClient(window.FROTA_NUVEM.url, window.FROTA_NUVEM.chave);
    this.cliente.auth.onAuthStateChange((evento, sessao) => {
      const antes = this.user?.id;
      this.user = sessao?.user || null;
      if (evento === 'PASSWORD_RECOVERY') this.recuperacao = true;
      if (this.user?.email) { try { localStorage.setItem(this.CH_EMAIL, this.user.email); } catch (e) { /* */ } }
      if (this.recuperacao && this.user) setTimeout(() => this.mostrarNovaSenha(true), 200);
      if (this.user && this.user.id !== antes) setTimeout(() => Equipa.iniciar(this.user), 0);
      if (!this.user && antes) Equipa.sairDaEmpresa();
      this.ui(); desenharPainel();
    });
    const { data } = await this.cliente.auth.getSession();
    this.user = data.session?.user || null;
    this.ui();
    if (this.user) Equipa.iniciar(this.user);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.sincronizar(); });
    window.addEventListener('online', () => this.sincronizar());
  },

  agendar() {
    if (!this.user) return;
    clearTimeout(this.timer);
    this.estado = 'pendente'; this.ui();
    this.timer = setTimeout(() => this.sincronizar(), 1500);
  },

  async lerRemoto() {
    const { data, error } = await this.cliente.from('frota_dados').select('dados, atualizado').eq('user_id', this.user.id).maybeSingle();
    if (error) throw error;
    return data;
  },

  async enviar() {
    const { error } = await this.cliente.from('frota_dados')
      .upsert({ user_id: this.user.id, dados, atualizado: new Date().toISOString() });
    if (error) throw error;
    Sync.set({ base: dados.alterado, pendente: false, ultima: new Date().toISOString() });
  },

  usarRemoto(remoto) {
    dados = normalizar(remoto.dados);
    guardar(false);
    Sync.set({ base: remoto.dados.alterado || null, pendente: false, ultima: new Date().toISOString() });
    desenhar();
  },

  // Compara o que está aqui com o que está na internet e acerta os dois.
  async sincronizar() {
    if (!this.user || !this.cliente) return;
    if (Equipa.ativa()) return Equipa.sincronizar();
    if (Equipa.aIniciar) return; // ainda a ver se a conta pertence a uma empresa
    if (Equipa.iniciadoPara !== this.user.id) return Equipa.iniciar(this.user);
    if (this.aEnviar) { this.agendar(); return; }
    this.aEnviar = true; this.estado = 'a sincronizar'; this.ui();
    try {
      const remoto = await this.lerRemoto();
      const { base, pendente } = Sync.get();
      const nLocal = dados.viagens.length + dados.abastecimentos.length + dados.despesas.length + dados.carrinhas.length;
      if (!remoto) {
        await this.enviar();
      } else {
        const r = remoto.dados || {};
        const remotoMudou = (r.alterado || null) !== (base || null);
        const nRemoto = ['viagens', 'abastecimentos', 'despesas', 'carrinhas'].reduce((s, k) => s + ((r[k] || []).length), 0);
        if (!remotoMudou) {
          if (pendente) await this.enviar();
        } else if (!pendente || nLocal === 0) {
          this.usarRemoto(remoto);
        } else if (nRemoto === 0) {
          await this.enviar();
        } else if (confirm(`Há dados diferentes neste dispositivo e na internet.\n\n` +
            `Internet: ${(r.viagens || []).length} viagens\nEste dispositivo: ${dados.viagens.length} viagens\n\n` +
            `OK = ficar com os da INTERNET\nCancelar = ficar com os DESTE dispositivo`)) {
          this.usarRemoto(remoto);
        } else {
          await this.enviar();
        }
      }
      this.estado = 'ok'; this.erro = '';
    } catch (e) {
      this.estado = 'erro';
      this.erro = navigator.onLine === false ? 'Sem internet: os dados ficam guardados aqui e são enviados quando houver ligação.'
        : 'Não foi possível sincronizar (' + (e.message || e) + ').';
    } finally {
      this.aEnviar = false; this.ui();
    }
  },

  // ---- Faturas (Supabase Storage, bucket privado "faturas") ----
  async enviarFatura(viagemId, ficheiro) {
    if (!this.user) return;
    const ext = (ficheiro.name.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
    const caminho = `${Equipa.pasta('faturas')}/${viagemId}-${Date.now()}.${ext}`;
    aviso('📤 A enviar a fatura…');
    const { error } = await this.cliente.storage.from('faturas').upload(caminho, ficheiro, { contentType: ficheiro.type || undefined, upsert: true });
    if (error) { aviso('❌ A fatura não foi enviada: ' + error.message); return; }
    const v = dados.viagens.find((x) => x.id === viagemId);
    if (!v) return;
    const anterior = v.faturaFicheiro;
    v.faturaFicheiro = caminho; v.faturaNome = ficheiro.name;
    guardar(); desenhar(); aviso('📄 Fatura guardada');
    if (anterior && anterior !== caminho) this.apagarFatura(anterior);
  },

  async abrirFatura(v) {
    if (!v?.faturaFicheiro) return;
    if (!this.user) { aviso('Entre na conta em ⚙️ Mais para abrir faturas.'); return; }
    const janela = window.open('', '_blank'); // abre já (o iPhone bloqueia janelas abertas depois de esperar)
    const { data, error } = await this.cliente.storage.from('faturas').createSignedUrl(v.faturaFicheiro, 3600);
    if (error || !data?.signedUrl) { janela?.close(); aviso('❌ Não foi possível abrir a fatura.'); return; }
    if (janela) janela.location.href = data.signedUrl; else location.href = data.signedUrl;
  },

  async apagarFatura(caminho) {
    if (this.user && caminho) await this.cliente.storage.from('faturas').remove([caminho]);
  },

  async entrar(email, senha) {
    const { error } = await this.cliente.auth.signInWithPassword({ email, password: senha });
    if (error) aviso(/invalid/i.test(error.message) ? '❌ Email ou palavra-passe errados' : /confirm/i.test(error.message)
      ? '📧 Confirme primeiro o email (veja a caixa de correio)' : '❌ ' + error.message);
  },

  async criar(email, senha) {
    const { data, error } = await this.cliente.auth.signUp({ email, password: senha,
      options: { emailRedirectTo: location.href.split('#')[0] } });
    if (error) return aviso('❌ ' + error.message);
    if (!data.session) alert('Conta criada! Abra o email que recebeu e toque no link de confirmação. Depois volte aqui e toque em Entrar.');
  },

  ultimoEmail() { try { return localStorage.getItem(this.CH_EMAIL) || ''; } catch (e) { return ''; } },

  async esqueci(email) {
    if (!email) { aviso('Escreva primeiro o seu email (em cima).'); $('#nuvemEntrar').elements.email.focus(); return; }
    const { error } = await this.cliente.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) {
      aviso(/rate|seconds|limit/i.test(error.message) ? '⏳ Já foi pedido há pouco. Espere uns minutos e tente outra vez.' : '❌ ' + error.message);
      return;
    }
    alert(`📧 Enviámos um email para ${email}.\n\n1. Abra o email (veja também no Spam).\n2. Toque no link "Reset Password".\n` +
      `3. O site abre e pede a nova palavra-passe.\n\nSe não chegar nada em 5 minutos, confirme se o email está certo.`);
  },

  ajudaEmail() {
    const box = $('#ajudaEmail');
    const ultimo = this.ultimoEmail();
    box.innerHTML = (ultimo ? `Neste dispositivo a última conta usada foi <b>${esc(ultimo)}</b>.<br><br>` : '') +
      `Se não se lembrar do email:<br>• Procure no seu email uma mensagem do <b>Supabase</b> ("Confirm your signup"): foi enviada para o email da conta.<br>` +
      `• Ou entre em <b>supabase.com</b> (com o GitHub) → o seu projeto → <b>Authentication → Users</b>: aparecem todos os emails com conta.<br>` +
      `• Se perdeu o acesso ao próprio Gmail, recupere-o primeiro em <b>g.co/recover</b>.`;
    box.hidden = !box.hidden;
    if (ultimo && !$('#nuvemEntrar').elements.email.value) $('#nuvemEntrar').elements.email.value = ultimo;
  },

  mostrarNovaSenha(veioDoEmail) {
    $('#novaSenhaTitulo').textContent = veioDoEmail ? '🔑 Escolha a nova palavra-passe' : '🔑 Mudar palavra-passe';
    $('#nuvemNovaSenha').hidden = false;
    $('#abas button[data-aba="mais"]').click();
    setTimeout(() => { $('#nuvemNovaSenha').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#nuvemNovaSenha').elements.senha.focus(); }, 250);
  },

  async guardarNovaSenha(nova, confirmar) {
    if (nova !== confirmar) { aviso('❌ As duas palavras-passe não são iguais.'); return; }
    const { error } = await this.cliente.auth.updateUser({ password: nova });
    if (error) {
      aviso(/different|same/i.test(error.message) ? '❌ Tem de ser diferente da anterior.' : /session|auth/i.test(error.message)
        ? '❌ O link expirou. Peça outro em "Esqueci-me da palavra-passe".' : '❌ ' + error.message);
      return;
    }
    this.recuperacao = false;
    $('#nuvemNovaSenha').reset(); $('#nuvemNovaSenha').hidden = true;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    alert('✅ Palavra-passe alterada! Use a nova palavra-passe da próxima vez que entrar (também no ícone do ecrã principal).');
  },

  async sair() {
    if (!confirm('Sair da conta? Os dados continuam guardados na internet e neste dispositivo.')) return;
    await this.cliente.auth.signOut();
    Sync.set({ base: null, pendente: true });
  },

  ui() {
    const cfg = this.configurado();
    const ultimo = this.ultimoEmail();
    $('#ultimoEmail').hidden = !ultimo || !!this.user;
    $('#ultimoEmail').innerHTML = ultimo ? `Última conta neste dispositivo: <b>${esc(ultimo)}</b>` : '';
    const campoEmail = $('#nuvemEntrar').elements.email;
    if (ultimo && !campoEmail.value && document.activeElement !== campoEmail) campoEmail.value = ultimo;
    if (!this.user) $('#nuvemNovaSenha').hidden = true;
    $('#nuvemSemConfig').hidden = cfg;
    $('#nuvemEntrar').hidden = !cfg || !!this.user;
    $('#nuvemLigado').hidden = !this.user;
    $('#dicasLocal').hidden = !!this.user;
    const ind = $('#estadoNuvem');
    ind.hidden = !cfg;
    if (!cfg) return;
    let icone = '☁️', txt;
    if (!this.user) { icone = '☁️✕'; txt = 'Não tem sessão iniciada: os dados ficam só neste dispositivo.'; }
    else if (this.estado === 'erro' || this.estado === 'offline') { icone = '☁️⚠️'; txt = this.erro; }
    else if (this.estado === 'pendente' || this.estado === 'a sincronizar') { icone = '☁️⏳'; txt = 'A enviar para a internet…'; }
    else { icone = '☁️✓'; const u = Equipa.ativa() ? Equipa.ultima : Sync.get().ultima; txt = 'Tudo guardado na internet' + (u ? ' (' + new Date(u).toLocaleString('pt-PT') + ')' : '') + '.'; }
    ind.textContent = icone; ind.title = txt;
    if (this.user) { $('#nuvemEmail').textContent = this.user.email; $('#nuvemInfo').textContent = txt; }
  },
};

$('#estadoNuvem').addEventListener('click', () => {
  $('#abas button[data-aba="mais"]').click();
  aviso($('#estadoNuvem').title);
});
$('#nuvemEntrar').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  Nuvem.entrar(f.email.trim(), f.senha);
});
$('#nuvemCriar').addEventListener('click', () => {
  const form = $('#nuvemEntrar');
  if (!form.reportValidity()) return;
  Nuvem.criar(form.elements.email.value.trim(), form.elements.senha.value);
});
$('#nuvemEsqueci').addEventListener('click', () => Nuvem.esqueci($('#nuvemEntrar').elements.email.value.trim()));
$('#nuvemSemEmail').addEventListener('click', () => Nuvem.ajudaEmail());
$('#nuvemMudarSenha').addEventListener('click', () => Nuvem.mostrarNovaSenha(false));
$('#novaSenhaCancelar').addEventListener('click', () => { Nuvem.recuperacao = false; $('#nuvemNovaSenha').reset(); $('#nuvemNovaSenha').hidden = true; });
$('#nuvemNovaSenha').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  Nuvem.guardarNovaSenha(f.senha, f.confirmar);
});
$('#nuvemSync').addEventListener('click', () => Nuvem.sincronizar());
$('#nuvemSair').addEventListener('click', () => Nuvem.sair());

// (o arranque — desenhar() e Nuvem.iniciar() — está no fim de equipa.js)

// Permite abrir o site sem internet (cópia guardada no dispositivo).
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
