-- ============================================================
-- 0008_instance_labels.sql
-- Multi-instance benchmarks: custom tasks reference the configured
-- instance label (compressor packages may appear several times with
-- different options within one benchmark).
-- ============================================================

ALTER TABLE benchmark_tasks ADD COLUMN IF NOT EXISTS instance_label VARCHAR(64);
