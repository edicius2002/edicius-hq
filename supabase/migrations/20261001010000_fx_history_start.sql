-- Every USD/PEN source's history starts at 2026-10-01 00:00 America/Lima (owner
-- decision, 2026-10-01). The collector drops anything earlier since #255; this
-- removes the BCRP and SBS rows loaded before that rule existed.
delete from public.fx_observations where effective_at < timestamptz '2026-10-01T05:00:00Z';
