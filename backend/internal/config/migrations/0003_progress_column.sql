-- ============================================================
-- 0003_progress_column.sql
-- Add progress tracking column to benchmarks table
-- ============================================================

ALTER TABLE benchmarks
    ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0;
