CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- GROUPS (workload priority)
-- ============================================================
CREATE TABLE groups (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(100) UNIQUE NOT NULL,
    priority    INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- USERS  (admin-created only; D1)
-- ============================================================
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(10) NOT NULL CHECK (role IN ('admin','user')) DEFAULT 'user',
    group_id      UUID REFERENCES groups(id) ON DELETE SET NULL,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ
);

-- ============================================================
-- BENCHMARKS  (also the job queue; D3)
-- ============================================================
CREATE TABLE benchmarks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    original_filename VARCHAR(255) NOT NULL,
    file_size       BIGINT NOT NULL,
    file_checksum   CHAR(32) UNIQUE NOT NULL,
    file_ext        VARCHAR(10) NOT NULL,
    status          VARCHAR(12) NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','in_progress','ready','failed','timed_out','cancelled')),
    compressors     JSONB NOT NULL,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- BENCHMARK RESULTS  (one averaged row per compressor; D6)
-- ============================================================
CREATE TABLE benchmark_results (
    id                              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    benchmark_id                    UUID NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
    compressor                      VARCHAR(64) NOT NULL,
    dataset                         VARCHAR(128) NOT NULL,
    num_values                      BIGINT,
    original_size                   BIGINT,
    memory_usage                    BIGINT,
    uncompressed_bits               BIGINT,
    compressed_bits                 BIGINT,
    compression_ratio               DOUBLE PRECISION,
    compression_throughput_mbs      DOUBLE PRECISION,
    decompression_throughput_mbs    DOUBLE PRECISION,
    random_access_ns                DOUBLE PRECISION,
    random_access_mbs               DOUBLE PRECISION,
    range_queries                   JSONB,
    UNIQUE (benchmark_id, compressor)
);

-- ============================================================
-- EMAIL OUTBOX  (only used when SMTP enabled)
-- ============================================================
CREATE TABLE email_outbox (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    to_address    VARCHAR(255) NOT NULL,
    subject       VARCHAR(255) NOT NULL,
    body          TEXT NOT NULL,
    status        VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
    retry_count   INT NOT NULL DEFAULT 0,
    scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- MIGRATIONS TRACKING
-- ============================================================
CREATE TABLE IF NOT EXISTS _migrations (
    filename    VARCHAR(255) PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_users_email_active ON users (email) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_benchmarks_user ON benchmarks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_benchmarks_status ON benchmarks (status, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_benchmarks_checksum ON benchmarks (file_checksum);
CREATE INDEX IF NOT EXISTS idx_benchmark_results_lookup ON benchmark_results (benchmark_id, compressor);
CREATE INDEX IF NOT EXISTS idx_email_outbox_pending ON email_outbox (status, scheduled_for) WHERE status = 'pending';
