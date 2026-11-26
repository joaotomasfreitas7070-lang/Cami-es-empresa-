'use strict';
/* =====================================================================
   Salários (fichas, processamento mensal, recibos), Escalas e turnos,
   Clientes e Relatórios em PDF.
   Salários: ordenado fixo + horas extra, 14 ordenados, sem km nem ajudas
   de custo. Quem vê o quê é decidido na base de dados (equipa-3.sql).
   ===================================================================== */

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const pad2 = (n) => String(n).padStart(2, '0');
const isoLocal = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const somaDias = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoLocal(d); };
const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const nomeMes = (m) => { const [a, mm] = m.split('-'); return `${MESES[Number(mm) - 1]} ${a}`; };
const membroPorId = (id) => (typeof Equipa !== 'undefined' ? Equipa.membros.find((m) => m.id === id) : null);

/* ===================== SALÁRIOS ===================== */
const SAL_PARAM_ID = 'sal-parametros';
const SAL_BASE = {
  salarioMinimo: 920, saPadrao: 6, ssEmpresa: 23.75, ssTrabalhador: 11, fct: 1, seguroAT: 1,
  multHe1: 1.25, multHe2: 1.375, multHeDescanso: 1.5, mesSubFerias: 6, mesSubNatal: 12,
};
const CATEGORIA_POR_PAPEL = {
  condutor: 'Motorista de ligeiros', mecanico: 'Mecânico', rh: 'Administrativo(a)', contabilidade: 'Administrativo(a)',
  logistica: 'Técnico(a) de logística', marketing: 'Técnico(a) de marketing', patrao: 'Gerente',
};

