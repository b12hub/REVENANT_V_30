create table public.audit_ledger (
  id uuid not null default gen_random_uuid (),
  traceparent text not null,
  trace_id text null,
  metadata jsonb null,
  ops_stream jsonb null,
  audit_stream jsonb null,
  economics jsonb null,
  created_at timestamp with time zone null default now(),
  constraint audit_ledger_pkey primary key (id)
) TABLESPACE pg_default;

create index IF not exists idx_audit_ledger_economics on public.audit_ledger using gin (economics) TABLESPACE pg_default;

create index IF not exists idx_audit_ledger_created_at on public.audit_ledger using btree (created_at desc) TABLESPACE pg_default;