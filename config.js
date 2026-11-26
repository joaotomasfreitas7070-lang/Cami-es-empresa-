// Ligação à base de dados na internet (Supabase).
// A chave aqui é a pública ("publishable"): pode estar no site,
// porque cada pessoa só consegue ler e alterar os seus próprios dados.
// NUNCA coloque aqui a chave "service_role" / "secret".
window.FROTA_NUVEM = {
  url: 'https://elrxjvqitdhovhqfdgdw.supabase.co',
  chave: 'sb_publishable_Kk1tOx8iZoWPPIJLTGyvdw_A_UWNRl9',
  // Endereço (slug) da Edge Function das notificações no Supabase
  funcao: 'smart-handler',
};
