-- Per-signal results: the rows of each dataset series (or uploaded input) of a
-- benchmark, aggregated over that signal's chunks with the benchmark's
-- aggregation method. Stored only when a benchmark has more than one signal;
-- `results` holds the same objects as GET /benchmarks/{id} returns.
CREATE TABLE IF NOT EXISTS benchmark_series_results (
    benchmark_id UUID NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
    series       TEXT NOT NULL,
    results      JSONB NOT NULL,
    PRIMARY KEY (benchmark_id, series)
);
