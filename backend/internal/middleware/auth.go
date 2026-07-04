package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/redis/go-redis/v9"

	"bitbench/internal/model"
)

type contextKey string

const ClaimsKey contextKey = "claims"

var rdb *redis.Client

func InitAuthMiddleware(redis *redis.Client) {
	rdb = redis
}

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
		if rdb != nil {
			blocked, _ := rdb.Exists(r.Context(), "jwt_blocklist:"+claims.ID).Result()
			if blocked > 0 {
				http.Error(w, "token revoked", http.StatusUnauthorized)
				return
			}
		}
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
