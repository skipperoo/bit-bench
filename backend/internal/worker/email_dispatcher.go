package worker

import (
	"context"

	"bitbench/internal/config"
	"github.com/jackc/pgx/v5/pgxpool"
)

type EmailDispatcher struct {
	cfg *config.Config
	db  *pgxpool.Pool
}

func NewEmailDispatcher(cfg *config.Config, db *pgxpool.Pool) *EmailDispatcher {
	return &EmailDispatcher{cfg: cfg, db: db}
}

func (d *EmailDispatcher) Run(ctx context.Context) {
	if !d.cfg.SMTPEnabled() {
		return
	}
	<-ctx.Done()
}