const Salarios = {
  aberto: null,

  param() { return { ...SAL_BASE, ...(dados.salarios.find((x) => x.id === SAL_PARAM_ID) || {}) }; },
  fichas() { return dados.salarios.filter((x) => x.id !== SAL_PARAM_ID); },
  fichaDe(membroId) { return this.fichas().find((f) => f.membroId === membroId); },
  mesAtual() { return mes || hojeISO().slice(0, 7); },
  limitesMes(m) {
    const [a, mm] = m.split('-').map(Number);
    return { ini: `${m}-01`, fim: `${m}-${pad2(new Date(a, mm, 0).getDate())}`, mm };
  },

  // Ordenado fixo + horas extra; 14 ordenados (subsídios nos meses definidos); sem km/ajudas de custo.
  calc(p, f = this.fichaDe(p.membroId), q = this.param()) {
    const base = N(p.base ?? f?.ordenadoBase);
    const horas = N(f?.horasSemana) || 40;
    const valorHora = base * 12 / (52 * horas);
    const he = N(p.he1) * valorHora * q.multHe1 + N(p.he2) * valorHora * q.multHe2 + N(p.heDescanso) * valorHora * q.multHeDescanso;
    const descFaltas = base / 30 * N(p.faltas);
    const subF = N(p.subFerias), subN = N(p.subNatal), outros = N(p.outros);
    const bruto = r2(base - descFaltas + he + subF + subN + outros);
    const saDia = f?.subsidioAlimentacao ?? q.saPadrao;
    const sa = r2(N(p.diasTrabalhados) * N(saDia));
    const ssTrab = r2(bruto * N(q.ssTrabalhador) / 100), irs = r2(bruto * N(f?.taxaIrs) / 100);
    const ssEmp = r2(bruto * N(q.ssEmpresa) / 100), fct = r2(bruto * N(q.fct) / 100), seg = r2(bruto * N(q.seguroAT) / 100);
    const adiant = N(p.adiantamento);
    return {
      base, valorHora: r2(valorHora), he: r2(he), descFaltas: r2(descFaltas), subF, subN, outros, bruto, sa, saDia: N(saDia),
      ssTrab, irs, taxaIrs: N(f?.taxaIrs), ssEmp, fct, seg, adiant,
      liquido: r2(bruto - ssTrab - irs + sa - adiant), custo: r2(bruto + ssEmp + fct + seg + sa),
    };
  },
  valores(p) { return ['Fechado', 'Pago'].includes(p.estado) && p.valores ? p.valores : this.calc(p); },
  custoPeriodo() {
    return (dados.processamentos || []).filter((p) => noPeriodo(p.mes + '-01')).reduce((s, p) => s + N(this.valores(p).custo), 0);
  },

  // Dias trabalhados sugeridos: dias úteis do mês − ausências aprovadas (férias, folgas, baixas…).
  diasSugeridos(m, membro) {
    const { ini, fim } = this.limitesMes(m);
    const uteis = diasUteis(ini, fim);
    const aus = membro?.user_id ? dados.ferias.filter((x) => x.estado === 'Aprovado' && x._por === membro.user_id && x.inicio <= fim && x.fim >= ini)
      .reduce((s, x) => s + diasUteis(x.inicio > ini ? x.inicio : ini, x.fim < fim ? x.fim : fim), 0) : 0;
    return Math.max(0, uteis - aus);
  },

  novo(m, membro) {
    const f = this.fichaDe(membro.id), q = this.param(), { mm } = this.limitesMes(m);
    return {
      id: `proc-${m}-${membro.id}`, _por: Equipa.userId(), membroId: membro.id, userId: membro.user_id || null, nome: membro.nome, mes: m,
      base: N(f.ordenadoBase), diasTrabalhados: this.diasSugeridos(m, membro), faltas: 0, he1: 0, he2: 0, heDescanso: 0,
      subFerias: mm === Number(q.mesSubFerias) ? N(f.ordenadoBase) : 0, subNatal: mm === Number(q.mesSubNatal) ? N(f.ordenadoBase) : 0,
      outros: 0, adiantamento: 0, notas: '', estado: 'Rascunho',
    };
  },

  prepararMes() {
    const m = this.mesAtual();
    let n = 0;
    this.fichas().forEach((f) => {
      const membro = membroPorId(f.membroId);
      if (!membro || dados.processamentos.some((p) => p.mes === m && p.membroId === f.membroId)) return;
      dados.processamentos.push(this.novo(m, membro)); n++;
    });
    if (!this.fichas().length) { aviso('Crie primeiro as fichas das pessoas (em baixo).'); return; }
    guardar(); desenhar();
    aviso(n ? `✅ ${nomeMes(m)} preparado para ${n} pessoa${n > 1 ? 's' : ''}` : 'Este mês já estava preparado.');
  },

  criarFichasEmFalta() {
    const q = this.param();
    let n = 0;
    Equipa.membros.forEach((m) => {
      if (this.fichaDe(m.id)) return;
      dados.salarios.push({
        id: `sal-${m.id}`, _por: Equipa.userId(), membroId: m.id, userId: m.user_id || null, nome: m.nome,
        categoria: CATEGORIA_POR_PAPEL[m.papel] || '', ordenadoBase: q.salarioMinimo, taxaIrs: 0, subsidioAlimentacao: q.saPadrao,
        horasSemana: 40, tipoContrato: 'Sem termo', dataAdmissao: m.data_entrada || '', nif: '', niss: '', iban: '', notas: '',
      });
      n++;
    });
    guardar(); desenhar();
    aviso(n ? `✅ ${n} ficha${n > 1 ? 's' : ''} criada${n > 1 ? 's' : ''} com o ordenado mínimo (${euro(q.salarioMinimo)})` : 'Todas as pessoas já têm ficha.');
  },

  // Mantém o userId das fichas/recibos ligado à conta da pessoa (para ela ver os seus recibos).
  ligarContas() {
    if (!Equipa.pode('salarios')) return false;
    let mudou = false;
    [...this.fichas(), ...dados.processamentos.filter((p) => p.estado === 'Rascunho')].forEach((r) => {
      const m = membroPorId(r.membroId);
      if (m && m.user_id && r.userId !== m.user_id) { r.userId = m.user_id; mudou = true; }
    });
    return mudou;
  },

  linhasRecibo(v) {
    const l = (a, b, c = '') => `<div class="l ${c}"><span>${a}</span><b>${b}</b></div>`;
    return `<h4>Abonos</h4>${l('Ordenado base', euro(v.base))}
      ${v.he ? l(`Horas extra (${euro(v.valorHora)}/h)`, euro(v.he)) : ''}${v.subF ? l('Subsídio de férias', euro(v.subF)) : ''}
      ${v.subN ? l('Subsídio de Natal', euro(v.subN)) : ''}${v.outros ? l('Outros', euro(v.outros)) : ''}
      ${v.descFaltas ? l('− Faltas', '−' + euro(v.descFaltas)) : ''}${l('Remuneração bruta', euro(v.bruto), 'forte')}
      <h4>Descontos</h4>${l(`Segurança Social (${num(this.param().ssTrabalhador, 2)} %)`, '−' + euro(v.ssTrab))}
      ${l(`IRS (${num(v.taxaIrs, 1)} %)`, '−' + euro(v.irs))}${v.adiant ? l('Adiantamento', '−' + euro(v.adiant)) : ''}
      ${v.sa ? `<h4>Não sujeito</h4>${l(`Subsídio de alimentação (${euro(v.saDia)}/dia)`, euro(v.sa))}` : ''}
      ${l('💶 Total a receber', euro(v.liquido), 'forte')}
      ${l('Custo para a empresa', euro(v.custo))}`;
  },

  abrir(id) {
    const p = dados.processamentos.find((x) => x.id === id);
    if (!p) return;
    this.aberto = id;
    const form = $('#formProcessamento');
    form.hidden = false;
    ['diasTrabalhados', 'faltas', 'he1', 'he2', 'heDescanso', 'subFerias', 'subNatal', 'outros', 'adiantamento', 'notas']
      .forEach((k) => { form.elements[k].value = p[k] === 0 ? '' : (p[k] ?? ''); });
    this.desenharEditor();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  doForm(p) {
    const f = Object.fromEntries(new FormData($('#formProcessamento')));
    return { ...p, diasTrabalhados: N(f.diasTrabalhados), faltas: N(f.faltas), he1: N(f.he1), he2: N(f.he2), heDescanso: N(f.heDescanso),
      subFerias: N(f.subFerias), subNatal: N(f.subNatal), outros: N(f.outros), adiantamento: N(f.adiantamento), notas: (f.notas || '').trim() };
  },
  desenharEditor() {
    const p = dados.processamentos.find((x) => x.id === this.aberto);
    const form = $('#formProcessamento');
    if (!p) { form.hidden = true; return; }
    const rasc = p.estado === 'Rascunho';
    const v = rasc ? this.calc(this.doForm(p)) : this.valores(p);
    const [ecls] = { Rascunho: ['medio'], Fechado: ['ok'], Pago: ['ok'] }[p.estado] || ['neutro'];
    $('#procTitulo').innerHTML = `${esc(p.nome)} · ${nomeMes(p.mes)} <span class="badge ${ecls}">${p.estado}</span>`;
    [...form.elements].forEach((el) => { if (el.name) el.disabled = !rasc; });
    form.querySelector('button[type=submit]').hidden = !rasc;
    $('#procFechar').hidden = !rasc;
    $('#procPago').hidden = p.estado !== 'Fechado';
    $('#procReabrir').hidden = rasc;
    $('#reciboPreview').innerHTML = this.linhasRecibo(v);
  },

  desenhar() {
    const m = this.mesAtual(), q = this.param(), { mm } = this.limitesMes(m);
    $('#salMesTitulo').textContent = nomeMes(m);
    $('#salMesFerias').textContent = MESES[q.mesSubFerias - 1];
    $('#salMesNatal').textContent = MESES[q.mesSubNatal - 1];
    if (this.ligarContas()) guardar();

    const procs = dados.processamentos.filter((p) => p.mes === m).sort((a, b) => a.nome.localeCompare(b.nome));
    const tot = { bruto: 0, liquido: 0, custo: 0 };
    let linhas = procs.map((p) => {
      const v = this.valores(p);
      tot.bruto += v.bruto; tot.liquido += v.liquido; tot.custo += v.custo;
      const e = { Rascunho: '<span class="badge medio">Rascunho</span>', Fechado: '<span class="badge ok">Fechado</span>', Pago: '<span class="badge ok">✓ Pago</span>' }[p.estado] || '';
      return `<tr data-proc="${p.id}"><td>${esc(p.nome)}${p.he1 || p.he2 || p.heDescanso ? ' <small>⏱</small>' : ''}</td><td>${euro(v.bruto)}</td>
        <td><b>${euro(v.liquido)}</b></td><td>${euro(v.custo)}</td><td class="estado-sal">${e}</td></tr>`;
    }).join('');
    const semProc = this.fichas().filter((f) => !procs.some((p) => p.membroId === f.membroId));
    if (semProc.length) linhas += `<tr><td colspan="5" class="ajuda">Por preparar: ${semProc.map((f) => esc(f.nome)).join(', ')}</td></tr>`;
    $('#tabelaSalarios').innerHTML = procs.length || semProc.length
      ? `<tr><th>Pessoa</th><th>Bruto</th><th>A receber</th><th>Custo</th><th>Estado</th></tr>${linhas}
         ${procs.length ? `<tr class="total"><td>Total</td><td>${euro(tot.bruto)}</td><td>${euro(tot.liquido)}</td><td>${euro(tot.custo)}</td><td></td></tr>` : ''}`
      : '<tr><td class="ajuda">Ainda não há fichas. Crie-as em baixo e depois toque em "Preparar o mês".</td></tr>';
    $('#salCartoes').innerHTML = `
      <div class="cartao"><small>Bruto</small><strong>${euro(tot.bruto)}</strong></div>
      <div class="cartao verde"><small>A pagar</small><strong>${euro(tot.liquido)}</strong></div>
      <div class="cartao destaque"><small>Custo empresa</small><strong>${euro(tot.custo)}</strong></div>`;
    $('#btnProcessarMes').textContent = (mm === Number(q.mesSubFerias) || mm === Number(q.mesSubNatal) ? '⚙️ Preparar o mês (com subsídio) para todos' : '⚙️ Preparar o mês para todos');
    this.desenharEditor();

    // Fichas
    $('#listaFichas').innerHTML = this.fichas().length ? this.fichas().sort((a, b) => a.nome.localeCompare(b.nome)).map((f) => {
      const membro = membroPorId(f.membroId);
      return `<div class="item"><div class="info"><div class="titulo">${esc(f.nome)} ${membro ? '' : '<span class="badge mau">saiu da empresa</span>'}</div>
        <div class="sub">${esc(f.categoria || 'Sem categoria')} · ${esc(f.tipoContrato || '')}${f.dataAdmissao ? ' · desde ' + dataPT(f.dataAdmissao) : ''}</div>
        <div class="sub">${euro(f.ordenadoBase)} × 14 · IRS ${num(f.taxaIrs, 1)} % · Alimentação ${euro(f.subsidioAlimentacao)}/dia · ${N(f.horasSemana) || 40} h/semana</div>
        ${N(f.ordenadoBase) < q.salarioMinimo ? `<div class="sub negativo">⚠️ Abaixo do salário mínimo (${euro(q.salarioMinimo)})</div>` : ''}</div>
        <div class="direita">${btnEditar('salarios', f.id)}${btnApagar('salarios', f.id)}</div></div>`;
    }).join('') : vazioMsg('Ainda sem fichas.');
    const faltam = Equipa.membros.filter((m2) => !this.fichaDe(m2.id));
    $('#btnFichasTodos').hidden = !faltam.length;
    $('#btnFichasTodos').textContent = `➕ Criar ${faltam.length} ficha${faltam.length === 1 ? '' : 's'} em falta (ordenado mínimo ${euro(q.salarioMinimo)})`;
    const sel = $('#selPessoaFicha'), atual = sel.value, editId = $('#formFicha').dataset.editId;
    const editM = editId ? dados.salarios.find((x) => x.id === editId)?.membroId : null;
    // Todas as pessoas na lista; quem já tem ficha fica desativado (exceto a ficha que se está a editar).
    sel.innerHTML = Equipa.membros.map((m2) => `<option value="${m2.id}"${this.fichaDe(m2.id) && m2.id !== editM ? ' disabled' : ''}>${esc(m2.nome)}${this.fichaDe(m2.id) && m2.id !== editM ? ' (já tem ficha)' : ''}</option>`).join('');
    if ([...sel.options].some((o) => o.value === atual && !o.disabled)) sel.value = atual;
    else if (editM) sel.value = editM;
    else { const livre = [...sel.options].find((o) => !o.disabled); if (livre) sel.value = livre.value; }
    const ff = $('#formFicha');
    if (!editId && !ff.contains(document.activeElement)) {
      if (!ff.elements.ordenadoBase.value) ff.elements.ordenadoBase.value = q.salarioMinimo;
      if (!ff.elements.subsidioAlimentacao.value) ff.elements.subsidioAlimentacao.value = q.saPadrao;
      if (!ff.elements.horasSemana.value) ff.elements.horasSemana.value = 40;
      if (!ff.elements.taxaIrs.value) ff.elements.taxaIrs.value = 0;
    }

    // Parâmetros
    const fp = $('#formParamSal');
    if (!fp.elements.mesSubFerias.options.length) {
      const ops = MESES.map((n, i) => `<option value="${i + 1}">${n}</option>`).join('');
      fp.elements.mesSubFerias.innerHTML = ops; fp.elements.mesSubNatal.innerHTML = ops;
    }
    Object.entries(q).forEach(([k, v]) => { if (fp.elements[k] && document.activeElement !== fp.elements[k]) fp.elements[k].value = v; });
  },
};

/* ----- Os meus recibos (toda a gente) ----- */
const Recibos = {
  desenhar() {
    const uid = Equipa.user?.id;
    const ficha = Salarios.fichas().find((f) => f.userId === uid);
    $('#minhaFicha').innerHTML = ficha ? `<div class="caixa"><p><b>${esc(ficha.categoria || 'Colaborador')}</b> · ${esc(ficha.tipoContrato || '')}</p>
      <p class="ajuda">Ordenado base ${euro(ficha.ordenadoBase)} × 14 (subsídios de férias e de Natal) · horas extra pagas à parte.</p></div>` : '';
    const meus = dados.processamentos.filter((p) => p.userId === uid && ['Fechado', 'Pago'].includes(p.estado)).sort((a, b) => b.mes.localeCompare(a.mes));
    $('#listaRecibos').innerHTML = meus.length ? meus.map((p) => {
      const v = Salarios.valores(p);
      return `<div class="item"><div class="info"><div class="titulo">${nomeMes(p.mes)}</div>
        <div class="sub">Bruto ${euro(v.bruto)}${v.he ? ' · horas extra ' + euro(v.he) : ''}${v.subF || v.subN ? ' · com subsídio' : ''}</div>
        <div class="sub"><span class="badge ${p.estado === 'Pago' ? 'ok' : 'medio'}">${p.estado === 'Pago' ? '✓ Pago' : 'Por pagar'}</span></div></div>
        <div class="direita"><span class="valor positivo">${euro(v.liquido)}</span>
        <button class="mini" data-recibo="${p.id}">🖨️ Ver recibo</button></div></div>`;
    }).join('') : vazioMsg('Ainda não há recibos. Aparecem aqui quando o RH fechar o mês.');
  },
};

/* ===================== ESCALAS E TURNOS ===================== */
const Escalas = {
  semana: null, filtro: 'todos',

  segunda(iso) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoLocal(d); },
  nome(t) { return membroPorId(t.membroId)?.nome || t.nome || '?'; },
  sobrepoe(a, b) { return a.data === b.data && a.inicio < b.fim && b.inicio < a.fim; },
  ausente(t) {
    const m = membroPorId(t.membroId);
    return m?.user_id ? dados.ferias.find((f) => f.estado === 'Aprovado' && f._por === m.user_id && f.inicio <= t.data && f.fim >= t.data) : null;
  },
  conflitos(t, lista = dados.escalas) {
    const out = [];
    const aus = this.ausente(t);
    if (aus) out.push(`${this.nome(t)} está de ${aus.tipo.toLowerCase()}`);
    lista.forEach((o) => {
      if (o.id === t.id || !this.sobrepoe(o, t)) return;
      if (o.membroId === t.membroId) out.push(`${this.nome(t)} já tem turno ${o.inicio}–${o.fim}`);
      else if (t.carrinhaId && o.carrinhaId === t.carrinhaId) out.push(`a carrinha já está com ${this.nome(o)} (${o.inicio}–${o.fim})`);
    });
    return out;
  },

  desenhar() {
    if (!this.semana) this.semana = this.segunda(hojeISO());
    const fim = somaDias(this.semana, 6), hoje = hojeISO();
    $('#semanaTitulo').textContent = `${Number(this.semana.slice(8))} ${MESES[Number(this.semana.slice(5, 7)) - 1].slice(0, 3)} – ${Number(fim.slice(8))} ${MESES[Number(fim.slice(5, 7)) - 1].slice(0, 3)}`;
    $$('#filtroEscalas .chip').forEach((c) => c.classList.toggle('ativo', c.dataset.esc === this.filtro));
    const gere = Equipa.pode('escalas_gerir'), eu = Equipa.user?.id;
    let html = '';
    for (let i = 0; i < 7; i++) {
      const d = somaDias(this.semana, i), dow = new Date(d + 'T00:00:00').getDay();
      const feriado = feriados(Number(d.slice(0, 4))).has(d);
      const turnos = dados.escalas.filter((t) => t.data === d && (this.filtro === 'todos' || t.userId === eu)).sort((a, b) => a.inicio.localeCompare(b.inicio));
      const ausentes = dados.ferias.filter((f) => f.estado === 'Aprovado' && f.inicio <= d && f.fim >= d).map((f) => Equipa.nomeDe(f._por));
      html += `<div class="dia ${d === hoje ? 'hoje' : ''} ${dow === 0 || dow === 6 || feriado ? 'fds' : ''}">
        <div class="dia-titulo"><span>${d === hoje ? 'Hoje · ' : ''}${DIAS_SEMANA[dow]}, ${dataPT(d).slice(0, 5)}</span>
          <small>${feriado ? '🎉 Feriado' : turnos.length ? `${turnos.length} turno${turnos.length > 1 ? 's' : ''}` : ''}</small></div>
        ${turnos.map((t) => {
          const c = this.conflitos(t);
          const van = dados.carrinhas.find((x) => x.id === t.carrinhaId);
          return `<div class="turno ${t.userId === eu ? 'meu' : ''}"><span class="hora">${t.inicio}–${t.fim}</span>
            <span class="quem">${esc(this.nome(t))}${t.userId === eu ? ' (eu)' : ''}<small>${[van?.matricula, t.notas].filter(Boolean).map(esc).join(' · ')}</small>
            ${c.length ? `<small class="negativo">⚠️ ${esc(c.join('; '))}</small>` : ''}</span>
            ${gere ? `<span>${btnEditar('escalas', t.id)}${btnApagar('escalas', t.id)}</span>` : ''}</div>`;
        }).join('') || (ausentes.length ? '' : '<div class="ausente">Sem turnos</div>')}
        ${ausentes.length ? `<div class="ausente">🏖️ Ausente${ausentes.length > 1 ? 's' : ''}: ${esc([...new Set(ausentes)].join(', '))}</div>` : ''}</div>`;
    }
    $('#listaEscalas').innerHTML = html;
    const sel = $('#selPessoaEscala'), atual = sel.value;
    sel.innerHTML = Equipa.membros.map((m) => `<option value="${m.id}">${esc(m.nome)}</option>`).join('');
    if ([...sel.options].some((o) => o.value === atual)) sel.value = atual;
    $('#blocoRepetir').hidden = !!$('#formEscalas').dataset.editId;
  },

  guardar(f, editId) {
    if (f.fim <= f.inicio) { aviso('A hora de fim tem de ser depois do início.'); return false; }
    const m = membroPorId(f.membroId);
    if (!m) { aviso('Escolha a pessoa.'); return false; }
    const base = { membroId: m.id, userId: m.user_id || null, nome: m.nome, carrinhaId: f.carrinhaId || '', inicio: f.inicio, fim: f.fim, notas: (f.notas || '').trim() };
    let dias = [f.data];
    if (!editId && f.repetir && f.ate && f.ate > f.data) {
      dias = [];
      const dow0 = new Date(f.data + 'T00:00:00').getDay();
      for (let d = f.data, i = 0; d <= f.ate && i < 120; d = somaDias(d, 1), i++) {
        const dow = new Date(d + 'T00:00:00').getDay();
        if (f.repetir === 'uteis' && (dow === 0 || dow === 6 || feriados(Number(d.slice(0, 4))).has(d))) continue;
        if (f.repetir === 'semanal' && dow !== dow0) continue;
        dias.push(d);
      }
    }
    const novos = dias.map((d) => ({ ...base, data: d, id: editId || novoId() + d.slice(5).replace('-', ''), _por: Equipa.userId() }));
    const outros = dados.escalas.filter((t) => t.id !== editId);
    const avisos = novos.flatMap((t) => this.conflitos(t, [...outros, ...novos.filter((x) => x !== t)]).map((c) => `${dataPT(t.data).slice(0, 5)}: ${c}`));
    if (avisos.length && !confirm(`⚠️ Atenção:\n${[...new Set(avisos)].slice(0, 6).join('\n')}${avisos.length > 6 ? '\n…' : ''}\n\nGuardar mesmo assim?`)) return false;
    if (editId) {
      const i = dados.escalas.findIndex((t) => t.id === editId);
      if (i >= 0) dados.escalas[i] = { ...dados.escalas[i], ...novos[0] };
    } else dados.escalas.push(...novos);
    guardar(); desenhar();
    aviso(editId ? '✅ Turno alterado' : `📅 ${novos.length} turno${novos.length > 1 ? 's' : ''} marcado${novos.length > 1 ? 's' : ''}`);
    return true;
  },
};

