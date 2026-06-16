create table public.bank_webhook_nonces (
  nonce_key text not null,
  approval_id text not null,
  webhook_hmac text not null,
  created_at timestamp with time zone not null default now(),
  used_at timestamp with time zone null,
  constraint bank_webhook_nonces_pkey primary key (nonce_key),
  constraint bank_webhook_nonces_approval_id_fkey foreign KEY (approval_id) references bank_approvals (approval_id)
) TABLESPACE pg_default;

create index IF not exists idx_nonces_approval on public.bank_webhook_nonces using btree (approval_id) TABLESPACE pg_default;