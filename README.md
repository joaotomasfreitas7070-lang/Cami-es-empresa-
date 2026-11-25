# Gestão de Frota

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
No navegador do dispositivo (localStorage). Não vão para a internet. Adicione o site ao ecrã principal,
não apague os dados do Safari e use **Guardar cópia** regularmente.