/* ===================== CLIENTES ===================== */
const Clientes = {
  procura: '', aberto: null,
  chave: (n) => (n || '').trim().toLowerCase(),
  fichaPorNome(n) { return dados.clientes.find((c) => this.chave(c.nome) === this.chave(n)); },
  stats(nome) {
    const k = this.chave(nome);
    const vs = dados.viagens.filter((v) => this.chave(v.cliente) === k).sort(porDataDesc);
    const kc = vs.reduce((s, v) => s + N(v.kmCarregado), 0), fat = vs.reduce((s, v) => s + N(v.receita), 0);
    return { vs, n: vs.length, fat, porCobrar: vs.reduce((s, v) => s + porCobrarViagem(v), 0), ultima: vs[0]?.data, precoMedio: kc ? fat / kc : null };
  },
  desenhar() {
    const precos = pode('precos'), gere = pode('clientes');
    const q = this.chave(this.procura);
    const lista = dados.clientes.filter((c) => !q || this.chave(c.nome).includes(q) || (c.nif || '').includes(q))
      .map((c) => ({ c, s: this.stats(c.nome) })).sort((a, b) => b.s.fat - a.s.fat || a.c.nome.localeCompare(b.c.nome));
    $('#listaClientes').innerHTML = lista.length ? lista.map(({ c, s }) => `<div class="item cliente"><div class="info">
        <div class="titulo">${esc(c.nome)}</div>
        <div class="sub">${[c.nif && 'NIF ' + esc(c.nif), c.contacto && esc(c.contacto), c.prazo != null && c.prazo !== '' ? `paga a ${N(c.prazo)} dias` : ''].filter(Boolean).join(' · ')}</div>
        <div class="sub">${s.n} viage${s.n === 1 ? 'm' : 'ns'}${s.ultima ? ' · última ' + dataPT(s.ultima) : ''}${precos && s.precoMedio ? ` · média ${euro(s.precoMedio)}/km` : ''}${precos && c.precoHabitual ? ` · habitual ${euro(c.precoHabitual)}/km` : ''}</div>
        ${precos && s.porCobrar ? `<div class="sub"><span class="badge mau">Por cobrar ${euro(s.porCobrar)}</span></div>` : ''}
        <div class="botoes mini-botoes">
          ${c.telefone ? `<a class="mini botao-link" href="tel:${esc(c.telefone.replace(/\s/g, ''))}">📞 Ligar</a>` : ''}
          ${c.email ? `<a class="mini botao-link" href="mailto:${esc(c.email)}">✉️ Email</a>` : ''}
          ${s.n ? `<button class="mini" data-cli-hist="${c.id}">${this.aberto === c.id ? '▲ Esconder' : '▼ Viagens'}</button>` : ''}</div>
        ${this.aberto === c.id ? `<div class="hist">${s.vs.slice(0, 15).map((v) => `<div class="sub">${dataPT(v.data)} · ${esc(v.origem || '?')} → ${esc(v.destino || '?')}${precos ? ' · ' + euro(v.receita) + ' · ' + (v.estado || 'Pendente') : ''}</div>`).join('')}</div>` : ''}
      </div>
      <div class="direita">${precos ? `<span class="valor">${euro(s.fat)}</span><small>faturado</small>` : ''}
        <div>${gere ? btnEditar('clientes', c.id) + btnApagar('clientes', c.id) : ''}</div></div></div>`).join('')
      : vazioMsg(q ? 'Nenhum cliente encontrado.' : 'Ainda sem clientes. Adicione em baixo.');

    // Clientes que aparecem nas viagens mas ainda não têm ficha
    const sem = [...new Set(dados.viagens.map((v) => (v.cliente || '').trim()).filter((n) => n && !this.fichaPorNome(n)))];
    $('#clientesSemFicha').innerHTML = sem.length && gere ? `<p class="ajuda">Nas viagens, sem ficha:</p><div class="botoes">${sem.slice(0, 12)
      .map((n) => `<button class="mini" data-cli-criar="${esc(n)}">➕ ${esc(n)}</button>`).join('')}</div>` : '';
    // Sugestões no formulário da viagem
    const nomes = [...new Set([...dados.clientes.map((c) => c.nome), ...dados.viagens.map((v) => v.cliente)].filter(Boolean))].sort((a, b) => a.localeCompare(b));
    $('#sugClientes').innerHTML = nomes.map((n) => `<option value="${esc(n)}">`).join('');
  },
};

