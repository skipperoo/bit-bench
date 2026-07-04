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

type GroupRepository struct {
	db *pgxpool.Pool
}

func NewGroupRepository(db *pgxpool.Pool) *GroupRepository {
	return &GroupRepository{db: db}
}

func (r *GroupRepository) Create(ctx context.Context, g *model.Group) error {
	g.ID = uuid.New()
	g.CreatedAt = time.Now()
	g.UpdatedAt = time.Now()
	_, err := r.db.Exec(ctx,
		"INSERT INTO groups (id, name, priority) VALUES ($1, $2, $3)",
		g.ID, g.Name, g.Priority,
	)
	return err
}

func (r *GroupRepository) FindByID(ctx context.Context, id uuid.UUID) (*model.Group, error) {
	g := &model.Group{}
	err := r.db.QueryRow(ctx,
		"SELECT id, name, priority, created_at, updated_at FROM groups WHERE id = $1", id,
	).Scan(&g.ID, &g.Name, &g.Priority, &g.CreatedAt, &g.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return g, err
}

func (r *GroupRepository) List(ctx context.Context) ([]*model.Group, error) {
	rows, err := r.db.Query(ctx, "SELECT id, name, priority, created_at, updated_at FROM groups ORDER BY priority DESC, name ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var groups []*model.Group
	for rows.Next() {
		g := &model.Group{}
		if err := rows.Scan(&g.ID, &g.Name, &g.Priority, &g.CreatedAt, &g.UpdatedAt); err != nil {
			return nil, err
		}
		groups = append(groups, g)
	}
	return groups, nil
}

func (r *GroupRepository) Update(ctx context.Context, id uuid.UUID, name *string, priority *int) error {
	query := "UPDATE groups SET updated_at = NOW()"
	args := []any{}
	argIdx := 1

	if name != nil {
		query += fmt.Sprintf(", name = $%d", argIdx)
		args = append(args, *name)
		argIdx++
	}
	if priority != nil {
		query += fmt.Sprintf(", priority = $%d", argIdx)
		args = append(args, *priority)
		argIdx++
	}

	query += fmt.Sprintf(" WHERE id = $%d", argIdx)
	args = append(args, id)

	_, err := r.db.Exec(ctx, query, args...)
	return err
}

func (r *GroupRepository) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, "DELETE FROM groups WHERE id = $1", id)
	return err
}
