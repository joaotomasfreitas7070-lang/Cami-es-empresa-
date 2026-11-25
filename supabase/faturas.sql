-- Cole isto no Supabase → SQL Editor → New query → Run.
-- Cria a pasta privada "faturas": cada conta só vê e mexe nas suas.
insert into storage.buckets (id, name, public)
values ('faturas', 'faturas', false)
on conflict (id) do nothing;

create policy "faturas: ver as minhas" on storage.objects for select to authenticated
  using (bucket_id = 'faturas' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "faturas: enviar as minhas" on storage.objects for insert to authenticated
  with check (bucket_id = 'faturas' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "faturas: alterar as minhas" on storage.objects for update to authenticated
  using (bucket_id = 'faturas' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "faturas: apagar as minhas" on storage.objects for delete to authenticated
  using (bucket_id = 'faturas' and (storage.foldername(name))[1] = (select auth.uid())::text);
