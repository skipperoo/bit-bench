package model

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func init() {
	InitJWT("test-secret-for-unit-tests")
}

func TestGenerateAndValidateToken(t *testing.T) {
	token, err := GenerateToken("user-1", "test@example.com", "user", "group-1", 1*time.Hour)
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}
	if token == "" {
		t.Fatal("token is empty")
	}

	claims, err := ValidateToken(token)
	if err != nil {
		t.Fatalf("validate token: %v", err)
	}

	if claims.Sub != "user-1" {
		t.Errorf("sub = %q, want user-1", claims.Sub)
	}
	if claims.Email != "test@example.com" {
		t.Errorf("email = %q, want test@example.com", claims.Email)
	}
	if claims.Role != "user" {
		t.Errorf("role = %q, want user", claims.Role)
	}
	if claims.GroupID != "group-1" {
		t.Errorf("group_id = %q, want group-1", claims.GroupID)
	}
	if claims.ID == "" {
		t.Error("jti is empty")
	}
}

func TestValidateExpiredToken(t *testing.T) {
	token, err := GenerateToken("user-1", "test@example.com", "user", "", -1*time.Hour)
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}

	_, err = ValidateToken(token)
	if err == nil {
		t.Error("expected error for expired token")
	}
}

func TestValidateInvalidToken(t *testing.T) {
	_, err := ValidateToken("invalid-token-string")
	if err == nil {
		t.Error("expected error for invalid token")
	}
}

func TestValidateTokenWrongSecret(t *testing.T) {
	// Generate with one secret
	oldSecret := jwtSecret
	InitJWT("different-secret")
	token, _ := GenerateToken("user-1", "test@example.com", "user", "", 1*time.Hour)
	InitJWT(string(oldSecret))

	_, err := ValidateToken(token)
	if err == nil {
		t.Error("expected error for token signed with different secret")
	}
}

func TestAdminTokenRole(t *testing.T) {
	token, err := GenerateToken("admin-1", "admin@example.com", "admin", "", 1*time.Hour)
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}

	claims, err := ValidateToken(token)
	if err != nil {
		t.Fatalf("validate token: %v", err)
	}

	if claims.Role != "admin" {
		t.Errorf("role = %q, want admin", claims.Role)
	}
}

func TestTokenHasJTI(t *testing.T) {
	token1, _ := GenerateToken("u1", "a@b.com", "user", "", 1*time.Hour)
	token2, _ := GenerateToken("u1", "a@b.com", "user", "", 1*time.Hour)

	claims1, _ := ValidateToken(token1)
	claims2, _ := ValidateToken(token2)

	if claims1.ID == claims2.ID {
		t.Error("each token should have a unique jti")
	}
}

func TestTokenRequiresSecret(t *testing.T) {
	old := jwtSecret
	defer func() { jwtSecret = old }()
	InitJWT("")
	if _, err := GenerateToken("u", "e", "student", "", time.Hour); err == nil {
		t.Fatal("GenerateToken must refuse an empty signing key")
	}
	if _, err := ValidateToken("a.b.c"); err == nil {
		t.Fatal("ValidateToken must refuse an empty signing key")
	}
}

func TestValidateTokenRejectsOtherAlgorithms(t *testing.T) {
	InitJWT("test-secret-for-unit-tests")
	claims := Claims{Sub: "u", RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS512, claims)
	signed, err := tok.SignedString([]byte("test-secret-for-unit-tests"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateToken(signed); err == nil {
		t.Fatal("HS512 token must be rejected")
	}
}
