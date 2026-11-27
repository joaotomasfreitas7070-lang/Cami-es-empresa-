# Transportes Freitas — Gestão de Frota

Site simples para gerir a empresa de transportes. Substitui as folhas Excel de controlo mensal.

## Separadores
- **📊 Painel** – resultado do mês igual ao Excel: receita − gasóleo − portagens − comida − custos fixos − reserva de manutenção
  = lucro antes do ordenado; depois o custo do ordenado, sobra/falta, ordenado que a empresa aguenta, faturas por cobrar,
  resumo por semana (segunda a domingo) e por carrinha.
- **🚚 Viagens** – uma linha por viagem (cliente, origem → destino, km carregado/vazio, receita, portagens, comida, outros,
  nº fatura, estado). Mostra logo o preço por km, o preço mínimo, o lucro e a avaliação (OK / Abaixo do objetivo / PREJUÍZO).
  Toque em "Por cobrar" para marcar como pago. ✏️ para editar.
- **⛽ Abastecer** – km do conta-quilómetros, litros e valor → média L/100km real. O gasóleo das viagens é estimado com esta média.
- **💸 Despesas** – manutenção, pneus e avarias (saem da reserva) e outros gastos.
- **⚙️ Mais** – cópias de segurança, exportar para Excel, carrinhas, custos fixos e parâmetros (preço objetivo, reserva, ordenado…).

## Onde ficam os dados
Sempre no navegador do dispositivo (funciona sem internet). Com a conta ligada em **⚙️ Mais → Guardar na internet**,
são também guardados no Supabase e sincronizados entre dispositivos.

### Ligar ao Supabase (uma vez)
1. Criar projeto em supabase.com.
2. SQL Editor → colar `supabase/criar-tabela.sql` → Run.
3. Authentication → URL Configuration → Site URL = endereço do site no GitHub Pages.
4. Project Settings → API → copiar o *Project URL* e a chave pública (*anon* / *publishable*) para `config.js`.
   Nunca usar a chave *service_role* / *secret*.

## Equipa (empresa, pessoas e permissões)
1. Correr `supabase/equipa.sql` e depois `supabase/equipa-2.sql` no Supabase (SQL Editor → Run), uma vez cada.
2. O patrão entra no site → **Equipa** → *Criar empresa*. Os dados que já existiam passam para a empresa.
3. Em **Equipa → Pessoas**, adicionar cada pessoa com o email e o papel (Patrão, RH, Contabilidade,
   Logística/Tráfego, Condutor, Mecânico, Marketing) e enviar o convite (📤).
4. A pessoa cria conta no site com esse email e entra logo na empresa.

Todos podem pedir férias/folgas e reportar problemas nas carrinhas. O que cada papel vê e faz é
escolhido pelo patrão em **Equipa → O que cada papel pode fazer**; as regras são aplicadas também
na base de dados (Row Level Security), não só no ecrã.

### Avisos automáticos no Painel
- 🎂 Aniversários: 1 dia antes e no próprio dia (RH e Marketing; permissão "avisos_aniversarios"). Também os anos de casa.
- 🏖️ Férias aprovadas que começam nos próximos 7 dias (RH e Logística; permissão "avisos_ferias").
- 👤 Cada pessoa é lembrada de completar telemóvel e data de nascimento; o RH vê quem tem dados em falta.

## Salários, clientes, escalas e relatórios (atualização 3)
Correr `supabase/equipa-3.sql` no Supabase (uma vez).
- **Entrar primeiro:** com a internet ligada, o site abre no ecrã de entrada.
- **💶 Salários** (RH, Contabilidade, Patrão): fichas (ordenado, IRS %, sub. alimentação, NIF/NISS/IBAN),
  processamento mensal com faltas, horas extra (+25 % / +37,5 % / +50 %), adiantamentos, 14 ordenados
  (subsídios de férias e Natal nos meses escolhidos), SS, IRS, FCT, seguro AT, custo empresa, mapa (PDF/Excel).
  Sem km nem ajudas de custo. Cada pessoa vê só os seus recibos depois de o mês ser fechado.
- **🏢 Clientes** (Viagens → Clientes): ficha, histórico, faturado, por cobrar, preço habitual €/km.
- **📅 Escalas** (Equipa → Escalas): turnos por pessoa/carrinha, repetição, avisos de conflitos e férias.
- **📄 Relatórios em PDF:** relatório do mês, mapa de salários e recibos (imprimir / guardar como PDF).

## 🔔 Notificações no telemóvel (Web Push)
1. Correr `supabase/notificacoes.sql` no Supabase (ativa pg_net e pg_cron, cria as tabelas e o resumo das 07:30).
2. Supabase → **Edge Functions → Deploy a new function → Via editor**, nome **`notificar`**, colar
   `supabase/functions/notificar/index.ts` → Deploy. Depois, nas definições da função, **desligar "Verify JWT"**
   (a função tem a sua própria proteção: segredo guardado na base de dados).
