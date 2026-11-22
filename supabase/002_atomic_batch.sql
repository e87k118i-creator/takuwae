-- Takuwae v2.1: controlled backend migration.
-- This is a FOLLOW-UP migration after the initial schema.
-- Do not run against a database with unexpected pre-existing Takuwae data.
-- No personal ledger data is contained in this SQL.

-- 1. Every client write must go through the checked, atomic batch API.
-- IMPORTANT: REVOKE ALL also removes TRUNCATE, which bypasses RLS.
revoke all on table public.takuwae_records from public, anon, authenticated;
grant select on table public.takuwae_records to authenticated;

-- A separate, unused prototype table was discovered in the user's project.
-- Preserve its rows/schema but close all browser-facing access to prevent
-- clients from bypassing the version-checked record pipeline.
revoke all on table public.takuwae_sync_records from public, anon, authenticated;

-- Keep RLS enabled so direct reads remain owner-isolated.
alter table public.takuwae_records enable row level security;
drop policy if exists takuwae_insert_own on public.takuwae_records;
drop policy if exists takuwae_select_own on public.takuwae_records;
create policy takuwae_select_own on public.takuwae_records
  for select to authenticated
  using ((select auth.uid()) = owner_id);

-- Idempotency receipts cannot be accessed directly from the browser.
create table if not exists public.takuwae_batch_receipts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid not null,
  request_hash text not null,
  response jsonb not null,
  applied_at timestamptz not null default now(),
  primary key (owner_id, batch_id)
);
alter table public.takuwae_batch_receipts enable row level security;
revoke all on public.takuwae_batch_receipts from public, anon, authenticated;

