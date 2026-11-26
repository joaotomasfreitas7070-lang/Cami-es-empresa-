// Ligação à base de dados (Supabase).
// Por defeito usa o mesmo projeto do site dos transportes (as tabelas daqui começam por "casas").
// Para usar um projeto à parte, troque o url e a chave pública ("publishable" / "anon").
// NUNCA coloque aqui a chave "service_role" / "secret".
window.CASAS_NUVEM = {
  url: 'https://elrxjvqitdhovhqfdgdw.supabase.co',
  chave: 'sb_publishable_Kk1tOx8iZoWPPIJLTGyvdw_A_UWNRl9',
  // Nome (slug) da Edge Function dos avisos, tal como aparece no Supabase → Edge Functions
  funcao: 'casas-avisos',
};
