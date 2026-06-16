create table public.draft_sections (
  id uuid not null default gen_random_uuid (),
  assignment_id uuid not null,
  section_id text not null,
  order_index integer not null,
  content_markdown text not null,
  coherence_capsule text null,
  evaluation_scores jsonb null default '{}'::jsonb,
  status text not null default 'DRAFTING'::text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint draft_sections_pkey primary key (id),
  constraint draft_sections_assignment_id_fkey foreign KEY (assignment_id) references assignments (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists idx_draft_sections_assignment on public.draft_sections using btree (assignment_id) TABLESPACE pg_default;

create index IF not exists idx_draft_sections_composite_flow on public.draft_sections using btree (assignment_id, order_index) TABLESPACE pg_default;

create trigger set_timestamp_draft_sections BEFORE
update on draft_sections for EACH row
execute FUNCTION trigger_set_timestamp ();