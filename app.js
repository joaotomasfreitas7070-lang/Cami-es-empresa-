'use strict';

/* ================= Dados ================= */
const CHAVE = 'gestao-frota-v1';

const PARAMETROS_BASE = {
  precoObjetivo: 0.85, reserva: 0.10, consumo: 11, precoGasoleo: 2.10,
  ordenado: 1000, ss: 11, irs: 15, encargos: 25.675, subsidios: '1',
};
const FIXOS_BASE = [
  ['Seguro da carrinha', 200], ['Seguro de mercadorias (CMR)', 0], ['IUC', 12], ['Inspeção periódica', 8],
  ['Contabilista', 80], ['Wtransnet (cargas)', 40], ['Claude Pro', 22], ['Outros fixos', 50],
];
const CATEGORIAS_RESERVA = ['Manutenção / revisão', 'Pneus', 'Avaria / reparação', 'Manutenção'];

const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function normalizar(d) {
  d = d && typeof d === 'object' ? d : {};
  const out = {
    carrinhas: d.carrinhas || [], viagens: d.viagens || [], abastecimentos: d.abastecimentos || [],
    despesas: d.despesas || [],
    custosFixos: d.custosFixos || FIXOS_BASE.map(([nome, valor]) => ({ id: novoId(), nome, valor, periodo: 'Mensal' })),
    parametros: { ...PARAMETROS_BASE, ...(d.parametros || {}) },
    ultimaCopia: d.ultimaCopia || null,
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

function guardar() {
  try { localStorage.setItem(CHAVE, JSON.stringify(dados)); } catch (e) { aviso('⚠️ Não foi possível guardar neste navegador.'); }
}
guardar();
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
    if (v.estado !== 'Pago') r.porCobrar += N(v.receita);
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

function desenharPainel() {
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
  const mostrar = total >= 3 && (dias == null || dias >= 7);
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
  const vs = dados.viagens.filter((v) => noPeriodo(v.data)).sort(porDataDesc);
  $('#listaViagens').innerHTML = vs.length ? vs.map((v) => {
    const c = calcViagem(v);
    const rota = v.origem || v.destino ? `${esc(v.origem || '?')} → ${esc(v.destino || '?')}` : esc(v.cliente || 'Viagem');
    const detalhes = [dataPT(v.data), v.cliente && (v.origem || v.destino) ? esc(v.cliente) : '',
      c.kmTotal ? `${num(c.kmTotal)} km${N(v.kmVazio) ? ` (${num(v.kmVazio)} vazio)` : ''}` : '',
      c.precoKm != null ? `${euro(c.precoKm)}/km` : '', v.fatura ? 'Fat. ' + esc(v.fatura) : '',
      dados.carrinhas.length > 1 && v.carrinhaId ? esc(nomeCarrinha(v.carrinhaId)) : ''].filter(Boolean).join(' · ');
    return `<div class="item"><div class="info">
        <div class="titulo">${rota}</div><div class="sub">${detalhes}</div>
        <div class="sub">${c.aval ? `<span class="badge ${c.aval.cls}">${c.aval.txt}</span> ` : ''}
          <button class="badge estado ${v.estado === 'Pago' ? 'ok' : 'mau'}" data-id="${v.id}">${v.estado === 'Pago' ? '✓ Pago' : '⏳ Por cobrar'}</button>
          ${v.notas ? ' ' + esc(v.notas) : ''}</div>
      </div>
      <div class="direita"><span class="valor">${euro(v.receita)}</span>
        <small class="${cls(c.lucro)}">lucro ${euro(c.lucro)}</small>
        <div>${btnEditar('viagens', v.id)}${btnApagar('viagens', v.id)}</div></div></div>`;
  }).join('') : vazioMsg('Sem viagens neste período.');

  // Abastecimentos
  const ab = abastecimentosComDistancia().filter((a) => noPeriodo(a.data)).sort(porDataDesc);
  $('#listaAbastecer').innerHTML = ab.length ? ab.map((a) => `<div class="item"><div class="info">
      <div class="titulo">${esc(nomeCarrinha(a.carrinhaId))}</div>
      <div class="sub">${dataPT(a.data)} · ${num(a.km)} km · ${num(a.litros, 2)} L · ${a.litros ? euro(a.valor / a.litros) + '/L' : ''}
        ${a.temAnterior ? ` · +${num(a.dist)} km · <b>${num((a.litros / a.dist) * 100, 1)} L/100km</b>` : ''}</div></div>
      <div class="direita"><span class="valor negativo">${euro(a.valor)}</span>
        <div>${btnEditar('abastecimentos', a.id)}${btnApagar('abastecimentos', a.id)}</div></div></div>`).join('')
    : vazioMsg('Sem abastecimentos neste período.');

  // Despesas
  const ds = dados.despesas.filter((d) => noPeriodo(d.data)).sort(porDataDesc);
  $('#listaDespesas').innerHTML = ds.length ? ds.map((d) => `<div class="item"><div class="info">
      <div class="titulo">${esc(d.categoria)}</div>
      <div class="sub">${dataPT(d.data)} · ${esc(nomeCarrinha(d.carrinhaId) || 'Geral')}${d.descricao ? ' · ' + esc(d.descricao) : ''}
        ${CATEGORIAS_RESERVA.includes(d.categoria) ? ' · <i>da reserva</i>' : ''}</div></div>
      <div class="direita"><span class="valor negativo">${euro(d.valor)}</span>
        <div>${btnEditar('despesas', d.id)}${btnApagar('despesas', d.id)}</div></div></div>`).join('')
    : vazioMsg('Sem despesas neste período.');

  // Carrinhas
  $('#listaCarrinhas').innerHTML = dados.carrinhas.length ? dados.carrinhas.map((c) => {
    const kms = dados.abastecimentos.filter((a) => a.carrinhaId === c.id).map((a) => a.km);
    return `<div class="item"><div class="info"><div class="titulo">${esc(c.matricula)}</div>
      <div class="sub">${esc(c.modelo || 'Sem modelo')}${kms.length ? ' · ' + num(Math.max(...kms)) + ' km' : ''}</div></div>
      <div class="direita">${btnApagar('carrinhas', c.id)}</div></div>`;
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
      if (i >= 0) dados[colecao][i] = { id: editId, ...registo };
    } else {
      dados[colecao].push({ id: novoId(), ...registo });
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
    if (el.name && reg[el.name] !== undefined) el.value = reg[el.name] === 0 && el.type === 'number' && !el.required ? '' : reg[el.name];
  });
  if (tipo === 'viagens' && form.elements.precoKm.value === '' && N(reg.kmCarregado) > 0) {
    form.elements.precoKm.value = Math.round((N(reg.receita) / N(reg.kmCarregado)) * 1000) / 1000;
  }
  form.dataset.editId = id;
  form.querySelector('.tituloForm').textContent = '✏️ A editar';
  form.querySelector('.cancelar').hidden = false;
  atualizarPreview();
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

ligarFormulario('#formViagens', 'viagens', (f) => ({
  data: f.data, carrinhaId: f.carrinhaId || '', cliente: f.cliente.trim(), origem: f.origem.trim(), destino: f.destino.trim(),
  kmCarregado: N(f.kmCarregado), kmVazio: N(f.kmVazio), receita: N(f.receita), precoKm: f.precoKm === '' ? null : N(f.precoKm),
  portagens: N(f.portagens), alimentacao: N(f.alimentacao), outros: N(f.outros),
  fatura: f.fatura.trim(), estado: f.estado, notas: f.notas.trim(),
}), '🚚 Viagem guardada');

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

$('#formCarrinhas').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const matricula = f.matricula.trim().toUpperCase();
  if (dados.carrinhas.some((c) => c.matricula === matricula)) { aviso('Essa matrícula já existe.'); return; }
  dados.carrinhas.push({ id: novoId(), matricula, modelo: f.modelo.trim() });
  guardar(); e.target.reset(); desenhar(); aviso('🚐 Carrinha adicionada');
});

/* Pré-visualização da viagem (ver se uma carga compensa) */
function atualizarPreview() {
  const form = $('#formViagens');
  const f = Object.fromEntries(new FormData(form));
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
$('#formViagens').addEventListener('input', (e) => {
  const el = $('#formViagens').elements;
  const kc = N(el.kmCarregado.value);
  if ((e.target.name === 'precoKm' || e.target.name === 'kmCarregado') && el.precoKm.value !== '' && kc > 0) {
    el.receita.value = (Math.round(kc * N(el.precoKm.value) * 100) / 100).toFixed(2);
  } else if (e.target.name === 'receita') {
    el.precoKm.value = kc > 0 && el.receita.value !== '' ? Math.round((N(el.receita.value) / kc) * 1000) / 1000 : '';
  }
  atualizarPreview();
});

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
  if (estado) {
    const v = dados.viagens.find((x) => x.id === estado.dataset.id);
    v.estado = v.estado === 'Pago' ? 'Pendente' : 'Pago';
    guardar(); desenhar(); aviso(v.estado === 'Pago' ? '✓ Marcada como paga' : 'Marcada como por cobrar');
    return;
  }
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

desenhar();
