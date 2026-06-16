create table public.ai_treaty_nonces (
  origin_ai_id text not null,
  nonce text not null,
  created_at timestamp with time zone null default now(),
  expires_at timestamp with time zone not null,
  constraint ai_treaty_nonces_pkey primary key (origin_ai_id, nonce)
) TABLESPACE pg_default;