-- Number of inputs on which a compressor failed its self-test (decompressed
-- data differs from the input, or the input was not exactly representable for
-- a floating-point compressor). Such results are kept but marked.
ALTER TABLE benchmark_results ADD COLUMN IF NOT EXISTS self_test_failures INT NOT NULL DEFAULT 0;
