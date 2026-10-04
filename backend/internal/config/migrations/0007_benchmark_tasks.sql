-- ============================================================
-- 0007_benchmark_tasks.sql
-- Parallel benchmark tasks: one claimable row per unit of work.
-- Each task costs worker units from the global budget
-- (built-in: 1, custom package: its declared workers).
-- ============================================================

ALTER TABLE benchmarks ADD COLUMN IF NOT EXISTS file_count INT NOT NULL DEFAULT 1;

CREATE TABLE benchmark_tasks (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    benchmark_id UUID NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
    seq          INT NOT NULL,
    kind         VARCHAR(16) NOT NULL CHECK (kind IN ('builtin', 'custom')),
    compressor   VARCHAR(64),               -- custom package name; NULL for builtin
    input_path   TEXT NOT NULL,             -- .bin path relative to DATA_DIR
    workers      INT NOT NULL DEFAULT 1 CHECK (workers >= 1),
    status       VARCHAR(12) NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
    result       JSONB,                     -- []BenchmarkRow produced by this task
    error        TEXT,
    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (benchmark_id, seq)
);

CREATE INDEX ON benchmark_tasks (benchmark_id, status);
CREATE INDEX ON benchmark_tasks (status, created_at) WHERE status = 'queued';
