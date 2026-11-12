-- An experiment is one submission: a single upload, a "separate benchmarks"
-- upload or a dataset run fanning out into several benchmarks. Existing
-- benchmarks become one-benchmark experiments.
ALTER TABLE benchmarks ADD COLUMN IF NOT EXISTS experiment_id UUID;
UPDATE benchmarks SET experiment_id = id WHERE experiment_id IS NULL;
ALTER TABLE benchmarks ALTER COLUMN experiment_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_benchmarks_experiment ON benchmarks (user_id, experiment_id);
