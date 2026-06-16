create table public.circuit_breakers (
  service_id character varying(50) not null,
  failure_count integer null default 0,
  status character varying(20) null default 'CLOSED'::character varying,
  last_failure timestamp with time zone null default '-infinity'::timestamp with time zone,
  probe_lock_until timestamp with time zone null default '-infinity'::timestamp with time zone,
  threshold integer null default 5,
  cooldown_seconds integer null default 60,
  constraint circuit_breakers_pkey primary key (service_id),
  constraint circuit_breakers_status_check check (
    (
      (status)::text = any (
        (
          array[
            'CLOSED'::character varying,
            'OPEN'::character varying,
            'HALF_OPEN'::character varying
          ]
        )::text[]
      )
    )
  )
) TABLESPACE pg_default;