/* ===================== RELATÓRIOS (PDF) ===================== */
const Relatorios = {
  estilo: `<style>
    @page { margin: 12mm; }
    .rel { font-family: Inter, Arial, sans-serif; color: #111; font-size: 11px; }
    .rel header { display: flex; align-items: center; gap: 12px; border-bottom: 3px solid #e10600; padding-bottom: 8px; margin-bottom: 12px; }
    .rel header img { width: 56px; height: 56px; }
    .rel h1 { font-size: 18px; margin: 0; } .rel h1 small { display: block; font-size: 11px; color: #555; font-weight: 600; }
    .rel h2 { font-size: 13px; margin: 16px 0 6px; border-left: 4px solid #e10600; padding-left: 6px; }
    .rel table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
    .rel th, .rel td { border-bottom: 1px solid #ddd; padding: 4px 5px; text-align: right; white-space: nowrap; }
    .rel th { background: #f2f2f2; font-size: 10px; text-transform: uppercase; }
    .rel th:first-child, .rel td:first-child { text-align: left; white-space: normal; }
    .rel tr.t td { font-weight: 800; background: #f7f7f7; }
    .rel .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 20px; }
    .rel .l { display: flex; justify-content: space-between; border-bottom: 1px dotted #ccc; padding: 3px 0; }
    .rel .l.forte { font-weight: 800; border-bottom: 2px solid #111; }
    .rel footer { margin-top: 18px; color: #777; font-size: 9px; border-top: 1px solid #ddd; padding-top: 6px; }
    .rel .nota { color: #555; font-size: 9.5px; }
    .rel .assin { margin-top: 40px; display: flex; justify-content: space-between; gap: 40px; }
    .rel .assin div { flex: 1; border-top: 1px solid #111; padding-top: 4px; text-align: center; }
  </style>`,

  imprimir(titulo, sub, corpo) {
    const emp = (typeof Equipa !== 'undefined' && Equipa.empresa?.nome) || 'Transportes Freitas';
    $('#impressao').innerHTML = `${this.estilo}<div class="rel"><header><img src="img/logo-128.png" alt="">
      <h1>${esc(titulo)}<small>${esc(emp)} · ${esc(sub)}</small></h1></header>${corpo}
      <footer>Gerado em ${new Date().toLocaleString('pt-PT')} pelo site de gestão da ${esc(emp)}.</footer></div>`;
    const img = $('#impressao img');
    const ir = () => setTimeout(() => window.print(), 60);
    if (img && !img.complete) { img.onload = ir; img.onerror = ir; } else ir();
  },

  mensal() {
    const t = resumoPeriodo(), periodo = mes ? nomeMes(mes) : 'todo o período';
    const linha = (a, b, c = '') => `<div class="l ${c}"><span>${a}</span><b>${b}</b></div>`;
    const vs = dados.viagens.filter((v) => noPeriodo(v.data)).sort((a, b) => a.data.localeCompare(b.data));
    const porCliente = {};
    vs.forEach((v) => { const k = v.cliente || '(sem cliente)'; const o = (porCliente[k] ||= { n: 0, km: 0, fat: 0, cobrar: 0 }); o.n++; o.km += N(v.kmCarregado) + N(v.kmVazio); o.fat += N(v.receita); o.cobrar += porCobrarViagem(v); });
    const ds = dados.despesas.filter((d) => noPeriodo(d.data)).sort((a, b) => a.data.localeCompare(b.data));
    const ab = dados.abastecimentos.filter((a) => noPeriodo(a.data));
    const procs = dados.processamentos.filter((p) => noPeriodo(p.mes + '-01'));
    const corpo = `
      <h2>Resultado</h2><div class="grid"><div>
        ${linha(`Receita das viagens (${t.viagens})`, euro(t.receita))}${linha('Gasóleo' + (t.gasoleoEstimado ? ' (estimado)' : ''), euro(t.gasoleo))}
        ${linha('Portagens', euro(t.portagens))}${linha('Comida / estadia', euro(t.alimentacao))}${t.outros ? linha('Outros das viagens', euro(t.outros)) : ''}
        ${t.outrasDespesas ? linha('Outras despesas', euro(t.outrasDespesas)) : ''}${linha('Custos fixos', euro(t.fixos))}
        ${t.salarios ? linha('Salários da equipa (custo empresa)', euro(t.salarios)) : ''}${linha('Reserva de manutenção', euro(t.reserva))}
        ${linha('LUCRO', euro(t.lucro), 'forte')}</div><div>
        ${linha('Km percorridos', num(t.km) + ' km')}${linha('Km em vazio', pct(t.pctVazio))}${linha('Preço médio', t.precoKm ? euro(t.precoKm) + '/km' : '—')}
        ${linha('Média de gasóleo', t.media ? num(t.media, 1) + ' L/100km' : '—')}${linha('Faturas por cobrar', euro(t.porCobrar))}
        ${linha('Manutenção paga', euro(t.manutencaoPaga))}</div></div>
      <h2>Por cliente</h2><table><tr><th>Cliente</th><th>Viagens</th><th>Km</th><th>Faturado</th><th>Por cobrar</th></tr>
        ${Object.entries(porCliente).sort((a, b) => b[1].fat - a[1].fat).map(([k, o]) => `<tr><td>${esc(k)}</td><td>${o.n}</td><td>${num(o.km)}</td><td>${euro(o.fat)}</td><td>${euro(o.cobrar)}</td></tr>`).join('')}</table>
      <h2>Viagens</h2><table><tr><th>Data · rota · cliente</th><th>Km</th><th>Receita</th><th>Gastos</th><th>Lucro</th><th>Fatura</th><th>Pagamento</th></tr>
        ${vs.map((v) => { const c = calcViagem(v); return `<tr><td>${dataPT(v.data)} · ${esc(v.origem || '?')} → ${esc(v.destino || '?')}${v.cliente ? ' · ' + esc(v.cliente) : ''}</td>
          <td>${num(c.kmTotal)}</td><td>${euro(v.receita)}</td><td>${euro(c.gastos)}</td><td>${euro(c.lucro)}</td><td>${esc(v.fatura || '')}</td><td>${esc(v.estado || 'Pendente')}</td></tr>`; }).join('')}
        <tr class="t"><td>Total</td><td>${num(t.km)}</td><td>${euro(t.receita)}</td><td></td><td></td><td></td><td></td></tr></table>
      ${ds.length ? `<h2>Despesas</h2><table><tr><th>Data · categoria · descrição</th><th>Carrinha</th><th>Valor</th></tr>
        ${ds.map((d) => `<tr><td>${dataPT(d.data)} · ${esc(d.categoria)}${d.descricao ? ' · ' + esc(d.descricao) : ''}</td><td>${esc((nomeCarrinha(d.carrinhaId) || 'Geral').split(' · ')[0])}</td><td>${euro(d.valor)}</td></tr>`).join('')}</table>` : ''}
      ${ab.length ? `<h2>Gasóleo</h2><table><tr><th>Carrinha</th><th>Abastecimentos</th><th>Litros</th><th>Valor</th></tr>
        ${dados.carrinhas.map((c) => { const l = ab.filter((a) => a.carrinhaId === c.id); return l.length ? `<tr><td>${esc(c.matricula)}</td><td>${l.length}</td><td>${num(l.reduce((s, a) => s + N(a.litros), 0), 1)}</td><td>${euro(l.reduce((s, a) => s + N(a.valor), 0))}</td></tr>` : ''; }).join('')}</table>` : ''}
      ${procs.length ? `<h2>Salários</h2>${this.tabelaSalarios(procs)}` : ''}
      <h2>Custos fixos (mensais)</h2><table><tr><th>Item</th><th>Periodicidade</th><th>€/mês</th></tr>
        ${dados.custosFixos.filter((f) => N(f.valor)).map((f) => `<tr><td>${esc(f.nome)}</td><td>${esc(f.periodo)}</td><td>${euro(N(f.valor) / (DIVISOR[f.periodo] || 1))}</td></tr>`).join('')}</table>
      <p class="nota">Valores sem IVA. O gasóleo do resultado é o pago nos abastecimentos (ou estimado pelos km, se não houver). A reserva de manutenção é uma provisão.</p>`;
    this.imprimir('Relatório mensal', periodo, corpo);
  },

  tabelaSalarios(procs) {
    const tot = {};
    const rows = procs.sort((a, b) => a.nome.localeCompare(b.nome)).map((p) => {
      const v = Salarios.valores(p), f = Salarios.fichaDe(p.membroId);
      ['base', 'he', 'subF', 'subN', 'bruto', 'ssTrab', 'irs', 'sa', 'adiant', 'liquido', 'ssEmp', 'fct', 'seg', 'custo'].forEach((k) => { tot[k] = (tot[k] || 0) + N(v[k]); });
      return `<tr><td>${esc(p.nome)}<br><small>${esc(f?.categoria || '')}</small></td><td>${N(p.diasTrabalhados)}/${N(p.faltas)}</td><td>${euro(v.base)}</td><td>${euro(v.he)}</td>
        <td>${euro(v.subF + v.subN)}</td><td>${euro(v.bruto)}</td><td>${euro(v.ssTrab)}</td><td>${euro(v.irs)}</td><td>${euro(v.sa)}</td><td>${euro(v.adiant)}</td>
        <td><b>${euro(v.liquido)}</b></td><td>${euro(v.ssEmp + v.fct + v.seg)}</td><td><b>${euro(v.custo)}</b></td></tr>`;
    }).join('');
    return `<table><tr><th>Nome</th><th>Dias/Faltas</th><th>Base</th><th>H. extra</th><th>Subsídios</th><th>Bruto</th><th>SS trab.</th><th>IRS</th><th>Sub. alim.</th>
      <th>Adiant.</th><th>A receber</th><th>Encargos</th><th>Custo empresa</th></tr>${rows}
      <tr class="t"><td>Total</td><td></td><td>${euro(tot.base)}</td><td>${euro(tot.he)}</td><td>${euro(tot.subF + tot.subN)}</td><td>${euro(tot.bruto)}</td><td>${euro(tot.ssTrab)}</td>
      <td>${euro(tot.irs)}</td><td>${euro(tot.sa)}</td><td>${euro(tot.adiant)}</td><td>${euro(tot.liquido)}</td><td>${euro(tot.ssEmp + tot.fct + tot.seg)}</td><td>${euro(tot.custo)}</td></tr></table>
      <p class="nota">Encargos = SS empresa ${num(Salarios.param().ssEmpresa, 2)} % + FCT/FGCT ${num(Salarios.param().fct, 3)} % + seguro AT ${num(Salarios.param().seguroAT, 2)} %. Sem ajudas de custo nem pagamento ao km.</p>`;
  },

  mapa() {
    const m = Salarios.mesAtual();
    const procs = dados.processamentos.filter((p) => p.mes === m);
    if (!procs.length) { aviso('Prepare primeiro o mês.'); return; }
    this.imprimir('Mapa de salários', nomeMes(m), this.tabelaSalarios(procs));
  },

  recibo(p) {
    const v = Salarios.valores(p), f = Salarios.fichaDe(p.membroId) || Salarios.fichas().find((x) => x.userId === p.userId) || {};
    const l = (a, b, c = '') => `<div class="l ${c}"><span>${a}</span><b>${b}</b></div>`;
    const iban = f.iban ? f.iban.replace(/\s/g, '').replace(/^(.{4}).*(.{4})$/, '$1 •••• $2') : '';
    const corpo = `<div class="grid"><div>${l('Trabalhador', esc(p.nome))}${l('Categoria', esc(f.categoria || '—'))}${l('Contrato', esc(f.tipoContrato || '—'))}</div>
      <div>${l('NIF', esc(f.nif || '—'))}${l('NISS', esc(f.niss || '—'))}${l('IBAN', esc(iban || '—'))}</div></div>
      <h2>Abonos</h2>${l('Ordenado base', euro(v.base))}${v.he ? l(`Horas extra (1.ª: ${N(p.he1)} h · seguintes: ${N(p.he2)} h · descanso: ${N(p.heDescanso)} h · ${euro(v.valorHora)}/h)`, euro(v.he)) : ''}
      ${v.subF ? l('Subsídio de férias', euro(v.subF)) : ''}${v.subN ? l('Subsídio de Natal', euro(v.subN)) : ''}${v.outros ? l('Outros abonos/descontos', euro(v.outros)) : ''}
      ${v.descFaltas ? l(`Faltas (${N(p.faltas)} dia${N(p.faltas) === 1 ? '' : 's'})`, '−' + euro(v.descFaltas)) : ''}${l('Remuneração bruta', euro(v.bruto), 'forte')}
      <h2>Descontos</h2>${l(`Segurança Social (${num(Salarios.param().ssTrabalhador, 2)} %)`, '−' + euro(v.ssTrab))}${l(`IRS (${num(v.taxaIrs, 1)} %)`, '−' + euro(v.irs))}
      ${v.adiant ? l('Adiantamento', '−' + euro(v.adiant)) : ''}
      ${v.sa ? `<h2>Não sujeito a descontos</h2>${l(`Subsídio de alimentação (${N(p.diasTrabalhados)} dias × ${euro(v.saDia)})`, euro(v.sa))}` : ''}
      <h2>Total</h2>${l('💶 Valor líquido a receber', euro(v.liquido), 'forte')}
      ${p.notas ? `<p class="nota">Notas: ${esc(p.notas)}</p>` : ''}
      <div class="assin"><div>A entidade empregadora</div><div>O trabalhador</div></div>
      <p class="nota">Documento interno de apoio. O recibo oficial (com apólice do seguro de acidentes de trabalho e restantes elementos legais) é emitido pelo contabilista.</p>`;
    this.imprimir('Recibo de vencimento', nomeMes(p.mes), corpo);
  },
};

