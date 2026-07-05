-- ============================================================
-- 0002_memory_columns.sql
-- Add memory breakdown columns to benchmark_results
-- ============================================================

ALTER TABLE benchmark_results
    ADD COLUMN IF NOT EXISTS input_buffer BIGINT,
    ADD COLUMN IF NOT EXISTS compressor_internal BIGINT,
    ADD COLUMN IF NOT EXISTS internal_memory_ratio DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS relative_memory_usage DOUBLE PRECISION;
