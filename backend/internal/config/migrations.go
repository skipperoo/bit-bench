package config

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"bitbench/internal/logger"
	"golang.org/x/crypto/bcrypt"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

func RunMigrations(ctx context.Context, db *pgxpool.Pool) error {
	// Wait for DB to be ready (up to 30s)
	for i := 0; i < 30; i++ {
		if err := db.Ping(ctx); err == nil {
			break
		}
		if i == 29 {
			return fmt.Errorf("database not reachable after 30 attempts")
		}
		time.Sleep(1 * time.Second)
	}

	_, err := db.Exec(ctx, `CREATE TABLE IF NOT EXISTS _migrations (
		filename VARCHAR(255) PRIMARY KEY,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`)
	if err != nil {
		return fmt.Errorf("create migrations table: %w", err)
	}

	entries, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}

	var filenames []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			filenames = append(filenames, e.Name())
		}
	}
	sort.Strings(filenames)

	for _, fname := range filenames {
		var applied int
		err := db.QueryRow(ctx, "SELECT 1 FROM _migrations WHERE filename=$1", fname).Scan(&applied)
		if err == nil {
			continue
		}

		content, err := migrationFiles.ReadFile("migrations/" + fname)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", fname, err)
		}

		_, err = db.Exec(ctx, string(content))
		if err != nil {
			return fmt.Errorf("apply migration %s: %w", fname, err)
		}

		_, err = db.Exec(ctx, "INSERT INTO _migrations (filename) VALUES ($1)", fname)
		if err != nil {
			return fmt.Errorf("record migration %s: %w", fname, err)
		}

		logger.Info("applied migration", "filename", fname)
	}

	return nil
}

func Seed(ctx context.Context, db *pgxpool.Pool) error {
	var count int
	err := db.QueryRow(ctx, "SELECT COUNT(*) FROM groups").Scan(&count)
	if err != nil {
		return err
	}
	if count == 0 {
		_, err := db.Exec(ctx, "INSERT INTO groups (name, priority) VALUES ('default', 0)")
		if err != nil {
			return fmt.Errorf("seed default group: %w", err)
		}
		logger.Info("seeded default group")
	}

	err = db.QueryRow(ctx, "SELECT COUNT(*) FROM users WHERE role='admin'").Scan(&count)
	if err != nil {
		return err
	}
	if count == 0 {
		hash, err := bcrypt.GenerateFromPassword([]byte("changeme"), bcrypt.DefaultCost)
		if err != nil {
			return fmt.Errorf("hash password: %w", err)
		}
		_, err = db.Exec(ctx,
			"INSERT INTO users (email, password_hash, role, must_change_password) VALUES ($1, $2, 'admin', true)",
			"admin@bitbench.org", string(hash),
		)
		if err != nil {
			return fmt.Errorf("seed admin user: %w", err)
		}
		logger.Info("seeded admin user", "email", "admin@bitbench.org")
	}

	return nil
}
