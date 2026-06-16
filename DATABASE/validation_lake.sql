create table public.validation_lake (
  id uuid not null default gen_random_uuid (),
  created_at timestamp with time zone null default now(),
  transaction_id text null,
  transaction_amount numeric not null,
  risk_score numeric not null,
  model_confidence numeric not null,
  consensus_action text not null,
  human_override boolean null default false,
  constraint validation_lake_pkey primary key (id),
  constraint validation_lake_consensus_action_check check (
    (
      consensus_action = any (
        array[
          'APPROVE'::text,
          'DENY'::text,
          'ESCALATE'::text,
          'FAILED'::text
        ]
      )
    )
  )
) TABLESPACE pg_default;

create index IF not exists idx_validation_lake_created_at on public.validation_lake using btree (created_at) TABLESPACE pg_default;