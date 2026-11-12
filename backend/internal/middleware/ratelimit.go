package middleware

import (
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

type RateLimiter struct {
	rdb     *redis.Client
	limit   int
	window  time.Duration
	keyFunc func(r *http.Request) string
}

func NewRateLimiter(rdb *redis.Client, limit int, window time.Duration, keyFunc func(r *http.Request) string) *RateLimiter {
	return &RateLimiter{rdb: rdb, limit: limit, window: window, keyFunc: keyFunc}
}

func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if rl.rdb == nil {
			next.ServeHTTP(w, r)
			return
		}
		key := "ratelimit:" + rl.keyFunc(r)
		count, err := rl.rdb.Incr(r.Context(), key).Result()
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		if count == 1 {
			rl.rdb.Expire(r.Context(), key, rl.window)
		}
		if count > int64(rl.limit) {
			w.Header().Set("Retry-After", strconv.Itoa(int(rl.window.Seconds())))
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
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
