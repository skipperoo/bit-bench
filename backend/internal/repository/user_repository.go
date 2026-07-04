package repository

import (
	"context"

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

func (r *UserRepository) FindByEmail(ctx context.Context, email string) (*model.User, error) {
	u := &model.User{}
	err := r.db.QueryRow(ctx, `
		SELECT id, email, password_hash, role, group_id, must_change_password,
		       created_at, updated_at, deleted_at
		FROM users WHERE email = $1 AND deleted_at IS NULL
	`, email).Scan(
		&u.ID, &u.Email, &u.PasswordHash, &u.Role, &u.GroupID,
		&u.MustChangePassword, &u.CreatedAt, &u.UpdatedAt, &u.DeletedAt,
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
		       created_at, updated_at, deleted_at
		FROM users WHERE id = $1 AND deleted_at IS NULL
	`, id).Scan(
		&u.ID, &u.Email, &u.PasswordHash, &u.Role, &u.GroupID,
		&u.MustChangePassword, &u.CreatedAt, &u.UpdatedAt, &u.DeletedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (r *UserRepository) UpdatePassword(ctx context.Context, id uuid.UUID, hash string) error {
	_, err := r.db.Exec(ctx, "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2", hash, id)
	return err
}

func (r *UserRepository) UpdateLastLogin(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, "UPDATE users SET updated_at = NOW() WHERE id = $1", id)
	return err
}
