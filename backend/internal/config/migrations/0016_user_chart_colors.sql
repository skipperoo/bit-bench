-- Per-user overrides of the chart colours: {"<compressor label>": "#rrggbb"}.
-- Compressors without an entry keep the default colour every user sees.
ALTER TABLE users ADD COLUMN IF NOT EXISTS chart_colors JSONB NOT NULL DEFAULT '{}'::jsonb;
