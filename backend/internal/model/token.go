package model

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

var jwtSecret []byte

// ErrJWTNotInitialized is returned when no signing key was configured; an
// empty HMAC key would make every token forgeable.
var ErrJWTNotInitialized = errors.New("jwt signing key not initialized")

func InitJWT(secret string) {
	jwtSecret = []byte(secret)
}

func GenerateToken(userID, email, role, groupID string, expiry time.Duration) (string, error) {
	now := time.Now()
	claims := Claims{
		Sub:     userID,
		Email:   email,
		Role:    role,
		GroupID: groupID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(expiry)),
			IssuedAt:  jwt.NewNumericDate(now),
			ID:        uuid.New().String(),
		},
	}
	if len(jwtSecret) == 0 {
		return "", ErrJWTNotInitialized
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(jwtSecret)
}

func ValidateToken(tokenStr string) (*Claims, error) {
	if len(jwtSecret) == 0 {
		return nil, ErrJWTNotInitialized
	}
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		return jwtSecret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, jwt.ErrSignatureInvalid
	}
	return claims, nil
}
