create table public.translation_memory (
  id uuid not null default gen_random_uuid (),
  source_hash text not null,
  source_segment text not null,
  target_segment text not null,
  is_locked boolean null default false,
  quality_score double precision not null default 1.0,
  created_at timestamp with time zone not null default now(),
  constraint translation_memory_pkey primary key (id)
) TABLESPACE pg_default;

create unique INDEX IF not exists idx_tm_hash_unique on public.translation_memory using btree (source_hash) TABLESPACE pg_default;

create index IF not exists idx_tm_fuzzy_trigram on public.translation_memory using gin (source_segment gin_trgm_ops) TABLESPACE pg_default;