package repository

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"bitbench/internal/model"
)

type BenchmarkResultRepository struct {
	db *pgxpool.Pool
}

func NewBenchmarkResultRepository(db *pgxpool.Pool) *BenchmarkResultRepository {
	return &BenchmarkResultRepository{db: db}
}

func (r *BenchmarkResultRepository) Insert(ctx context.Context, res *model.BenchmarkResult) error {
	res.ID = uuid.New()

	if res.RangeQueries == nil {
		res.RangeQueries = json.RawMessage("{}")
	}

	_, err := r.db.Exec(ctx, `
		INSERT INTO benchmark_results
			(id, benchmark_id, compressor, dataset, num_values, original_size, memory_usage,
			 input_buffer, compressor_internal, internal_memory_ratio, relative_memory_usage,
			 uncompressed_bits, compressed_bits, compression_ratio,
			 compression_throughput_mbs, decompression_throughput_mbs,
			 random_access_ns, random_access_mbs, range_queries)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
		ON CONFLICT (benchmark_id, compressor) DO UPDATE SET
			compression_ratio = EXCLUDED.compression_ratio,
			compression_throughput_mbs = EXCLUDED.compression_throughput_mbs,
			decompression_throughput_mbs = EXCLUDED.decompression_throughput_mbs,
			memory_usage = EXCLUDED.memory_usage,
			input_buffer = EXCLUDED.input_buffer,
			compressor_internal = EXCLUDED.compressor_internal,
			internal_memory_ratio = EXCLUDED.internal_memory_ratio,
			relative_memory_usage = EXCLUDED.relative_memory_usage,
			random_access_ns = EXCLUDED.random_access_ns,
			random_access_mbs = EXCLUDED.random_access_mbs,
			range_queries = EXCLUDED.range_queries
	`, res.ID, res.BenchmarkID, res.Compressor, res.Dataset,
		res.NumValues, res.OriginalSize, res.MemoryUsage,
		res.InputBuffer, res.CompressorInternal, res.InternalMemoryRatio, res.RelativeMemoryUsage,
		res.UncompressedBits, res.CompressedBits, res.CompressionRatio,
		res.CompressionThroughputMbs, res.DecompressionThroughputMbs,
		res.RandomAccessNs, res.RandomAccessMbs, res.RangeQueries)
	return err
}

func (r *BenchmarkResultRepository) FindByBenchmarkID(ctx context.Context, benchmarkID uuid.UUID) ([]*model.BenchmarkResult, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, benchmark_id, compressor, dataset, num_values, original_size, memory_usage,
		       input_buffer, compressor_internal, internal_memory_ratio, relative_memory_usage,
		       uncompressed_bits, compressed_bits, compression_ratio,
		       compression_throughput_mbs, decompression_throughput_mbs,
		       random_access_ns, random_access_mbs, range_queries
		FROM benchmark_results WHERE benchmark_id = $1
		ORDER BY compressor
	`, benchmarkID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []*model.BenchmarkResult
	for rows.Next() {
		r := &model.BenchmarkResult{}
		if err := rows.Scan(
			&r.ID, &r.BenchmarkID, &r.Compressor, &r.Dataset,
			&r.NumValues, &r.OriginalSize, &r.MemoryUsage,
			&r.InputBuffer, &r.CompressorInternal, &r.InternalMemoryRatio, &r.RelativeMemoryUsage,
			&r.UncompressedBits, &r.CompressedBits, &r.CompressionRatio,
			&r.CompressionThroughputMbs, &r.DecompressionThroughputMbs,
			&r.RandomAccessNs, &r.RandomAccessMbs, &r.RangeQueries,
		); err != nil {
			return nil, err
		}
		results = append(results, r)
	}
	return results, nil
}

func (r *BenchmarkResultRepository) FindByBenchmarkIDs(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID][]*model.BenchmarkResult, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, benchmark_id, compressor, dataset, num_values, original_size, memory_usage,
		       input_buffer, compressor_internal, internal_memory_ratio, relative_memory_usage,
		       uncompressed_bits, compressed_bits, compression_ratio,
		       compression_throughput_mbs, decompression_throughput_mbs,
		       random_access_ns, random_access_mbs, range_queries
		FROM benchmark_results WHERE benchmark_id = ANY($1)
		ORDER BY benchmark_id, compressor
	`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[uuid.UUID][]*model.BenchmarkResult)
	for rows.Next() {
		r := &model.BenchmarkResult{}
		if err := rows.Scan(
			&r.ID, &r.BenchmarkID, &r.Compressor, &r.Dataset,
			&r.NumValues, &r.OriginalSize, &r.MemoryUsage,
			&r.InputBuffer, &r.CompressorInternal, &r.InternalMemoryRatio, &r.RelativeMemoryUsage,
			&r.UncompressedBits, &r.CompressedBits, &r.CompressionRatio,
			&r.CompressionThroughputMbs, &r.DecompressionThroughputMbs,
			&r.RandomAccessNs, &r.RandomAccessMbs, &r.RangeQueries,
		); err != nil {
			return nil, err
		}
		result[r.BenchmarkID] = append(result[r.BenchmarkID], r)
	}
	return result, nil
}
