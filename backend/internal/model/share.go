package model

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"slices"
	"time"

	"github.com/google/uuid"
)

const (
	ShareKindPrivate = "private"
	ShareKindPublic  = "public"
)

// Share is a read-only link to an ordered set of benchmarks.
type Share struct {
	ID        uuid.UUID  `json:"id"`
	OwnerID   uuid.UUID  `json:"-"`
	Kind      string     `json:"kind"`
	Token     string     `json:"token"`
	ExpiresAt *time.Time `json:"expires_at"`
	RevokedAt *time.Time `json:"revoked_at"`
	CreatedAt time.Time  `json:"created_at"`
	// BenchmarkIDs in display order.
	BenchmarkIDs []uuid.UUID `json:"benchmark_ids"`
	RecipientIDs []uuid.UUID `json:"-"`
	// Recipients are the recipients' emails (private shares).
	Recipients []string `json:"recipients"`
}

// Usable reports whether the link still opens: not revoked and not expired.
func (s *Share) Usable(now time.Time) bool {
	return s.RevokedAt == nil && (s.ExpiresAt == nil || s.ExpiresAt.After(now))
}

// CanOpen reports whether user (nil = anonymous) may open a usable share.
func (s *Share) CanOpen(user *User) bool {
	if s.Kind == ShareKindPublic {
		return true
	}
	if user == nil {
		return false
	}
	return user.ID == s.OwnerID || slices.Contains(s.RecipientIDs, user.ID)
}

// NewPrivateShareToken returns 256 random bits, URL-safe (43 characters).
func NewPrivateShareToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// PublicShareToken is the stable public id of a benchmark set: an HMAC of the
// sorted ids, so the same set always gets the same link and the link cannot be
// derived from the ids alone.
func PublicShareToken(secret string, ids []uuid.UUID) string {
	sorted := SortedIDs(ids)
	mac := hmac.New(sha256.New, []byte("bitbench-share:"+secret))
	for _, id := range sorted {
		mac.Write(id[:])
	}
	return "p-" + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:16])
}

// SortedIDs returns a copy of ids in byte order (PostgreSQL's uuid order).
func SortedIDs(ids []uuid.UUID) []uuid.UUID {
	sorted := slices.Clone(ids)
	slices.SortFunc(sorted, func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
	return sorted
}
