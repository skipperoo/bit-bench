export interface Config {
  maxFileSizeMb: number
  smtpEnabled: boolean
}

export interface LoginRequest {
  email: string
  password: string
}

export interface LoginResponse {
  token: string
}

export interface CompressorOption {
  type: 'number' | 'boolean' | 'select'
  min?: number
  max?: number
  default: unknown
  step?: number
  options?: string[]
}

export type CompressorRegistry = Record<string, Record<string, CompressorOption>>

export interface Benchmark {
  id: string
  user_id: string
  name: string
  original_filename: string
  file_size: number
  file_checksum: string
  file_ext: string
  status: 'queued' | 'in_progress' | 'ready' | 'failed' | 'timed_out' | 'cancelled'
  compressors: Record<string, Record<string, unknown>>
  error?: string
  progress?: number
  created_at: string
  started_at?: string
  finished_at?: string
}

export interface BenchmarkResult {
  id: string
  benchmark_id: string
  compressor: string
  dataset: string
  num_values?: number
  original_size?: number
  memory_usage?: number
  input_buffer?: number
  compressor_internal?: number
  internal_memory_ratio?: number
  relative_memory_usage?: number
  uncompressed_bits?: number
  compressed_bits?: number
  compression_ratio?: number
  compression_throughput_mbs?: number
  decompression_throughput_mbs?: number
  random_access_ns?: number
  random_access_mbs?: number
  range_queries?: Record<string, number>
}

export interface BenchmarkStatus {
  status: string
  started_at?: string
  finished_at?: string
  error?: string
}

export interface StatusStats {
  queued: number
  in_progress: number
  ready: number
  failed: number
  timed_out: number
  cancelled: number
}

export interface RunnerStatus {
  running: number
  max_parallelism: number
}

export interface QueueStatus {
  queue_depth: number
  runner: RunnerStatus
  stats: StatusStats
}

export interface BenchmarkListResponse {
  benchmarks: Benchmark[]
  next_cursor?: string
}

export interface BenchmarkDetailResponse {
  benchmark: Benchmark
  results: BenchmarkResult[]
}

export interface CompareResponse {
  benchmarks: Benchmark[]
  results: Record<string, BenchmarkResult[]>
}
