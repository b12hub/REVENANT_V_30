create view public.dashboard_feed as
select
  created_at,
  approval_id,
  channel,
  status,
  dispatch_payload ->> 'internal_reference'::text as reference_id,
  dispatch_payload
from
  bank_dispatch_logs
where
  channel = 'INTERNAL_UI'::text
order by
  created_at desc;