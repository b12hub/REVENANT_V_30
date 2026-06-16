create table public.ai_treaties (
  treaty_id text not null,
  idempotency_key uuid GENERATED ALWAYS as ((md5(treaty_id))::uuid) STORED null,
  origin_ai_id text not null,
  jurisdiction text not null,
  amount numeric(18, 2) not null,
  status character varying(30) null,
  treaty_hash text not null,
  previous_treaty_hash text not null,
  response_hash text null,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null,
  executed_at timestamp with time zone null,
  failure_reason text null,
  constraint ai_treaties_pkey primary key (treaty_id),
  constraint ai_treaties_idempotency_key_key unique (idempotency_key),
  constraint ai_treaties_status_check check (
    (
      (status)::text = any (
        (
          array[
            'PROPOSED'::character varying,
            'ACTIVE_PENDING'::character varying,
            'ACTIVE_CONFIRMED'::character varying,
            'EXECUTION_FAILED'::character varying,
            'INDETERMINATE_TIMEOUT'::character varying
          ]
        )::text[]
      )
    )
  )
) TABLESPACE pg_default;