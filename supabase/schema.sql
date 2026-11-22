-- Proposed staging schema for Takuwae cross-device sync. NOT yet deployed.
-- Run only after reviewing RLS and migration behavior in the development project.
-- Stores records independently; never overwrite one device's full ledger JSON.
create table if not exists public.takuwae_records (
  owner_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('transaction','bill','bill_month','fund','setting','closing','rollover')),
  entity_id text not null,
  payload jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision >= 1),
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_id, entity_type, entity_id)
);
create index if not exists takuwae_records_owner_changed
  on public.takuwae_records(owner_id, updated_at);

alter table public.takuwae_records enable row level security;
revoke all on public.takuwae_records from anon;
grant select, insert, update, delete on public.takuwae_records to authenticated;

drop policy if exists takuwae_select_own on public.takuwae_records;
create policy takuwae_select_own on public.takuwae_records
 for select to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists takuwae_insert_own on public.takuwae_records;
create policy takuwae_insert_own on public.takuwae_records
 for insert to authenticated with check ((select auth.uid()) = owner_id);

-- Direct updates/deletes are deliberately NOT granted by policy:
-- changing an existing record will require a separately audited version-checking RPC.
-- This prevents accidental last-writer-wins overwrites during development.
-- Revoke privileges to enforce this even if an unexpected policy is added.
revoke update, delete on public.takuwae_records from authenticated;
-- Future: build atomic save RPC with expected_revision, owner check,
-- conflict error and idempotency key, then test under concurrent devices.
