package model

import (
	"regexp"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPrivateShareToken(t *testing.T) {
	a, err := NewPrivateShareToken()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := NewPrivateShareToken()
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(a) || a == b {
		t.Fatalf("tokens %q %q", a, b)
	}
}

func TestPublicShareTokenStable(t *testing.T) {
	x, y := uuid.New(), uuid.New()
	tok := PublicShareToken("s", []uuid.UUID{x, y})
	if tok != PublicShareToken("s", []uuid.UUID{y, x}) {
		t.Fatal("order must not matter")
	}
	if !regexp.MustCompile(`^p-[A-Za-z0-9_-]{22}$`).MatchString(tok) {
		t.Fatalf("token %q", tok)
	}
	if tok == PublicShareToken("other", []uuid.UUID{x, y}) || tok == PublicShareToken("s", []uuid.UUID{x}) {
		t.Fatal("token must depend on the secret and the set")
	}
}

func TestShareAccess(t *testing.T) {
	now := time.Now()
	past, future := now.Add(-time.Hour), now.Add(time.Hour)
	owner, friend, stranger := &User{ID: uuid.New()}, &User{ID: uuid.New()}, &User{ID: uuid.New()}
	s := &Share{Kind: ShareKindPrivate, OwnerID: owner.ID, RecipientIDs: []uuid.UUID{friend.ID}}
	if !s.Usable(now) {
		t.Fatal("fresh share must be usable")
	}
	if !s.CanOpen(owner) || !s.CanOpen(friend) || s.CanOpen(stranger) || s.CanOpen(nil) {
		t.Fatal("private access matrix")
	}
	s.ExpiresAt = &future
	if !s.Usable(now) {
		t.Fatal("not yet expired")
	}
	s.ExpiresAt = &past
	if s.Usable(now) {
		t.Fatal("expired share must not open")
	}
	s.ExpiresAt, s.RevokedAt = nil, &past
	if s.Usable(now) {
		t.Fatal("revoked share must not open")
	}
	pub := &Share{Kind: ShareKindPublic}
	if !pub.CanOpen(nil) {
		t.Fatal("public share opens anonymously")
	}
}