/* ===================== NOTIFICAÇÕES ===================== */
const Notificacoes = {
  url() { return (window.FROTA_NUVEM?.url || '') + '/functions/v1/' + (window.FROTA_NUVEM?.funcao || 'notificar'); },
  suportado() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; },
  iphoneSemIcone() {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const instalado = navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    return ios && !instalado;
  },
  chave(b64) {
    const p = '='.repeat((4 - (b64.length % 4)) % 4), s = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  },
  async subscricao() {
    if (!this.suportado()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  },
  async desenhar() {
    const bloco = $('#blocoNotif');
    bloco.hidden = !Nuvem.user;
    if (bloco.hidden) return;
    let txt, ligado = false;
    if (this.iphoneSemIcone()) txt = '📱 Para ativar no iPhone, adicione primeiro o site ao ecrã principal (Partilhar → Adicionar ao ecrã principal) e abra-o pelo ícone.';
    else if (!this.suportado()) txt = '⚠️ Este navegador não suporta notificações.';
    else if (Notification.permission === 'denied') txt = '🔕 As notificações estão bloqueadas nas definições do telemóvel para este site.';
    else {
      const sub = await this.subscricao().catch(() => null);
      ligado = !!sub && Notification.permission === 'granted';
      txt = ligado ? '✅ Notificações ligadas neste telemóvel.' : '🔕 Ainda não estão ligadas neste telemóvel.';
    }
    $('#notifEstado').textContent = txt;
    $('#notifAtivar').hidden = ligado || this.iphoneSemIcone() || !this.suportado();
    $('#notifTeste').hidden = !ligado;
    $('#notifDesligar').hidden = !ligado;
  },
  async ativar() {
    if (!this.suportado()) { aviso('Este navegador não suporta notificações.'); return; }
    // Pedir autorização logo no toque (o iPhone só deixa assim)
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { aviso('🔕 Sem autorização para notificações.'); this.desenhar(); return; }
    try {
      let { data: publica } = await Nuvem.cliente.rpc('push_chave_publica');
      if (!publica) {
        const r = await fetch(this.url(), { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: window.FROTA_NUVEM.chave }, body: '{"acao":"iniciar"}' });
        publica = (await r.json().catch(() => ({}))).publica;
      }
      if (!publica) { aviso('❌ Falta instalar as notificações no Supabase (notificacoes.sql e a função "notificar").'); return; }
      const reg = await navigator.serviceWorker.ready;
      const antiga = await reg.pushManager.getSubscription();
      if (antiga) await antiga.unsubscribe();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: this.chave(publica) });
      const error = await this.registar(sub);
      if (error) throw error;
      aviso('🔔 Notificações ligadas!');
      this.teste(true);
    } catch (e) {
      aviso('❌ Não foi possível ligar: ' + (e.message || e));
    }
    this.desenhar();
  },
  // Guarda (outra vez) este telemóvel na base de dados — não faz mal repetir.
  async registar(sub) {
    const j = sub.toJSON();
    const { error } = await Nuvem.cliente.from('push_subscricoes').upsert({
      endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_id: Nuvem.user.id, empresa_id: Equipa.empresa?.id || null,
    }, { onConflict: 'endpoint' });
    return error;
  },
  async teste(silencioso) {
    const sub = await this.subscricao().catch(() => null);
    if (sub) {
      const erro = await this.registar(sub);
      if (erro && !silencioso) { alert('❌ Não foi possível registar este telemóvel na base de dados:\n' + erro.message); return; }
    }
    const { data } = await Nuvem.cliente.auth.getSession();
    const r = await fetch(this.url(), {
      method: 'POST', body: '{"acao":"teste"}',
      headers: { 'Content-Type': 'application/json', apikey: window.FROTA_NUVEM.chave, Authorization: 'Bearer ' + (data.session?.access_token || '') },
    }).catch((e) => ({ falhou: e }));
    if (silencioso) return;
    if (!r || r.falhou) { alert('❌ Sem ligação à função das notificações.\n' + (r?.falhou?.message || '')); return; }
    const j = await r.json().catch(() => ({}));
    if (j.enviadas) { aviso('📨 Enviada! Deve aparecer daqui a uns segundos.'); return; }
    let porque;
    if (r.status === 401) porque = 'A função não reconheceu a sua sessão (' + (j.erro || 'Sem sessão') + ').';
    else if (r.status === 404) porque = 'A função não foi encontrada (endereço "' + (window.FROTA_NUVEM?.funcao || 'notificar') + '").';
    else if (j.erro) porque = 'Erro na função: ' + j.erro;
    else if (j.subscricoes === 0) porque = 'Este telemóvel não está registado na base de dados.';
    else if (j.recusadas) porque = 'O serviço de notificações do telemóvel recusou (código ' + (j.codigos || []).join(', ') + ').';
    else porque = 'Resposta da função: ' + r.status + ' ' + JSON.stringify(j);
    alert('❌ A notificação não foi enviada.\n\n' + porque + '\n\nMande uma captura deste ecrã ao Claude.');
  },
  async desligar() {
    const sub = await this.subscricao();
    if (sub) {
      await Nuvem.cliente.from('push_subscricoes').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
    aviso('🔕 Notificações desligadas neste telemóvel.');
    this.desenhar();
  },
};
$('#notifAtivar').addEventListener('click', () => Notificacoes.ativar());
$('#notifTeste').addEventListener('click', () => Notificacoes.teste(false));
$('#notifDesligar').addEventListener('click', () => Notificacoes.desligar());

