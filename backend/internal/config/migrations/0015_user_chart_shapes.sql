-- Per-user overrides of the chart marker shapes: {"<compressor label>": "<shape>"}.
-- Compressors without an entry keep the default shape every user sees.
ALTER TABLE users ADD COLUMN IF NOT EXISTS chart_shapes JSONB NOT NULL DEFAULT '{}'::jsonb;
