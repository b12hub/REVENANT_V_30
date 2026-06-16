create table public.traffic_buckets (
  ip_address inet not null,
  tokens_milli bigint not null default 100000,
  last_refill timestamp with time zone not null default now(),
  constraint traffic_buckets_pkey primary key (ip_address),
  constraint traffic_buckets_tokens_milli_check check ((tokens_milli >= 0))
) TABLESPACE pg_default;