/* ===================== Desenhar tudo ===================== */
const RH = {
  desenhar() {
    Clientes.desenhar();
    Notificacoes.desenhar();
    if (typeof Equipa === 'undefined' || !Equipa.ativa()) return;
    Escalas.desenhar();
    Recibos.desenhar();
    if (Equipa.pode('salarios')) Salarios.desenhar();
  },
};

/* ===================== Formulários e botões ===================== */
ligarFormulario('#formFicha', 'salarios', (f, editId) => {
  const m = membroPorId(f.membroId);
  if (!m) { aviso('Escolha a pessoa.'); return null; }
  if (!editId && Salarios.fichaDe(m.id)) { aviso('Essa pessoa já tem ficha.'); return null; }
  const q = Salarios.param();
  if (N(f.ordenadoBase) < q.salarioMinimo && !confirm(`O ordenado (${euro(N(f.ordenadoBase))}) está abaixo do salário mínimo (${euro(q.salarioMinimo)}). Guardar mesmo assim?`)) return null;
  return {
    id: editId || `sal-${m.id}`, membroId: m.id, userId: m.user_id || null, nome: m.nome, categoria: f.categoria.trim(),
    ordenadoBase: r2(f.ordenadoBase), taxaIrs: N(f.taxaIrs), subsidioAlimentacao: r2(f.subsidioAlimentacao), horasSemana: N(f.horasSemana) || 40,
    tipoContrato: f.tipoContrato, dataAdmissao: f.dataAdmissao, nif: f.nif.trim(), niss: f.niss.trim(), iban: f.iban.trim().toUpperCase(), notas: f.notas.trim(),
  };
}, '🗂️ Ficha guardada');

