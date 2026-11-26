-- Read-only share links for a set of benchmarks. Private links carry a random
-- token and open only for the listed recipients (and the owner); public links
-- carry a stable id derived from the benchmark set and open for anyone.
CREATE TABLE IF NOT EXISTS shares (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       VARCHAR(8) NOT NULL CHECK (kind IN ('private', 'public')),
    token      VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ,              -- NULL = never
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares (owner_id);

-- Deleting a benchmark drops it from every share.
CREATE TABLE IF NOT EXISTS share_benchmarks (
    share_id     UUID NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    benchmark_id UUID NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
    position     INT NOT NULL,
    PRIMARY KEY (share_id, benchmark_id)
);
CREATE INDEX IF NOT EXISTS idx_share_benchmarks_benchmark ON share_benchmarks (benchmark_id);

CREATE TABLE IF NOT EXISTS share_recipients (
    share_id UUID NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (share_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_share_recipients_user ON share_recipients (user_id);
