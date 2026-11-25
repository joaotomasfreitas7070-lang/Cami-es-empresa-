'use strict';

/* ============ Dados ============ */
const CHAVE = 'gestao-frota-v1';
const vazio = () => ({ carrinhas: [], abastecimentos: [], despesas: [], receitas: [] });

function carregar() {
  try {
    const d = JSON.parse(localStorage.getItem(CHAVE));
    return d ? { ...vazio(), ...d } : vazio();
  } catch (e) {
    return vazio();
  }
}
let dados = carregar();

function guardar() {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(dados));
  } catch (e) {
    aviso('⚠️ Não foi possível guardar neste navegador.');
  }
}

const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ============ Utilitários ============ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const euro = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });
const num = (v, casas = 0) =>
  new Intl.NumberFormat('pt-PT', { minimumFractionDigits: casas, maximumFractionDigits: casas }).format(v);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hoje = () => new Date().toISOString().slice(0, 10);
const dataPT = (d) => (d ? d.split('-').reverse().join('/') : '');

function nomeCarrinha(id) {
  if (!id) return 'Geral';
  const c = dados.carrinhas.find((x) => x.id === id);
  return c ? c.matricula + (c.modelo ? ' · ' + c.modelo : '') : '(apagada)';
}

let temporizadorAviso;
function aviso(texto) {
  const el = $('#aviso');
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => (el.hidden = true), 2200);
}

/* ============ Filtro por mês ============ */
let mes = new Date().toISOString().slice(0, 7); // '' = todos
const noPeriodo = (data) => !mes || (data || '').startsWith(mes);

/* ============ Cálculos ============ */
// Para cada carrinha, ordena os abastecimentos por km e calcula a distância
// desde o abastecimento anterior. Os litros de um abastecimento correspondem
// ao combustível gasto desde o anterior (método do depósito cheio).
function abastecimentosComDistancia() {
  const porCarrinha = {};
  dados.abastecimentos.forEach((a) => (porCarrinha[a.carrinhaId] ||= []).push(a));
  const resultado = [];
  Object.values(porCarrinha).forEach((lista) => {
    lista.sort((a, b) => a.km - b.km || a.data.localeCompare(b.data));
    lista.forEach((a, i) => {
      const anterior = lista[i - 1];
      const dist = anterior ? a.km - anterior.km : 0;
      resultado.push({ ...a, dist: dist > 0 ? dist : 0, temAnterior: !!anterior && dist > 0 });
    });
  });
  return resultado;
}

function resumo(carrinhaId /* undefined = todas */) {
  const filtra = (x) => noPeriodo(x.data) && (carrinhaId === undefined || x.carrinhaId === carrinhaId);
  const abast = abastecimentosComDistancia().filter(filtra);
  const receitas = dados.receitas.filter(filtra).reduce((s, r) => s + r.valor, 0);
  const outras = dados.despesas.filter(filtra).reduce((s, d) => s + d.valor, 0);
  const combustivel = abast.reduce((s, a) => s + a.valor, 0);
  const km = abast.reduce((s, a) => s + a.dist, 0);
  const litrosMedia = abast.filter((a) => a.temAnterior).reduce((s, a) => s + a.litros, 0);
  const media = km > 0 && litrosMedia > 0 ? (litrosMedia / km) * 100 : null;
  const despesas = combustivel + outras;
  return {
    receitas, despesas, combustivel, outras, km, media,
    lucro: receitas - despesas,
    custoKm: km > 0 ? despesas / km : null,
    litros: abast.reduce((s, a) => s + a.litros, 0),
  };
}

/* ============ Desenhar ============ */
function preencherSelects() {
  $$('.selCarrinha').forEach((sel) => {
    const atual = sel.value;
    let html = sel.classList.contains('comGeral') ? '<option value="">Geral (empresa)</option>' : '';
    if (!dados.carrinhas.length && !sel.classList.contains('comGeral')) {
      html = '<option value="">Adicione primeiro uma carrinha</option>';
    }
    html += dados.carrinhas.map((c) => `<option value="${c.id}">${esc(nomeCarrinha(c.id))}</option>`).join('');
    sel.innerHTML = html;
    if ([...sel.options].some((o) => o.value === atual)) sel.value = atual;
  });
}

