-- Per-user display names for compressors: {"<compressor label>": "<name>"}.
-- Compressors without an entry keep the default name every user sees.
ALTER TABLE users ADD COLUMN IF NOT EXISTS chart_names JSONB NOT NULL DEFAULT '{}'::jsonb;
