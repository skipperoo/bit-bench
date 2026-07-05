-- ============================================================
-- 0004_polish.sql
-- Drop file_checksum UNIQUE constraint, add last_bench_config column
-- ============================================================

-- Allow multiple benchmarks on the same file
DROP INDEX IF EXISTS idx_benchmarks_checksum;
ALTER TABLE benchmarks DROP CONSTRAINT IF EXISTS benchmarks_file_checksum_key;

CREATE INDEX IF NOT EXISTS idx_benchmarks_checksum ON benchmarks (file_checksum);

-- Save last benchmark config per user
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_bench_config JSONB DEFAULT '{}'::jsonb;
