create table public.bank_memories (
  id uuid not null default extensions.uuid_generate_v4 (),
  memory_id_hash text not null,
  user_id text not null,
  scope text not null default 'private'::text,
  content text not null,
  embedding public.vector null,
  confidence_score double precision null default 1.0,
  created_at timestamp with time zone null default now(),
  expires_at timestamp with time zone null,
  metadata jsonb null,
  constraint bank_memories_pkey primary key (id),
  constraint bank_memories_memory_id_hash_key unique (memory_id_hash)
) TABLESPACE pg_default;

create index IF not exists bank_memories_embedding_idx on public.bank_memories using hnsw (embedding vector_cosine_ops)
with
  (m = '16', ef_construction = '64') TABLESPACE pg_default;