const classeValor = (v) => (v >= 0 ? 'positivo' : 'negativo');
const mediaTxt = (m) => (m == null ? '—' : num(m, 1) + ' L/100km');

function desenharPainel() {
  const t = resumo();
  $('#totReceitas').textContent = euro.format(t.receitas);
  $('#totDespesas').textContent = euro.format(t.despesas);
  $('#totLucro').textContent = euro.format(t.lucro);
  $('#totLucro').className = classeValor(t.lucro);
  $('#totKm').textContent = num(t.km) + ' km';
  $('#totMedia').textContent = mediaTxt(t.media);
  $('#totCustoKm').textContent = t.custoKm == null ? '—' : euro.format(t.custoKm);

  const lista = $('#listaPainel');
  if (!dados.carrinhas.length) {
    lista.innerHTML = '<div class="vazio">Ainda não tem carrinhas. Vá a <b>🚐 Carrinhas</b> para adicionar.</div>';
  } else {
    lista.innerHTML = dados.carrinhas.map((c) => {
      const r = resumo(c.id);
      return `<div class="item carrinha-painel">
        <div class="linha"><span class="titulo">${esc(nomeCarrinha(c.id))}</span>
          <span class="valor ${classeValor(r.lucro)}">${euro.format(r.lucro)}</span></div>
        <div class="grelha">
          <div><small>Média</small><b>${mediaTxt(r.media)}</b></div>
          <div><small>Km</small><b>${num(r.km)}</b></div>
          <div><small>Custo/km</small><b>${r.custoKm == null ? '—' : euro.format(r.custoKm)}</b></div>
          <div><small>Receitas</small><b>${euro.format(r.receitas)}</b></div>
          <div><small>Combustível</small><b>${euro.format(r.combustivel)}</b></div>
          <div><small>Outras despesas</small><b>${euro.format(r.outras)}</b></div>
        </div></div>`;
    }).join('');
    const geral = resumo('');
    if (geral.receitas || geral.outras) {
      lista.innerHTML += `<div class="item"><div class="info"><div class="titulo">Geral (empresa)</div>
        <div class="sub">Receitas ${euro.format(geral.receitas)} · Despesas ${euro.format(geral.outras)}</div></div>
        <div class="valor ${classeValor(geral.lucro)}">${euro.format(geral.lucro)}</div></div>`;
    }
  }

  // Despesas por categoria
  const cats = { Combustível: t.combustivel };
  dados.despesas.filter((d) => noPeriodo(d.data)).forEach((d) => (cats[d.categoria] = (cats[d.categoria] || 0) + d.valor));
  const entradas = Object.entries(cats).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entradas.map(([, v]) => v), 1);
  $('#categoriasPainel').innerHTML = entradas.length
    ? entradas.map(([k, v]) => `<div class="barra-linha"><span>${esc(k)}</span>
        <div class="barra-fundo"><div class="barra" style="width:${(v / max) * 100}%"></div></div>
        <b>${euro.format(v)}</b></div>`).join('')
    : '<div class="vazio">Sem despesas neste período.</div>';
}

function itemHtml(tipo, id, titulo, sub, valor, classe = '') {
  return `<div class="item"><div class="info"><div class="titulo">${titulo}</div><div class="sub">${sub}</div></div>
    <div class="acoes"><span class="valor ${classe}">${valor}</span>
    <button class="apagar" data-tipo="${tipo}" data-id="${id}" title="Apagar" aria-label="Apagar">🗑️</button></div></div>`;
}

function listaOuVazio(itens, msg) {
  return itens.length ? itens.join('') : `<div class="vazio">${msg}</div>`;
}

const porDataDesc = (a, b) => b.data.localeCompare(a.data);