ligarFormulario('#formClientes', 'clientes', (f, editId) => {
  const nome = f.nome.trim();
  const outro = Clientes.fichaPorNome(nome);
  if (outro && outro.id !== editId) { aviso('Já existe um cliente com esse nome.'); return null; }
  const antigo = editId ? dados.clientes.find((c) => c.id === editId) : null;
  // Se o nome mudou, as viagens antigas passam para o nome novo.
  if (antigo && Clientes.chave(antigo.nome) !== Clientes.chave(nome)) {
    dados.viagens.forEach((v) => { if (Clientes.chave(v.cliente) === Clientes.chave(antigo.nome) && podeEditar('viagens', v)) v.cliente = nome; });
  }
  return { nome, nif: f.nif.trim(), contacto: f.contacto.trim(), telefone: f.telefone.trim(), email: f.email.trim(), morada: f.morada.trim(),
    prazo: f.prazo === '' ? 30 : N(f.prazo), precoHabitual: f.precoHabitual === '' ? null : N(f.precoHabitual), notas: f.notas.trim() };
}, '🏢 Cliente guardado');

FORMS.escalas = $('#formEscalas');
$('#formEscalas').elements.data.value = hojeISO();
$('#formEscalas').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target, editId = form.dataset.editId;
  if (Escalas.guardar(Object.fromEntries(new FormData(form)), editId)) {
    const pessoa = form.elements.membroId.value;
    sairEdicao(form); form.elements.membroId.value = pessoa;
    form.elements.inicio.value = '08:00'; form.elements.fim.value = '17:00';
    Escalas.desenhar();
  }
});
$('#formEscalas .cancelar').addEventListener('click', () => { sairEdicao($('#formEscalas')); Escalas.desenhar(); });
$('#semAnt').addEventListener('click', () => { Escalas.semana = somaDias(Escalas.semana, -7); Escalas.desenhar(); });
$('#semSeg').addEventListener('click', () => { Escalas.semana = somaDias(Escalas.semana, 7); Escalas.desenhar(); });
$('#semHoje').addEventListener('click', () => { Escalas.semana = Escalas.segunda(hojeISO()); Escalas.desenhar(); });
$('#filtroEscalas').addEventListener('click', (e) => { const c = e.target.closest('[data-esc]'); if (c) { Escalas.filtro = c.dataset.esc; Escalas.desenhar(); } });

