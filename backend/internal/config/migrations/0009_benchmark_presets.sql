-- ============================================================
-- 0009_benchmark_presets.sql
-- Saved compressor configurations (private or shared with the owner's
-- group) and a per-user history of recently used configurations that can
-- be promoted to presets.
-- ============================================================

CREATE TABLE benchmark_presets (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id    UUID REFERENCES groups(id) ON DELETE SET NULL,
    name        VARCHAR(100) NOT NULL,
    visibility  VARCHAR(10) NOT NULL DEFAULT 'private'
                CHECK (visibility IN ('private', 'group')),
    compressors JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX benchmark_presets_owner_name_key
    ON benchmark_presets (owner_id, LOWER(name));

CREATE INDEX benchmark_presets_group_idx
    ON benchmark_presets (group_id) WHERE visibility = 'group';

CREATE TABLE benchmark_config_history (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    compressors  JSONB NOT NULL,
    fingerprint  CHAR(64) NOT NULL,
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, fingerprint)
);

CREATE INDEX benchmark_config_history_user_idx
    ON benchmark_config_history (user_id, last_used_at DESC);
