-- How a benchmark's per-input rows are combined into one row per compressor,
-- whether the Valgrind Massif memory measurement runs, and, for benchmarks
-- built from a standardized dataset (DATASET_DIR), how the inputs were cut.
ALTER TABLE benchmarks ADD COLUMN IF NOT EXISTS aggregation VARCHAR(16) NOT NULL DEFAULT 'mean';
ALTER TABLE benchmarks ADD COLUMN IF NOT EXISTS measure_memory BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE benchmarks ADD COLUMN IF NOT EXISTS source JSONB;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'benchmarks_aggregation_check') THEN
        ALTER TABLE benchmarks ADD CONSTRAINT benchmarks_aggregation_check
            CHECK (aggregation IN ('mean', 'median', 'pooled'));
    END IF;
END $$;
