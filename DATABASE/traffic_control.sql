create table public.traffic_control (
  id uuid not null default gen_random_uuid (),
  ip_address text not null,
  request_time timestamp with time zone null default now(),
  constraint traffic_control_pkey primary key (id)
) TABLESPACE pg_default;

create index IF not exists idx_traffic_ip_time on public.traffic_control using btree (ip_address, request_time) TABLESPACE pg_default;