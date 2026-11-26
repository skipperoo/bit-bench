package repository

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"bitbench/internal/model"
)

type ShareRepository struct {
	db *pgxpool.Pool
}

func NewShareRepository(db *pgxpool.Pool) *ShareRepository {
	return &ShareRepository{db: db}
}

const shareColumns = `s.id, s.owner_id, s.kind, s.token, s.expires_at, s.revoked_at, s.created_at`

func scanShare(row pgx.Row) (*model.Share, error) {
	s := &model.Share{}
	err := row.Scan(&s.ID, &s.OwnerID, &s.Kind, &s.Token, &s.ExpiresAt, &s.RevokedAt, &s.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return s, err
}

// fill loads the benchmark ids (in order) and the recipients of s.
func (r *ShareRepository) fill(ctx context.Context, s *model.Share) error {
	rows, err := r.db.Query(ctx, `SELECT benchmark_id FROM share_benchmarks WHERE share_id = $1 ORDER BY position`, s.ID)
	if err != nil {
		return err
	}
	s.BenchmarkIDs, err = pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	rows, err = r.db.Query(ctx, `
		SELECT u.id, u.email FROM share_recipients sr JOIN users u ON u.id = sr.user_id
		WHERE sr.share_id = $1 AND u.deleted_at IS NULL ORDER BY u.email`, s.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	s.RecipientIDs, s.Recipients = []uuid.UUID{}, []string{}
	for rows.Next() {
		var id uuid.UUID
		var email string
		if err := rows.Scan(&id, &email); err != nil {
			return err
		}
		s.RecipientIDs = append(s.RecipientIDs, id)
		s.Recipients = append(s.Recipients, email)
	}
	return rows.Err()
}

func (r *ShareRepository) one(ctx context.Context, query string, args ...any) (*model.Share, error) {
	s, err := scanShare(r.db.QueryRow(ctx, query, args...))
	if err != nil || s == nil {
		return nil, err
	}
	return s, r.fill(ctx, s)
}

// Create inserts s with its benchmarks and recipients. A public share whose
// token already exists is re-activated with the new expiry instead.
func (r *ShareRepository) Create(ctx context.Context, s *model.Share) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if s.ID == uuid.Nil {
		s.ID = uuid.New()
	}
	var inserted bool
	err = tx.QueryRow(ctx, `
		INSERT INTO shares (id, owner_id, kind, token, expires_at) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (token) DO UPDATE SET revoked_at = NULL, expires_at = EXCLUDED.expires_at
		WHERE shares.kind = 'public' AND shares.owner_id = EXCLUDED.owner_id
		RETURNING id, created_at, (xmax = 0)`, s.ID, s.OwnerID, s.Kind, s.Token, s.ExpiresAt).
		Scan(&s.ID, &s.CreatedAt, &inserted)
	if err != nil {
		return err
	}
	s.RevokedAt = nil
	if inserted {
		for i, id := range s.BenchmarkIDs {
			if _, err := tx.Exec(ctx, `INSERT INTO share_benchmarks (share_id, benchmark_id, position) VALUES ($1, $2, $3)`, s.ID, id, i); err != nil {
				return err
			}
		}
	}
	if err := setRecipients(ctx, tx, s.ID, s.RecipientIDs); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func setRecipients(ctx context.Context, tx pgx.Tx, shareID uuid.UUID, ids []uuid.UUID) error {
	if _, err := tx.Exec(ctx, `DELETE FROM share_recipients WHERE share_id = $1`, shareID); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := tx.Exec(ctx, `INSERT INTO share_recipients (share_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, shareID, id); err != nil {
			return err
		}
	}
	return nil
}

// Update saves the expiry, revocation and recipients of s.
func (r *ShareRepository) Update(ctx context.Context, s *model.Share) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE shares SET expires_at = $2, revoked_at = $3 WHERE id = $1`, s.ID, s.ExpiresAt, s.RevokedAt); err != nil {
		return err
	}
	if err := setRecipients(ctx, tx, s.ID, s.RecipientIDs); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *ShareRepository) FindByID(ctx context.Context, id uuid.UUID) (*model.Share, error) {
	return r.one(ctx, `SELECT `+shareColumns+` FROM shares s WHERE s.id = $1`, id)
}

// FindOpenable returns the share with token whose owner is still active, plus
// the owner's email.
func (r *ShareRepository) FindOpenable(ctx context.Context, token string) (*model.Share, string, error) {
	var email string
	s := &model.Share{}
	err := r.db.QueryRow(ctx, `
		SELECT `+shareColumns+`, u.email FROM shares s JOIN users u ON u.id = s.owner_id
		WHERE s.token = $1 AND u.deleted_at IS NULL`, token).
		Scan(&s.ID, &s.OwnerID, &s.Kind, &s.Token, &s.ExpiresAt, &s.RevokedAt, &s.CreatedAt, &email)
	if err == pgx.ErrNoRows {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	return s, email, r.fill(ctx, s)
}

// ListForSet returns the owner's shares of exactly this benchmark set, newest first.
func (r *ShareRepository) ListForSet(ctx context.Context, ownerID uuid.UUID, ids []uuid.UUID) ([]*model.Share, error) {
	rows, err := r.db.Query(ctx, `
		SELECT `+shareColumns+` FROM shares s WHERE s.owner_id = $1 AND
		  (SELECT array_agg(benchmark_id ORDER BY benchmark_id) FROM share_benchmarks WHERE share_id = s.id) = $2::uuid[]
		ORDER BY s.created_at DESC`, ownerID, model.SortedIDs(ids))
	if err != nil {
		return nil, err
	}
	shares, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (*model.Share, error) { return scanShare(row) })
	if err != nil {
		return nil, err
	}
	for _, s := range shares {
		if err := r.fill(ctx, s); err != nil {
			return nil, err
		}
	}
	return shares, nil
}

// ReceivedShare is a private share listed for one of its recipients.
type ReceivedShare struct {
	Token      string     `json:"token"`
	OwnerEmail string     `json:"owner_email"`
	Names      []string   `json:"benchmark_names"`
	ExpiresAt  *time.Time `json:"expires_at"`
	CreatedAt  time.Time  `json:"created_at"`
}

// ListReceived returns the usable private shares sent to userID.
func (r *ShareRepository) ListReceived(ctx context.Context, userID uuid.UUID) ([]ReceivedShare, error) {
	rows, err := r.db.Query(ctx, `
		SELECT s.token, u.email, s.expires_at, s.created_at,
		       COALESCE((SELECT array_agg(b.name ORDER BY sb.position) FROM share_benchmarks sb
		                 JOIN benchmarks b ON b.id = sb.benchmark_id WHERE sb.share_id = s.id), '{}')
		FROM shares s
		JOIN share_recipients sr ON sr.share_id = s.id AND sr.user_id = $1
		JOIN users u ON u.id = s.owner_id AND u.deleted_at IS NULL
		WHERE s.kind = 'private' AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > NOW())
		ORDER BY s.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (ReceivedShare, error) {
		var rs ReceivedShare
		err := row.Scan(&rs.Token, &rs.OwnerEmail, &rs.ExpiresAt, &rs.CreatedAt, &rs.Names)
		return rs, err
	})
}

func (r *ShareRepository) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM shares WHERE id = $1`, id)
	return err
}

// QueueEmail adds a message to the SMTP outbox.
func (r *ShareRepository) QueueEmail(ctx context.Context, to, subject, body string) error {
	_, err := r.db.Exec(ctx, `INSERT INTO email_outbox (to_address, subject, body) VALUES ($1, $2, $3)`, to, subject, body)
	return err
}
