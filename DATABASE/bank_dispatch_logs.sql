create table public.bank_dispatch_logs (
  idempotence_key text not null default 'N/A'::text,
  approval_id text null,
  trace_id text not null,
  channel text not null,
  status text not null default 'pending'::text,
  locked_at timestamp with time zone null,
  dispatched_at timestamp with time zone null,
  retry_count integer null default 0,
  max_retries integer null default 3,
  dispatch_id text null,
  dispatch_result jsonb null,
  error_message text null,
  advisory_hash text not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  details text null,
  dispatch_payload jsonb null,
  constraint bank_dispatch_logs_pkey primary key (idempotence_key),
  constraint unique_idempotence unique (idempotence_key),
  constraint bank_dispatch_logs_approval_id_fkey foreign KEY (approval_id) references bank_approvals (approval_id),
  constraint bank_dispatch_logs_status_check check (
    (
      status = any (
        array[
          'pending'::text,
          'locked'::text,
          'dispatched'::text,
          'failed'::text,
          'retry_pending'::text,
          'HALTED_DUPLICATE'::text
        ]
      )
    )
  )
) TABLESPACE pg_default;

create index IF not exists idx_dispatch_approval_id on public.bank_dispatch_logs using btree (approval_id) TABLESPACE pg_default;

create index IF not exists idx_dispatch_trace_id on public.bank_dispatch_logs using btree (trace_id) TABLESPACE pg_default;

create index IF not exists idx_dispatch_status on public.bank_dispatch_logs using btree (status, created_at) TABLESPACE pg_default;

create index IF not exists idx_dispatch_retry on public.bank_dispatch_logs using btree (status, retry_count, created_at) TABLESPACE pg_default
where
  (status = 'retry_pending'::text);