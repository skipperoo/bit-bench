-- Non-fatal problems collected while running a benchmark (e.g. a compressor
-- that produced no result for one input). Shown on the results page.
ALTER TABLE benchmarks ADD COLUMN IF NOT EXISTS warnings TEXT[] NOT NULL DEFAULT '{}';
