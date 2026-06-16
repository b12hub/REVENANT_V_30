create table public.ai_training_datasets (
  id uuid not null default extensions.uuid_generate_v4 (),
  dataset_name text not null,
  input_vector jsonb not null,
  outcome text null,
  created_at timestamp with time zone null default now(),
  constraint ai_training_datasets_pkey primary key (id)
) TABLESPACE pg_default;