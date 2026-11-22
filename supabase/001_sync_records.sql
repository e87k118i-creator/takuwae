-- たくわえ同期準備：初期テーブル。既存のiPhoneデータにはアクセスしない。
-- This schema is only a foundation; do not activate multi-device writes before CAS and migration tests.
create table if not exists public.takuwae_sync_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (length(entity_type) between 1 and 64),
  entity_id text not null check (length(entity_id) between 1 and 128),
  payload jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision >= 1),
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id)
);
alter table public.takuwae_sync_records enable row level security;
revoke all on public.takuwae_sync_records from anon;
grant select, insert, update, delete on public.takuwae_sync_records to authenticated;
drop policy if exists "owner_only_records" on public.takuwae_sync_records;
create policy "owner_only_records"
on public.takuwae_sync_records
for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
