# Casas das Obras — fotos semanais das casas

Site à parte do dos transportes, na pasta `obras/`:
**https://joaotomasfreitas7070-lang.github.io/Cami-es-empresa-/obras/**

## O que faz
- **Encarregados** (no telemóvel): veem só as suas casas. Todas as semanas, para cada casa, tiram fotos
  de cada divisão obrigatória, respondem às perguntas (Sim/Não), escolhem o estado da casa
  (Bom / Precisa de atenção / Mau), o nº de pessoas a viver e escrevem os problemas. Depois carregam em **Entregar**.
- **Gestor**: vê a semana (entregues a tempo, com atraso, em falta, com problemas, por ver), abre cada
  relatório com as fotos, comenta, marca como visto / problema resolvido ou devolve para refazer.
  Vê o **cumprimento de cada encarregado** (% a tempo nas últimas 8 semanas), gere casas, pessoas e regras.

## Regras (o servidor recusa relatórios que não as cumpram)
- Prazo semanal (por defeito **sexta às 18:00**). Entregas depois do prazo ficam marcadas **atrasadas**;
  depois de domingo a semana fica **não entregue** e já não se pode entregar.
- Mínimo de fotos por casa (6) e pelo menos uma de cada divisão obrigatória.
- Só fotos tiradas na própria semana; cada foto fica com **data, hora, divisão e casa** escritas na imagem.
- Todas as perguntas respondidas e estado escolhido.
- Depois de entregue, o encarregado **não pode alterar nem apagar** nada (só o gestor pode devolver).
- Cada encarregado só vê as suas casas e fotos (Row Level Security no Supabase, não só no ecrã).
Tudo isto é configurável em **📋 Regras**.

## Avisos no telemóvel
- Segunda às 8h: "nova semana" com a lista das casas.
- Véspera do prazo às 18h, no dia às 9h e 2 horas antes: lembrete a quem tem casas por entregar.
- Fim do prazo: aviso a quem falhou + resumo para o gestor. Depois, todos os dias às 9h até domingo.
- Relatório com problema / casa em mau estado: aviso imediato ao gestor.
- Comentário do gestor: aviso ao encarregado.
- Botão **🔔 Lembrar** (e WhatsApp) para chamar um encarregado atrasado.

No iPhone os avisos só funcionam com o site adicionado ao ecrã principal (Safari → Partilhar →
Adicionar ao ecrã principal), iOS 16.4 ou mais recente.

## Instalar (uma vez)
Projeto Supabase próprio (organização "Casas empresa", ref `pxeykqczmjffadtmiqwt`), separado dos transportes. Já está instalado: base de dados, 33 casas e função dos avisos.
1. Supabase → **SQL Editor** → colar `supabase/1-criar-tabelas.sql` → Run.
2. Colar `supabase/2-casas-do-excel.sql` → Run (33 casas ativas de Portugal do Excel; as riscadas ficaram de fora).
3. **Edge Functions → Deploy a new function → Via editor**, nome **`casas-avisos`**, colar
   `supabase/functions/casas-avisos/index.ts` → Deploy. Nas definições da função, **desligar "Verify JWT"**.
   Se o Supabase lhe der outro nome, ponha esse nome em `config.js` (`funcao`).
4. Abrir o site → escrever email e palavra-passe → **Criar conta** → confirmar o email → Entrar: **a primeira pessoa a entrar fica gestora**.
5. **👷 Pessoas → + Adicionar** cada encarregado (nome, email, telemóvel) → **🔑 Criar conta** → enviar por WhatsApp.
6. **🏠 Casas**: marcar as casas e atribuir o encarregado de cada uma.
7. Cada pessoa liga os avisos no seu telemóvel (botão na página inicial ou no nome, em cima à direita).

## Espaço das fotos
As fotos são reduzidas (~200 KB cada). O plano gratuito do Supabase tem 1 GB de armazenamento:
com ~33 casas × 6 fotos por semana são cerca de 40 MB por semana. Com 12 semanas guardadas (~500 MB) cabe no plano gratuito: as fotos com mais de
**12 semanas** são apagadas sozinhas (os relatórios e respostas ficam). Mude em **Regras → Guardar as fotos durante**
ou passe para o plano Pro (100 GB) para guardar mais tempo.
