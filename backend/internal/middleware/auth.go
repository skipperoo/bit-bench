package middleware

import (
	"context"
	"net/http"
	"strings"

	"bitbench/internal/model"
)

type contextKey string

const ClaimsKey contextKey = "claims"

func ClaimsFromContext(ctx context.Context) *model.Claims {
	c, ok := ctx.Value(ClaimsKey).(*model.Claims)
	if !ok {
		return nil
	}
	return c
}

func JWTAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := r.Header.Get("Authorization")
		if raw == "" || !strings.HasPrefix(raw, "Bearer ") {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		token := strings.TrimPrefix(raw, "Bearer ")
		claims, err := model.ValidateToken(token)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// TODO: Check Redis blocklist
		ctx := context.WithValue(r.Context(), ClaimsKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := ClaimsFromContext(r.Context())
		if c == nil || c.Role != "admin" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