-- 2. Security-definer write gate, with a verified identity and fixed search_path.
-- Serializes all batches for one owner. That is intentional for a personal ledger.
create or replace function public.takuwae_apply_batch(
  p_batch_id uuid,
  p_operations jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_owner uuid := auth.uid();
  v_op jsonb;
  v_type text;
  v_id text;
  v_key text;
  v_keys text[] := array[]::text[];
  v_payload jsonb;
  v_deleted boolean;
  v_expected bigint;
  v_existing_revision bigint;
  v_next_revision bigint;
  v_hash text;
  v_receipt public.takuwae_batch_receipts%rowtype;
  v_results jsonb := '[]'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if v_owner is null or p_batch_id is null then
    raise exception 'Login and batch_id are required' using errcode = '28000';
  end if;
  if p_operations is null
     or jsonb_typeof(p_operations) <> 'array'
     or jsonb_array_length(p_operations) not between 1 and 250
     or pg_catalog.octet_length(p_operations::text) > 1048576 then
    raise exception 'Invalid batch size' using errcode = '22023';
  end if;

  -- Prevent racing requests from the same user, including retries.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('takuwae:' || v_owner::text, 0)
  );

  v_hash := pg_catalog.md5(p_operations::text);
  select * into v_receipt
  from public.takuwae_batch_receipts
  where owner_id = v_owner and batch_id = p_batch_id;

  if found then
    if v_receipt.request_hash <> v_hash then
      raise exception 'Batch ID reused with different operations'
        using errcode = '22023';
    end if;
    return v_receipt.response;
  end if;

  -- Pass 1: validate the entire batch and detect conflicts; no writes yet.
  for v_op in select value from pg_catalog.jsonb_array_elements(p_operations) loop
    if jsonb_typeof(v_op) <> 'object' then
      raise exception 'Invalid record' using errcode = '22023';
    end if;
    v_type := v_op->>'entity_type';
    v_id := v_op->>'entity_id';
    if v_type is null or v_type not in
      ('transaction','bill','bill_month','fund','setting','closing','rollover')
      or v_id is null or pg_catalog.length(pg_catalog.btrim(v_id)) = 0
      or pg_catalog.length(v_id) > 200 then
      raise exception 'Invalid entity key' using errcode = '22023';
    end if;
    v_key := pg_catalog.jsonb_build_array(v_type,v_id)::text;
    if pg_catalog.array_position(v_keys,v_key) is not null then
      raise exception 'Duplicate record in batch' using errcode = '22023';
    end if;
    v_keys := pg_catalog.array_append(v_keys,v_key);
    if not (v_op ? 'expected_revision')
       or (v_op->'expected_revision' <> 'null'::jsonb
         and jsonb_typeof(v_op->'expected_revision') <> 'number') then
      raise exception 'Expected revision required' using errcode = '22023';
    end if;
    if v_op->>'expected_revision' is not null
       and (v_op->>'expected_revision' !~ '^[0-9]+ and v_expected < 1 then
      raise exception 'Invalid revision' using errcode = '22023';
    end if;
    if jsonb_typeof(v_op->'deleted') <> 'boolean'
       or jsonb_typeof(v_op->'payload') <> 'object' then
      raise exception 'Invalid payload or deleted flag' using errcode = '22023';
    end if;
    v_deleted := (v_op->>'deleted')::boolean;
    if v_type = 'setting' and (v_id <> 'global' or v_deleted) then
      raise exception 'Global settings cannot be deleted' using errcode = '22023';
    end if;

    select revision into v_existing_revision
    from public.takuwae_records
    where owner_id = v_owner and entity_type = v_type and entity_id = v_id;

    if v_existing_revision is distinct from v_expected
       or (v_existing_revision is null and v_deleted) then
      v_conflicts := v_conflicts || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'entity_type',v_type,
          'entity_id',v_id,
          'expected_revision',v_expected,
          'server_revision',v_existing_revision
        )
      );
    end if;
  end loop;

  if pg_catalog.jsonb_array_length(v_conflicts) > 0 then
    return pg_catalog.jsonb_build_object(
      'status','conflict', 'conflicts',v_conflicts
    );
  end if;

  -- Pass 2: apply all records in one DB transaction. A failure rolls back all.
  for v_op in select value from pg_catalog.jsonb_array_elements(p_operations) loop
    v_type := v_op->>'entity_type';
    v_id := v_op->>'entity_id';
    if v_op->>'expected_revision' is not null
       and ((v_op->>'expected_revision') !~ '^[0-9]+$'
         or pg_catalog.length(v_op->>'expected_revision') > 18) then
      raise exception 'Invalid integer revision' using errcode = '22023';
    end if;
    v_expected := (v_op->>'expected_revision')::bigint;
    v_payload := v_op->'payload';
    v_deleted := (v_op->>'deleted')::boolean;
    v_next_revision := coalesce(v_expected,0) + 1;

    if v_expected is null then
      insert into public.takuwae_records
        (owner_id,entity_type,entity_id,payload,revision,deleted_at,updated_at)
      values
        (v_owner,v_type,v_id,v_payload,1,null,pg_catalog.now());
    else
      update public.takuwae_records
      set payload = v_payload,
          revision = v_next_revision,
          deleted_at = case when v_deleted then pg_catalog.now() else null end,
          updated_at = pg_catalog.now()
      where owner_id = v_owner
        and entity_type = v_type and entity_id = v_id
        and revision = v_expected;
      if not found then
        raise exception 'Revision changed while applying batch'
          using errcode = '40001';
      end if;
    end if;
    v_results := v_results || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'entity_type',v_type,'entity_id',v_id,
        'revision',v_next_revision,'deleted',v_deleted
      )
    );
  end loop;

  v_result := pg_catalog.jsonb_build_object('status','applied','records',v_results);
  insert into public.takuwae_batch_receipts
    (owner_id,batch_id,request_hash,response)
  values (v_owner,p_batch_id,v_hash,v_result);
  return v_result;
end;
$function$;

-- 3. Supabase functions are executable by PUBLIC by default; revoke first.
revoke all on function public.takuwae_apply_batch(uuid,jsonb)
  from public, anon;
grant execute on function public.takuwae_apply_batch(uuid,jsonb)
  to authenticated;
