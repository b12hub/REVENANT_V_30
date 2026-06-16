create table public.semantic_chunks (
  id uuid not null default gen_random_uuid (),
  document_id uuid not null,
  assignment_id uuid not null,
  chunk_index integer not null,
  chunk_text text not null,
  chunk_hash text not null,
  embedding public.vector null,
  created_at timestamp with time zone not null default now(),
  constraint semantic_chunks_pkey primary key (id),
  constraint semantic_chunks_assignment_id_fkey foreign KEY (assignment_id) references assignments (id) on delete CASCADE,
  constraint semantic_chunks_document_id_fkey foreign KEY (document_id) references research_documents (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists idx_chunks_doc_id on public.semantic_chunks using btree (document_id) TABLESPACE pg_default;

create index IF not exists idx_chunks_assignment_id on public.semantic_chunks using btree (assignment_id) TABLESPACE pg_default;

create index IF not exists idx_semantic_chunks_vector_hnsw on public.semantic_chunks using hnsw (embedding vector_cosine_ops) TABLESPACE pg_default;

create index IF not exists idx_chunks_text_fts on public.semantic_chunks using gin (to_tsvector('english'::regconfig, chunk_text)) TABLESPACE pg_default;