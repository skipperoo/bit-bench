package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"bitbench/internal/model"
)

type contextKey string

const ClaimsKey contextKey = "claims"
const UserKey contextKey = "user"

var rdb *redis.Client

// UserLookup resolves a user by id; implemented by repository.UserRepository.
type UserLookup interface {
	FindByID(ctx context.Context, id uuid.UUID) (*model.User, error)
}

var userLookup UserLookup

func InitAuthMiddleware(redis *redis.Client) {
	rdb = redis
}

func InitUserResolver(lookup UserLookup) {
	userLookup = lookup
}

func ClaimsFromContext(ctx context.Context) *model.Claims {
	c, ok := ctx.Value(ClaimsKey).(*model.Claims)
	if !ok {
		return nil
	}
	return c
}

func UserFromContext(ctx context.Context) *model.User {
	u, ok := ctx.Value(UserKey).(*model.User)
	if !ok {
		return nil
	}
	return u
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

// ResolveUser replaces the JWT's role/group claims with the current values
// from the database so permission changes take effect immediately.
func ResolveUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims := ClaimsFromContext(r.Context())
		if claims == nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if userLookup == nil {
			next.ServeHTTP(w, r)
			return
		}

		id, err := uuid.Parse(claims.Sub)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		user, err := userLookup.FindByID(r.Context(), id)
		if err != nil || user == nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), UserKey, user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func requireRole(roles ...string) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			user := UserFromContext(r.Context())
			if user == nil {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			for _, role := range roles {
				if user.Role == role {
					next(w, r)
					return
				}
			}
			http.Error(w, "forbidden", http.StatusForbidden)
		}
	}
}

func RequireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return requireRole(model.RoleAdmin)(next)
}

func RequireAdminOrProfessor(next http.HandlerFunc) http.HandlerFunc {
	return requireRole(model.RoleAdmin, model.RoleProfessor)(next)
}

func RequireUploader(next http.HandlerFunc) http.HandlerFunc {
	return requireRole(model.RoleAdmin, model.RoleProfessor, model.RolePhD)(next)
}