function desenharListas() {
  const abast = abastecimentosComDistancia().filter((a) => noPeriodo(a.data)).sort(porDataDesc);
  $('#listaAbastecer').innerHTML = listaOuVazio(abast.map((a) => {
    const media = a.temAnterior ? ` · <b>${num((a.litros / a.dist) * 100, 1)} L/100km</b>` : '';
    return itemHtml('abastecimentos', a.id, esc(nomeCarrinha(a.carrinhaId)),
      `${dataPT(a.data)} · ${num(a.km)} km · ${num(a.litros, 2)} L${a.temAnterior ? ' · +' + num(a.dist) + ' km' : ''}${media}`,
      euro.format(a.valor), 'negativo');
  }), 'Sem abastecimentos neste período.');

  $('#listaDespesas').innerHTML = listaOuVazio(
    dados.despesas.filter((d) => noPeriodo(d.data)).sort(porDataDesc).map((d) =>
      itemHtml('despesas', d.id, esc(d.categoria),
        `${dataPT(d.data)} · ${esc(nomeCarrinha(d.carrinhaId))}${d.descricao ? ' · ' + esc(d.descricao) : ''}`,
        euro.format(d.valor), 'negativo')),
    'Sem despesas neste período.');

  $('#listaReceitas').innerHTML = listaOuVazio(
    dados.receitas.filter((r) => noPeriodo(r.data)).sort(porDataDesc).map((r) =>
      itemHtml('receitas', r.id, esc(r.cliente),
        `${dataPT(r.data)} · ${esc(nomeCarrinha(r.carrinhaId))}${r.descricao ? ' · ' + esc(r.descricao) : ''}`,
        euro.format(r.valor), 'positivo')),
    'Sem receitas neste período.');

  $('#listaCarrinhas').innerHTML = listaOuVazio(
    dados.carrinhas.map((c) => {
      const n = dados.abastecimentos.filter((a) => a.carrinhaId === c.id);
      const ultimoKm = n.length ? Math.max(...n.map((a) => a.km)) : null;
      return itemHtml('carrinhas', c.id, esc(c.matricula),
        `${esc(c.modelo || 'Sem modelo')}${ultimoKm != null ? ' · ' + num(ultimoKm) + ' km' : ''}`, '');
    }),
    'Ainda não adicionou carrinhas.');
}

function desenhar() {
  preencherSelects();
  desenharPainel();
  desenharListas();
}

/* ============ Navegação ============ */
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

/* ============ Formulários ============ */
function ligarFormulario(idForm, colecao, montar, msg) {
  const form = $(idForm);
  const dataInput = form.querySelector('[name="data"]');
  if (dataInput) dataInput.value = hoje();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const registo = montar(f);
    if (!registo) return;
    dados[colecao].push({ id: novoId(), ...registo });
    guardar();
    const carrinha = form.querySelector('[name="carrinhaId"]')?.value;
    form.reset();
    if (dataInput) dataInput.value = hoje();
    desenhar();
    if (carrinha !== undefined) form.querySelector('[name="carrinhaId"]').value = carrinha;
    aviso(msg);
  });
}

ligarFormulario('#formAbastecer', 'abastecimentos', (f) => {
  if (!f.carrinhaId) { aviso('Adicione primeiro uma carrinha.'); return null; }
  const km = Number(f.km);
  const anteriores = dados.abastecimentos.filter((a) => a.carrinhaId === f.carrinhaId);
  const ultimo = anteriores.length ? Math.max(...anteriores.map((a) => a.km)) : null;
  if (ultimo != null && km <= ultimo &&
      !confirm(`Os km (${num(km)}) são iguais ou inferiores ao último registo (${num(ultimo)}). Guardar mesmo assim?`)) {
    return null;
  }
  return { carrinhaId: f.carrinhaId, data: f.data, km, litros: Number(f.litros), valor: Number(f.valor) };
}, '⛽ Abastecimento guardado');

