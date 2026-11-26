// Ligação à base de dados (Supabase) — projeto próprio das Casas das Obras
// (separado do site dos transportes).
// A chave aqui é a pública ("publishable"). NUNCA coloque aqui a chave "secret" / "service_role".
window.CASAS_NUVEM = {
  url: 'https://pxeykqczmjffadtmiqwt.supabase.co',
  chave: 'sb_publishable_Win7v6dRgNAjFadJ436BFA_Mix9pDm3',
  // Nome (slug) da Edge Function dos avisos no Supabase → Edge Functions
  funcao: 'casas-avisos',
};
