package repository

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"bitbench/internal/compressor"
	"bitbench/internal/model"
)

type PresetRepository struct {
	db *pgxpool.Pool
}

func NewPresetRepository(db *pgxpool.Pool) *PresetRepository {
	return &PresetRepository{db: db}
}

const presetColumns = `id, owner_id, group_id, name, visibility, compressors, created_at, updated_at`

func scanPreset(row pgx.Row) (*model.BenchmarkPreset, error) {
	p := &model.BenchmarkPreset{}
	var compressorsJSON []byte
	err := row.Scan(&p.ID, &p.OwnerID, &p.GroupID, &p.Name, &p.Visibility, &compressorsJSON, &p.CreatedAt, &p.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	instances, err := compressor.ParseInstances(compressorsJSON)
	if err != nil {
		return nil, err
	}
	p.Compressors = instances
	return p, nil
}

func (r *PresetRepository) Create(ctx context.Context, p *model.BenchmarkPreset) error {
	if p.ID == uuid.Nil {
		p.ID = uuid.New()
	}
	compressorsJSON, err := compressor.MarshalInstances(p.Compressors)
	if err != nil {
		return err
	}
	_, err = r.db.Exec(ctx, `
		INSERT INTO benchmark_presets (id, owner_id, group_id, name, visibility, compressors)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, p.ID, p.OwnerID, p.GroupID, p.Name, p.Visibility, compressorsJSON)
	return err
}

func (r *PresetRepository) FindByID(ctx context.Context, id uuid.UUID) (*model.BenchmarkPreset, error) {
	return scanPreset(r.db.QueryRow(ctx, `SELECT `+presetColumns+` FROM benchmark_presets WHERE id = $1`, id))
}

// ListVisible returns presets visible to the user: own ones plus group-shared
// presets of the user's group; administrators see everything.
func (r *PresetRepository) ListVisible(ctx context.Context, userID uuid.UUID, groupID *uuid.UUID, isAdmin bool) ([]*model.BenchmarkPreset, error) {
	query := `SELECT ` + presetColumns + ` FROM benchmark_presets`
	args := []any{}
	if !isAdmin {
		if groupID != nil {
			query += ` WHERE owner_id = $1 OR (visibility = 'group' AND group_id = $2)`
			args = append(args, userID, *groupID)
		} else {
			query += ` WHERE owner_id = $1`
			args = append(args, userID)
		}
	}
	query += ` ORDER BY updated_at DESC`

	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var presets []*model.BenchmarkPreset
	for rows.Next() {
		p, err := scanPreset(rows)
		if err != nil {
			return nil, err
		}
		presets = append(presets, p)
	}
	return presets, rows.Err()
}

func (r *PresetRepository) Update(ctx context.Context, id uuid.UUID, name string, visibility string, compressors []compressor.Instance) error {
	compressorsJSON, err := compressor.MarshalInstances(compressors)
	if err != nil {
		return err
	}
	_, err = r.db.Exec(ctx, `
		UPDATE benchmark_presets
		SET name = $2, visibility = $3, compressors = $4, updated_at = NOW()
		WHERE id = $1
	`, id, name, visibility, compressorsJSON)
	return err
}

func (r *PresetRepository) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM benchmark_presets WHERE id = $1`, id)
	return err
}

// DeleteHistory removes every configuration of a user (used by tests).
func (r *PresetRepository) DeleteHistory(ctx context.Context, userID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM benchmark_config_history WHERE user_id = $1`, userID)
	return err
}

// FingerprintConfig returns a stable hash of a configuration, independent of
// instance labels.
func FingerprintConfig(instances []compressor.Instance) string {
	type fingerprintInstance struct {
		Name    string                 `json:"name"`
		Options map[string]interface{} `json:"options"`
	}
	items := make([]fingerprintInstance, 0, len(instances))
	for _, inst := range instances {
		items = append(items, fingerprintInstance{Name: inst.Name, Options: inst.Options})
	}
	payload, _ := json.Marshal(items)
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// UpsertHistory records a configuration, refreshing its recency when it was
// already used by the same user.
func (r *PresetRepository) UpsertHistory(ctx context.Context, userID uuid.UUID, instances []compressor.Instance) error {
	compressorsJSON, err := compressor.MarshalInstances(instances)
	if err != nil {
		return err
	}
	_, err = r.db.Exec(ctx, `
		INSERT INTO benchmark_config_history (user_id, compressors, fingerprint)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id, fingerprint)
		DO UPDATE SET last_used_at = NOW()
	`, userID, compressorsJSON, FingerprintConfig(instances))
	return err
}

// TrimHistory keeps only the most recent `keep` configurations of a user.
func (r *PresetRepository) TrimHistory(ctx context.Context, userID uuid.UUID, keep int) error {
	if keep < 1 {
		keep = 1
	}
	_, err := r.db.Exec(ctx, `
		DELETE FROM benchmark_config_history
		WHERE user_id = $1 AND id NOT IN (
			SELECT id FROM benchmark_config_history
			WHERE user_id = $1
			ORDER BY last_used_at DESC
			LIMIT $2
		)
	`, userID, keep)
	return err
}

func (r *PresetRepository) ListHistory(ctx context.Context, userID uuid.UUID, limit int) ([]*model.BenchmarkConfigHistory, error) {
	if limit < 1 {
		limit = 20
	}
	rows, err := r.db.Query(ctx, `
		SELECT id, user_id, compressors, last_used_at
		FROM benchmark_config_history
		WHERE user_id = $1
		ORDER BY last_used_at DESC
		LIMIT $2
	`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []*model.BenchmarkConfigHistory
	for rows.Next() {
		entry := &model.BenchmarkConfigHistory{}
		var compressorsJSON []byte
		if err := rows.Scan(&entry.ID, &entry.UserID, &compressorsJSON, &entry.LastUsedAt); err != nil {
			return nil, err
		}
		instances, err := compressor.ParseInstances(compressorsJSON)
		if err != nil {
			return nil, err
		}
		entry.Compressors = instances
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}