ligarFormulario('#formDespesas', 'despesas', (f) => ({
  carrinhaId: f.carrinhaId, data: f.data, categoria: f.categoria, valor: Number(f.valor), descricao: f.descricao.trim(),
}), '💸 Despesa guardada');

ligarFormulario('#formReceitas', 'receitas', (f) => ({
  carrinhaId: f.carrinhaId, data: f.data, cliente: f.cliente.trim(), valor: Number(f.valor), descricao: f.descricao.trim(),
}), '💰 Receita guardada');

ligarFormulario('#formCarrinhas', 'carrinhas', (f) => {
  const matricula = f.matricula.trim().toUpperCase();
  if (dados.carrinhas.some((c) => c.matricula === matricula)) { aviso('Essa matrícula já existe.'); return null; }
  return { matricula, modelo: f.modelo.trim() };
}, '🚐 Carrinha adicionada');

/* ============ Apagar ============ */
document.addEventListener('click', (e) => {
  const b = e.target.closest('.apagar');
  if (!b) return;
  const { tipo, id } = b.dataset;
  if (tipo === 'carrinhas') {
    const usada = ['abastecimentos', 'despesas', 'receitas'].some((k) => dados[k].some((x) => x.carrinhaId === id));
    const msg = usada
      ? 'Esta carrinha tem registos. Apagar a carrinha E todos os seus abastecimentos? (despesas e receitas passam para "Geral")'
      : 'Apagar esta carrinha?';
    if (!confirm(msg)) return;
    dados.abastecimentos = dados.abastecimentos.filter((a) => a.carrinhaId !== id);
    ['despesas', 'receitas'].forEach((k) => dados[k].forEach((x) => { if (x.carrinhaId === id) x.carrinhaId = ''; }));
  } else if (!confirm('Apagar este registo?')) {
    return;
  }
  dados[tipo] = dados[tipo].filter((x) => x.id !== id);
  guardar();
  desenhar();
  aviso('Apagado');
});

/* ============ Cópia de segurança ============ */
function descarregar(nome, conteudo, tipo) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nome });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#btnExportar').addEventListener('click', () => {
  descarregar(`frota-copia-${hoje()}.json`, JSON.stringify(dados, null, 2), 'application/json');
});

$('#ficheiroImportar').addEventListener('change', async (e) => {
  const ficheiro = e.target.files[0];
  e.target.value = '';
  if (!ficheiro) return;
  try {
    const d = JSON.parse(await ficheiro.text());
    if (!Array.isArray(d.carrinhas)) throw new Error('formato');
    if (!confirm('Isto substitui os dados atuais pelos da cópia. Continuar?')) return;
    dados = { ...vazio(), ...d };
    guardar();
    desenhar();
    aviso('✅ Cópia carregada');
  } catch (err) {
    aviso('❌ Ficheiro inválido');
  }
});

$('#btnCsv').addEventListener('click', () => {
  const linhas = [['Tipo', 'Data', 'Carrinha', 'Categoria/Cliente', 'Descrição', 'Km', 'Litros', 'Valor (€)']];
  const dec = (v) => String(v).replace('.', ',');
  dados.abastecimentos.filter((a) => noPeriodo(a.data)).forEach((a) =>
    linhas.push(['Abastecimento', a.data, nomeCarrinha(a.carrinhaId), 'Combustível', '', a.km, dec(a.litros), dec(-a.valor)]));
  dados.despesas.filter((d) => noPeriodo(d.data)).forEach((d) =>
    linhas.push(['Despesa', d.data, nomeCarrinha(d.carrinhaId), d.categoria, d.descricao, '', '', dec(-d.valor)]));
  dados.receitas.filter((r) => noPeriodo(r.data)).forEach((r) =>
    linhas.push(['Receita', r.data, nomeCarrinha(r.carrinhaId), r.cliente, r.descricao, '', '', dec(r.valor)]));
  const csv = linhas.map((l) => l.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  descarregar(`frota-${mes || 'tudo'}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
});

desenhar();
