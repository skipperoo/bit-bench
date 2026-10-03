package repository

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"bitbench/internal/model"
)

type CompressorPackageRepository struct {
	db *pgxpool.Pool
}

func NewCompressorPackageRepository(db *pgxpool.Pool) *CompressorPackageRepository {
	return &CompressorPackageRepository{db: db}
}

const packageColumns = `id, owner_id, group_id, name, version, COALESCE(description, ''), COALESCE(language, ''),
	entrypoint, workers, spec, status, error, archive_checksum, built_path, COALESCE(build_log, ''),
	created_at, updated_at`

func scanPackage(row pgx.Row) (*model.CompressorPackage, error) {
	p := &model.CompressorPackage{}
	var specJSON []byte
	err := row.Scan(
		&p.ID, &p.OwnerID, &p.GroupID, &p.Name, &p.Version, &p.Description, &p.Language,
		&p.Entrypoint, &p.Workers, &specJSON, &p.Status, &p.Error, &p.ArchiveChecksum,
		&p.BuiltPath, &p.BuildLog, &p.CreatedAt, &p.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p.Spec = json.RawMessage(specJSON)
	return p, nil
}

func (r *CompressorPackageRepository) Create(ctx context.Context, p *model.CompressorPackage) error {
	if p.ID == uuid.Nil {
		p.ID = uuid.New()
	}
	specJSON := []byte(p.Spec)
	_, err := r.db.Exec(ctx, `
		INSERT INTO compressor_packages
			(id, owner_id, group_id, name, version, description, language, entrypoint,
			 workers, spec, status, error, archive_checksum, built_path, build_log)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
	`, p.ID, p.OwnerID, p.GroupID, p.Name, p.Version, p.Description, p.Language,
		p.Entrypoint, p.Workers, specJSON, p.Status, p.Error, p.ArchiveChecksum,
		p.BuiltPath, p.BuildLog)
	return err
}

func (r *CompressorPackageRepository) FindByID(ctx context.Context, id uuid.UUID) (*model.CompressorPackage, error) {
	return scanPackage(r.db.QueryRow(ctx,
		`SELECT `+packageColumns+` FROM compressor_packages WHERE id = $1`, id))
}

func (r *CompressorPackageRepository) FindByName(ctx context.Context, name string) (*model.CompressorPackage, error) {
	return scanPackage(r.db.QueryRow(ctx,
		`SELECT `+packageColumns+` FROM compressor_packages WHERE LOWER(name) = LOWER($1)`, name))
}

// ListVisible returns packages visible to a user: everything for admins,
// otherwise the user's own packages plus those belonging to their group.
func (r *CompressorPackageRepository) ListVisible(ctx context.Context, userID uuid.UUID, groupID *uuid.UUID, isAdmin bool) ([]*model.CompressorPackage, error) {
	query := `SELECT ` + packageColumns + ` FROM compressor_packages`
	args := []any{}
	if !isAdmin {
		if groupID != nil {
			query += ` WHERE owner_id = $1 OR group_id = $2`
			args = append(args, userID, *groupID)
		} else {
			query += ` WHERE owner_id = $1`
			args = append(args, userID)
		}
	}
	query += ` ORDER BY created_at DESC`

	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var packages []*model.CompressorPackage
	for rows.Next() {
		p, err := scanPackage(rows)
		if err != nil {
			return nil, err
		}
		packages = append(packages, p)
	}
	return packages, rows.Err()
}

// IsVisibleReady reports whether name refers to a ready package visible to the user.
func (r *CompressorPackageRepository) IsVisibleReady(ctx context.Context, name string, userID uuid.UUID, groupID *uuid.UUID, isAdmin bool) (bool, error) {
	query := `SELECT 1 FROM compressor_packages WHERE LOWER(name) = LOWER($1) AND status = 'ready'`
	args := []any{name}
	if !isAdmin {
		if groupID != nil {
			query += ` AND (owner_id = $2 OR group_id = $3)`
			args = append(args, userID, *groupID)
		} else {
			query += ` AND owner_id = $2`
			args = append(args, userID)
		}
	}
	query += ` LIMIT 1`

	var one int
	err := r.db.QueryRow(ctx, query, args...).Scan(&one)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// Replace resets an existing package with a new upload and marks it building.
func (r *CompressorPackageRepository) Replace(ctx context.Context, p *model.CompressorPackage) error {
	specJSON := []byte(p.Spec)
	_, err := r.db.Exec(ctx, `
		UPDATE compressor_packages SET
			group_id = $2, version = $3, description = $4, language = $5, entrypoint = $6,
			workers = $7, spec = $8, status = 'building', error = NULL,
			archive_checksum = $9, built_path = NULL, build_log = NULL, updated_at = NOW()
		WHERE id = $1
	`, p.ID, p.GroupID, p.Version, p.Description, p.Language, p.Entrypoint,
		p.Workers, specJSON, p.ArchiveChecksum)
	return err
}

func (r *CompressorPackageRepository) UpdateStatus(ctx context.Context, id uuid.UUID, status string, errMsg *string, builtPath *string, buildLog string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE compressor_packages
		SET status = $2, error = $3, built_path = $4, build_log = $5, updated_at = NOW()
		WHERE id = $1
	`, id, status, errMsg, builtPath, buildLog)
	return err
}

func (r *CompressorPackageRepository) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM compressor_packages WHERE id = $1`, id)
	return err
}
