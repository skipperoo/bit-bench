-- ============================================================
-- 0006_compressor_packages.sql
-- User-uploaded compressor packages (professor/phd/admin).
-- ============================================================

CREATE TABLE compressor_packages (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id         UUID REFERENCES groups(id) ON DELETE SET NULL,
    name             VARCHAR(64) UNIQUE NOT NULL,
    version          VARCHAR(32) NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    language         VARCHAR(16) NOT NULL DEFAULT '',
    entrypoint       TEXT NOT NULL,
    workers          INT NOT NULL DEFAULT 1 CHECK (workers >= 1),
    spec             JSONB NOT NULL,
    status           VARCHAR(12) NOT NULL DEFAULT 'building'
                     CHECK (status IN ('building', 'ready', 'failed')),
    error            TEXT,
    archive_checksum CHAR(32) NOT NULL,
    built_path       TEXT,
    build_log        TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON compressor_packages (owner_id);
CREATE INDEX ON compressor_packages (group_id);
CREATE INDEX ON compressor_packages (status) WHERE status = 'ready';
