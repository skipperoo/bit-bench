package worker

import (
	"context"
	"net"
	"net/smtp"
	"strings"
	"time"

	"bitbench/internal/config"
	"bitbench/internal/logger"
	"github.com/jackc/pgx/v5/pgxpool"
)

const emailMaxAttempts = 5

type EmailDispatcher struct {
	cfg *config.Config
	db  *pgxpool.Pool
}

func NewEmailDispatcher(cfg *config.Config, db *pgxpool.Pool) *EmailDispatcher {
	return &EmailDispatcher{cfg: cfg, db: db}
}

// Run sends pending email_outbox rows every 15s; a no-op without SMTP_HOST.
func (d *EmailDispatcher) Run(ctx context.Context) {
	if !d.cfg.SMTPEnabled() {
		return
	}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		d.dispatch(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// headerSafe drops line breaks so a value cannot add mail headers.
func headerSafe(s string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(s)
}

func buildMessage(from, to, subject, body string) []byte {
	return []byte("From: " + headerSafe(from) + "\r\nTo: " + headerSafe(to) + "\r\nSubject: " + headerSafe(subject) +
		"\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" +
		strings.ReplaceAll(body, "\n", "\r\n") + "\r\n")
}

func (d *EmailDispatcher) dispatch(ctx context.Context) {
	rows, err := d.db.Query(ctx, `
		SELECT id::text, to_address, subject, body FROM email_outbox
		WHERE status = 'pending' AND scheduled_for <= NOW() ORDER BY created_at LIMIT 20`)
	if err != nil {
		logger.Warn("email outbox query failed", "error", err)
		return
	}
	type mail struct {
		id                string
		to, subject, body string
	}
	var batch []mail
	for rows.Next() {
		var m mail
		if err := rows.Scan(&m.id, &m.to, &m.subject, &m.body); err == nil {
			batch = append(batch, m)
		}
	}
	rows.Close()

	var auth smtp.Auth
	if d.cfg.SMTPUser != "" {
		auth = smtp.PlainAuth("", d.cfg.SMTPUser, d.cfg.SMTPPassword, d.cfg.SMTPHost)
	}
	from := d.cfg.SMTPFrom
	if from == "" {
		from = d.cfg.SMTPUser
	}
	addr := net.JoinHostPort(d.cfg.SMTPHost, d.cfg.SMTPPort)
	for _, m := range batch {
		if err := smtp.SendMail(addr, auth, from, []string{headerSafe(m.to)}, buildMessage(from, m.to, m.subject, m.body)); err != nil {
			logger.Warn("email send failed", "to", m.to, "error", err)
			// Back off one minute per failed attempt; give up after emailMaxAttempts.
			d.db.Exec(ctx, `
				UPDATE email_outbox SET retry_count = retry_count + 1,
				  status = CASE WHEN retry_count + 1 >= $2 THEN 'failed' ELSE 'pending' END,
				  scheduled_for = NOW() + make_interval(mins => retry_count + 1)
				WHERE id = $1`, m.id, emailMaxAttempts)
			continue
		}
		d.db.Exec(ctx, `UPDATE email_outbox SET status = 'sent' WHERE id = $1`, m.id)
	}
}
