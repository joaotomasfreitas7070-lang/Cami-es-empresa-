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
1. Correr `supabase/equipa.sql` no Supabase (SQL Editor → Run), uma vez.
2. O patrão entra no site → **Equipa** → *Criar empresa*. Os dados que já existiam passam para a empresa.
3. Em **Equipa → Pessoas**, adicionar cada pessoa com o email e o papel (Patrão, RH, Contabilidade,
   Logística/Tráfego, Condutor, Mecânico, Marketing) e enviar o convite (📤).
4. A pessoa cria conta no site com esse email e entra logo na empresa.

Todos podem pedir férias/folgas e reportar problemas nas carrinhas. O que cada papel vê e faz é
escolhido pelo patrão em **Equipa → O que cada papel pode fazer**; as regras são aplicadas também
na base de dados (Row Level Security), não só no ecrã.
