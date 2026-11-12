package middleware

import (
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

type RateLimiter struct {
	rdb     *redis.Client
	prefix  string
	limit   int
	window  time.Duration
	keyFunc func(r *http.Request) string
}

func NewRateLimiter(rdb *redis.Client, limit int, window time.Duration, keyFunc func(r *http.Request) string) *RateLimiter {
	return &RateLimiter{rdb: rdb, limit: limit, window: window, keyFunc: keyFunc}
}

// WithPrefix namespaces the limiter's Redis keys so independent limits (login,
// uploads) never share a counter.
func (rl *RateLimiter) WithPrefix(prefix string) *RateLimiter {
	rl.prefix = prefix
	return rl
}

func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if rl.rdb == nil || rl.limit <= 0 {
			next.ServeHTTP(w, r)
			return
		}
		key := "ratelimit:" + rl.prefix + rl.keyFunc(r)
		count, err := rl.rdb.Incr(r.Context(), key).Result()
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		if count == 1 {
			rl.rdb.Expire(r.Context(), key, rl.window)
		}
		if count > int64(rl.limit) {
			retry := int(rl.window.Seconds())
			if ttl, err := rl.rdb.TTL(r.Context(), key).Result(); err == nil && ttl > 0 {
				retry = int(ttl.Seconds()) + 1
			}
			w.Header().Set("Retry-After", strconv.Itoa(retry))
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			fmt.Fprintf(w, `{"error":"rate limit exceeded: at most %d requests per %s, retry in %ds"}`+"\n", rl.limit, rl.window, retry)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (rl *RateLimiter) Wrap(handler http.HandlerFunc) http.HandlerFunc {
	return rl.Middleware(handler).ServeHTTP
}

// IPKeyFunc keys requests by client IP. The reverse proxy overwrites
// X-Real-IP with the connection's address, so it cannot be spoofed by clients
// (unlike X-Forwarded-For, which nginx appends to). Without a proxy the
// connection address is used, stripped of its ephemeral port so that every
// new connection from the same host shares one bucket.
func IPKeyFunc(r *http.Request) string {
	if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); ip != "" {
		return ip
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// UserKeyFunc keys requests by the authenticated user (use after
// JWTAuth/ResolveUser); unauthenticated requests fall back to the client IP.
func UserKeyFunc(r *http.Request) string {
	if u := UserFromContext(r.Context()); u != nil {
		return "user:" + u.ID.String()
	}
	if c := ClaimsFromContext(r.Context()); c != nil && c.Sub != "" {
		return "user:" + c.Sub
	}
	return "ip:" + IPKeyFunc(r)
}
