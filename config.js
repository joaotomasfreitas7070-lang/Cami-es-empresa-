// Ligação à base de dados na internet (Supabase).
// "url" e "chave" vêm de Supabase → Project Settings → API.
// A chave aqui é a pública ("anon" / "publishable"): pode estar no site,
// porque cada pessoa só consegue ler e alterar os seus próprios dados.
// NUNCA coloque aqui a chave "service_role" / "secret".
window.FROTA_NUVEM = {
  url: '',
  chave: '',
};