$('#btnProcessarMes').addEventListener('click', () => Salarios.prepararMes());
$('#btnFichasTodos').addEventListener('click', () => Salarios.criarFichasEmFalta());
$('#btnMapaPdf').addEventListener('click', () => Relatorios.mapa());
$('#btnRelatorio').addEventListener('click', () => Relatorios.mensal());
$('#btnMapaCsv').addEventListener('click', () => {
  const m = Salarios.mesAtual();
  const procs = dados.processamentos.filter((p) => p.mes === m).sort((a, b) => a.nome.localeCompare(b.nome));
  if (!procs.length) { aviso('Prepare primeiro o mês.'); return; }
  const linhas = [['Nome', 'Categoria', 'NIF', 'NISS', 'Dias trabalhados', 'Faltas', 'HE 1.ª (h)', 'HE seguintes (h)', 'HE descanso (h)', 'Ordenado base', 'Valor horas extra',
    'Desc. faltas', 'Sub. férias', 'Sub. Natal', 'Outros', 'Ordenado bruto', 'SS trabalhador', 'Taxa IRS %', 'IRS', 'Sub. alimentação', 'Adiantamento',
    'TOTAL A RECEBER', 'SS empresa', 'FCT/FGCT', 'Seguro AT', 'Custo empresa', 'Estado']];
  procs.forEach((p) => {
    const v = Salarios.valores(p), f = Salarios.fichaDe(p.membroId) || {};
    linhas.push([p.nome, f.categoria || '', f.nif || '', f.niss || '', N(p.diasTrabalhados), N(p.faltas), N(p.he1), N(p.he2), N(p.heDescanso), v.base, v.he,
      v.descFaltas, v.subF, v.subN, v.outros, v.bruto, v.ssTrab, v.taxaIrs, v.irs, v.sa, v.adiant, v.liquido, v.ssEmp, v.fct, v.seg, v.custo, p.estado]);
  });
  descarregar(`salarios-${m}.csv`, csv(linhas), 'text/csv;charset=utf-8');
});

$('#tabelaSalarios').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-proc]'); if (tr) Salarios.abrir(tr.dataset.proc); });
$('#formProcessamento').addEventListener('input', () => Salarios.desenharEditor());
$('#formProcessamento').addEventListener('submit', (e) => {
  e.preventDefault();
  const i = dados.processamentos.findIndex((x) => x.id === Salarios.aberto);
  if (i < 0 || dados.processamentos[i].estado !== 'Rascunho') return;
  dados.processamentos[i] = Salarios.doForm(dados.processamentos[i]);
  guardar(); desenhar(); aviso('✅ Guardado');
});
$('#procFechar').addEventListener('click', () => {
  const i = dados.processamentos.findIndex((x) => x.id === Salarios.aberto);
  if (i < 0) return;
  const p = Salarios.doForm(dados.processamentos[i]);
  if (!confirm(`Fechar o mês de ${p.nome}?\n\nO recibo fica visível para a pessoa e os valores ficam fixos (pode reabrir se for preciso).`)) return;
  dados.processamentos[i] = { ...p, valores: Salarios.calc(p), estado: 'Fechado', fechadoEm: hojeISO(), userId: membroPorId(p.membroId)?.user_id || p.userId };
  guardar(); desenhar(); aviso('✓ Mês fechado. A pessoa já vê o recibo.');
});
$('#procPago').addEventListener('click', () => {
  const p = dados.processamentos.find((x) => x.id === Salarios.aberto);
  if (!p) return;
  p.estado = 'Pago'; p.pagoEm = hojeISO();
  guardar(); desenhar(); aviso('💶 Marcado como pago');
});
$('#procReabrir').addEventListener('click', () => {
  const p = dados.processamentos.find((x) => x.id === Salarios.aberto);
  if (!p || !confirm('Reabrir para alterar? A pessoa deixa de ver este recibo até voltar a fechar.')) return;
  p.estado = 'Rascunho'; delete p.valores; delete p.pagoEm;
  guardar(); desenhar(); Salarios.abrir(p.id);
});
$('#procRecibo').addEventListener('click', () => {
  const p = dados.processamentos.find((x) => x.id === Salarios.aberto);
  if (p) Relatorios.recibo(p.estado === 'Rascunho' ? Salarios.doForm(p) : p);
});
$('#procCancelar').addEventListener('click', () => { Salarios.aberto = null; $('#formProcessamento').hidden = true; });
$('#formParamSal').addEventListener('change', (e) => {
  const { name, value } = e.target;
  if (!name) return;
  let r = dados.salarios.find((x) => x.id === SAL_PARAM_ID);
  if (!r) { r = { id: SAL_PARAM_ID, _por: Equipa.userId() }; dados.salarios.push(r); }
  r[name] = N(value);
  guardar(); desenhar(); aviso('✅ Regras dos salários atualizadas');
});

$('#procurarCliente').addEventListener('input', (e) => { Clientes.procura = e.target.value; Clientes.desenhar(); });
// Escolher um cliente com preço habitual preenche o preço por km da viagem.
$('#formViagens').elements.cliente.addEventListener('change', (e) => {
  const c = Clientes.fichaPorNome(e.target.value), form = $('#formViagens');
  if (c?.precoHabitual && !form.elements.precoKm.value && form.querySelector('[name=tipoPreco][value=km]').checked) {
    form.elements.precoKm.value = c.precoHabitual;
    form.dispatchEvent(new Event('input', { bubbles: true }));
    aviso(`💡 Preço habitual de ${c.nome}: ${euro(c.precoHabitual)}/km`);
  }
});

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  if (t.classList.contains('editar') && d.tipo === 'escalas') setTimeout(() => { $('#blocoRepetir').hidden = true; }, 0);
  if (d.recibo) { const p = dados.processamentos.find((x) => x.id === d.recibo); if (p) Relatorios.recibo(p); }
  else if (d.cliHist) { Clientes.aberto = Clientes.aberto === d.cliHist ? null : d.cliHist; Clientes.desenhar(); }
  else if (d.cliCriar) {
    const form = $('#formClientes');
    sairEdicao(form); form.elements.nome.value = d.cliCriar;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' }); form.elements.nif.focus();
  }
});

/* ===================== Arranque ===================== */
desenhar();
Nuvem.iniciar();
setTimeout(() => Nuvem.arrancou(), 6000); // por segurança, nunca fica preso no ecrã inicial
