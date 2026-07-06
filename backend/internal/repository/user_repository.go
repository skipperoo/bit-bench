package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"bitbench/internal/model"
)

type UserRepository struct {
	db *pgxpool.Pool
}

func NewUserRepository(db *pgxpool.Pool) *UserRepository {
	return &UserRepository{db: db}
}

func (r *UserRepository) Create(ctx context.Context, u *model.User) error {
	u.ID = uuid.New()
	u.CreatedAt = time.Now()
	u.UpdatedAt = time.Now()
	_, err := r.db.Exec(ctx, `
		INSERT INTO users (id, email, password_hash, role, group_id, must_change_password)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, u.ID, u.Email, u.PasswordHash, u.Role, u.GroupID, u.MustChangePassword)
	return err
}

func (r *UserRepository) FindByEmail(ctx context.Context, email string) (*model.User, error) {
	u := &model.User{}
	err := r.db.QueryRow(ctx, `
		SELECT id, email, password_hash, role, group_id, must_change_password,
		       COALESCE(last_bench_config, '{}'::jsonb), created_at, updated_at, deleted_at
		FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL
	`, email).Scan(
		&u.ID, &u.Email, &u.PasswordHash, &u.Role, &u.GroupID,
		&u.MustChangePassword, &u.LastBenchConfig, &u.CreatedAt, &u.UpdatedAt, &u.DeletedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (r *UserRepository) FindByID(ctx context.Context, id uuid.UUID) (*model.User, error) {
	u := &model.User{}
	err := r.db.QueryRow(ctx, `
		SELECT id, email, password_hash, role, group_id, must_change_password,
		       COALESCE(last_bench_config, '{}'::jsonb), created_at, updated_at, deleted_at
		FROM users WHERE id = $1 AND deleted_at IS NULL
	`, id).Scan(
		&u.ID, &u.Email, &u.PasswordHash, &u.Role, &u.GroupID,
		&u.MustChangePassword, &u.LastBenchConfig, &u.CreatedAt, &u.UpdatedAt, &u.DeletedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (r *UserRepository) List(ctx context.Context) ([]*model.User, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, email, password_hash, role, group_id, must_change_password,
		       COALESCE(last_bench_config, '{}'::jsonb), created_at, updated_at, deleted_at
		FROM users WHERE deleted_at IS NULL
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []*model.User
	for rows.Next() {
		u := &model.User{}
		if err := rows.Scan(
			&u.ID, &u.Email, &u.PasswordHash, &u.Role, &u.GroupID,
			&u.MustChangePassword, &u.LastBenchConfig, &u.CreatedAt, &u.UpdatedAt, &u.DeletedAt,
		); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, nil
}

func (r *UserRepository) UpdateLastConfig(ctx context.Context, id uuid.UUID, config map[string]interface{}) error {
	_, err := r.db.Exec(ctx, "UPDATE users SET last_bench_config = $1, updated_at = NOW() WHERE id = $2", config, id)
	return err
}

func (r *UserRepository) Update(ctx context.Context, id uuid.UUID, role *string, groupID *string, newPasswordHash *string) error {
	query := "UPDATE users SET updated_at = NOW()"
	args := []any{}
	argIdx := 1

	if role != nil {
		query += fmt.Sprintf(", role = $%d", argIdx)
		args = append(args, *role)
		argIdx++
	}
	if groupID != nil {
		if *groupID == "" {
			query += fmt.Sprintf(", group_id = NULL")
		} else {
			gid, err := uuid.Parse(*groupID)
			if err == nil {
				query += fmt.Sprintf(", group_id = $%d", argIdx)
				args = append(args, gid)
				argIdx++
			}
		}
	}

	if newPasswordHash != nil {
		query += fmt.Sprintf(", password_hash = $%d, must_change_password = false", argIdx)
		args = append(args, *newPasswordHash)
		argIdx++
	}

	query += fmt.Sprintf(" WHERE id = $%d AND deleted_at IS NULL", argIdx)
	args = append(args, id)

	_, err := r.db.Exec(ctx, query, args...)
	return err
}

func (r *UserRepository) SoftDelete(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, "UPDATE users SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1", id)
	return err
}

func (r *UserRepository) UpdatePassword(ctx context.Context, id uuid.UUID, hash string) error {
	_, err := r.db.Exec(ctx, "UPDATE users SET password_hash = $1, must_change_password = false, updated_at = NOW() WHERE id = $2", hash, id)
	return err
}

func (r *UserRepository) SetMustChangePassword(ctx context.Context, id uuid.UUID, val bool) error {
	_, err := r.db.Exec(ctx, "UPDATE users SET must_change_password = $1, updated_at = NOW() WHERE id = $2", val, id)
	return err
}

func (r *UserRepository) UpdateLastLogin(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, "UPDATE users SET updated_at = NOW() WHERE id = $1", id)
	return err
}