3. No site: **⚙️ Mais → 🔔 Ativar neste telemóvel** (no iPhone, abrir pelo ícone do ecrã principal; iOS 16.4+).

As chaves VAPID e o segredo são criados sozinhos na primeira utilização e ficam em `push_config` (sem acesso pelo site).
Avisos na hora: pedidos de férias (quem aprova), respostas às férias, avarias (mecânico/logística; urgentes ficam no ecrã),
problema resolvido, recibo fechado, turnos novos. Resumo diário: aniversários, férias da equipa, turno do dia,
seguro/inspeção/IUC a terminar, pedidos por aprovar e problemas abertos.

## 🔒 Desbloqueio e folha de salários completa
- Ao abrir a app (e ao voltar depois de X minutos em segundo plano, por defeito 5) é pedido o **Face ID / impressão
  digital**, o **PIN** (4–6 números, guardado só como impressão cifrada no telemóvel) ou a **palavra-passe**.
  5 PIN errados → sai da conta. Configurar em **Mais → Segurança**. O PIN e o Face ID funcionam sem internet.
- **Folha de salários** (Equipa → Salários): todas as colunas do mapa (tempo, abonos, descontos, sub. alimentação,
  a receber, SS empresa, FCT, seguro AT, custo), edição direta nos rascunhos, fechar/pagar todos, e **resumo do ano**
  mês a mês por pessoa (a receber / bruto / custo) com subsídios de férias e Natal.

## 👤 Contas criadas pelo RH e PIN obrigatório
- Ao adicionar uma pessoa, o RH/Patrão pode pôr uma **palavra-passe inicial**: a conta é criada logo pela Edge Function
  (só para pessoas já na equipa e só por quem tem "pessoas_gerir"), e pode enviar os dados por WhatsApp.
- **1.ª entrada:** a pessoa escolhe a sua palavra-passe (a do RH deixa de funcionar) e cria o **PIN obrigatório**;
  pode ativar o Face ID. Depois disso a app abre sempre com PIN/Face ID.
- **Esqueci-me do PIN:** envia o email de recuperação, apaga o PIN do telemóvel e sai; ao voltar a entrar cria um PIN novo.
- Telemóvel com sessão mas sem PIN → pede primeiro a palavra-passe e só depois deixa criar o PIN.
- Requer a versão nova de `supabase/functions/notificar/index.ts` publicada no Supabase.
- **Mandar alguém embora:** Equipa → Pessoas → 🗑️ → escolher "só tirar da equipa" ou "apagar também a conta".
  Apagar a conta (pela Edge Function) remove o email/palavra-passe no Supabase e as notificações; o trabalho feito fica guardado.

## 🧭 Painel por papel e documentos do condutor (atualização 4)
Correr `supabase/equipa-4.sql` no Supabase (uma vez) e voltar a publicar a função (Edge Functions → notificar → Code → colar `supabase/functions/notificar/index.ts` → Deploy, com "Verify JWT" desligado).
- **Painel** mostra o que interessa a cada papel: condutor (turno de hoje, a sua carrinha, últimas viagens), logística (escala do dia, estado da frota), RH (aniversários, ausências, salários do mês, documentos a tratar), patrão/contabilidade (tudo + finanças).
- **Documentos do condutor**: validade da carta (e categorias), cartão de tacógrafo e exame médico. Preenche-se em Equipa → Pessoas ("Documentos de condução") ou pelo próprio em Equipa → "🪪 Os meus documentos".
- Avisos no site e notificação diária aos 60, 30 e 7 dias, no dia e depois de expirar; a escala avisa se o condutor tem a carta expirada.

## 📄 Guias de transporte e documentos das viagens (atualização 5)
Correr `supabase/equipa-5.sql` no Supabase (uma vez) e voltar a publicar a função `notificar`.
- **Guias** (Equipa → 📄 Guias): o condutor ou a logística pedem a guia e dizem a carga, o dia e o local. O RH anexa o PDF (e o nº). O condutor e a logística são avisados. Enquanto não estiver pronta, o condutor vê "⛔ não saia do local de carga sem a guia".
- Permissões novas: `guias_pedir` (condutor, logística), `guias_fazer` (RH) e `guias_ver_todas` (logística).
- **Viagens → 📎 Outros documentos**: CMR, contrato de transporte, comprovativo de entrega… Pode juntar vários ficheiros a cada viagem; quem vê a viagem vê os documentos.

## 🏠 Casas das Obras (site à parte)
Fotos semanais das casas das obras, com regras e avisos aos encarregados: ver [`obras/README.md`](obras/README.md).
