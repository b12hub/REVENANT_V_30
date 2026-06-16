create table public.bank_approvals (
  approval_id text not null,
  trace_id text not null,
  advisory_hash text not null,
  approval_request jsonb not null,
  approval_request_hash text not null,
  request_integrity_hash text not null,
  selected_channel text not null,
  created_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone not null,
  consumed boolean null default false,
  consumed_at timestamp with time zone null,
  state text null default 'pending'::text,
  validated_approval jsonb null,
  decision text null,
  approver_id text null,
  approver_role text null,
  approval_timestamp timestamp with time zone null,
  approval_hmac text null,
  hmac_validated boolean null default false,
  block_4_seal_hash text not null,
  block_5_seal_hash text null,
  constraint bank_approvals_pkey primary key (approval_id),
  constraint unique_trace_approval unique (trace_id),
  constraint bank_approvals_decision_check check (
    (
      decision = any (array['APPROVED'::text, 'REJECTED'::text])
    )
  ),
  constraint bank_approvals_state_check check (
    (
      state = any (
        array[
          'pending'::text,
          'approved'::text,
          'rejected'::text,
          'expired'::text,
          'escalated'::text
        ]
      )
    )
  )
) TABLESPACE pg_default;

create index IF not exists idx_bank_approvals_trace_id on public.bank_approvals using btree (trace_id) TABLESPACE pg_default;

create index IF not exists idx_bank_approvals_advisory_hash on public.bank_approvals using btree (advisory_hash) TABLESPACE pg_default;

create index IF not exists idx_bank_approvals_state_created on public.bank_approvals using btree (state, created_at desc) TABLESPACE pg_default;

create index IF not exists idx_bank_approvals_expires on public.bank_approvals using btree (expires_at) TABLESPACE pg_default
where
  (state = 'pending'::text);