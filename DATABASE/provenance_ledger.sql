create table public.provenance_ledger (
  id uuid not null default gen_random_uuid (),
  assignment_id uuid not null,
  section_id text not null,
  sentence_hash text not null,
  sentence_text text not null,
  claim_type text not null default 'factual'::text,
  evidence_chunk_ids uuid[] not null default '{}'::uuid[],
  support_score double precision not null default 0.0,
  is_verified boolean not null default false,
  created_at timestamp with time zone not null default now(),
  constraint provenance_ledger_pkey primary key (id),
  constraint provenance_ledger_assignment_id_fkey foreign KEY (assignment_id) references assignments (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists idx_provenance_assignment on public.provenance_ledger using btree (assignment_id) TABLESPACE pg_default;

create index IF not exists idx_provenance_sentence_hash on public.provenance_ledger using btree (sentence_hash) TABLESPACE pg_default;