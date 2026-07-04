package model

import (
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type Claims struct {
	Sub     string `json:"sub"`
	Email   string `json:"email"`
	Role    string `json:"role"`
	GroupID string `json:"group_id,omitempty"`
	jwt.RegisteredClaims
}

type Group struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	Priority  int       `json:"priority"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type User struct {
	ID              uuid.UUID  `json:"id"`
	Email           string     `json:"email"`
	PasswordHash    string     `json:"-"`
	Role            string     `json:"role"`
	GroupID         *uuid.UUID `json:"group_id,omitempty"`
	MustChangePassword bool    `json:"must_change_password"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
	DeletedAt       *time.Time `json:"deleted_at,omitempty"`
}

type Benchmark struct {
	ID               uuid.UUID              `json:"id"`
	UserID           uuid.UUID              `json:"user_id"`
	Name             string                 `json:"name"`
	OriginalFilename string                 `json:"original_filename"`
	FileSize         int64                  `json:"file_size"`
	FileChecksum     string                 `json:"file_checksum"`
	FileExt          string                 `json:"file_ext"`
	Status           string                 `json:"status"`
	Compressors      map[string]interface{} `json:"compressors"`
	Error            *string                `json:"error,omitempty"`
	CreatedAt        time.Time              `json:"created_at"`
	StartedAt        *time.Time             `json:"started_at,omitempty"`
	FinishedAt       *time.Time             `json:"finished_at,omitempty"`
	UpdatedAt        time.Time              `json:"updated_at"`
}

type BenchmarkResult struct {
	ID                          uuid.UUID  `json:"id"`
	BenchmarkID                 uuid.UUID  `json:"benchmark_id"`
	Compressor                  string     `json:"compressor"`
	Dataset                     string     `json:"dataset"`
	NumValues                   *int64     `json:"num_values,omitempty"`
	OriginalSize                *int64     `json:"original_size,omitempty"`
	MemoryUsage                 *int64     `json:"memory_usage,omitempty"`
	UncompressedBits            *int64     `json:"uncompressed_bits,omitempty"`
	CompressedBits              *int64     `json:"compressed_bits,omitempty"`
	CompressionRatio            *float64   `json:"compression_ratio,omitempty"`
	CompressionThroughputMbs    *float64   `json:"compression_throughput_mbs,omitempty"`
	DecompressionThroughputMbs  *float64   `json:"decompression_throughput_mbs,omitempty"`
	RandomAccessNs              *float64   `json:"random_access_ns,omitempty"`
	RandomAccessMbs             *float64   `json:"random_access_mbs,omitempty"`
	RangeQueries                []byte     `json:"-"` // JSONB
}

type EmailOutbox struct {
	ID           uuid.UUID `json:"id"`
	ToAddress    string    `json:"to_address"`
	Subject      string    `json:"subject"`
	Body         string    `json:"body"`
	Status       string    `json:"status"`
	RetryCount   int       `json:"retry_count"`
	ScheduledFor time.Time `json:"scheduled_for"`
	CreatedAt    time.Time `json:"created_at"`
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type LoginResponse struct {
	Token string `json:"token"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}

type ConfigResponse struct {
	MaxFileSizeMB int64 `json:"maxFileSizeMb"`
	SMTPEnabled   bool  `json:"smtpEnabled"`
}
