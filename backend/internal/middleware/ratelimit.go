package middleware

import (
	"net/http"
	"strconv"
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

func IPKeyFunc(r *http.Request) string {
	ip := r.Header.Get("X-Forwarded-For")
	if ip == "" {
		ip = r.RemoteAddr
	}
	return ip
}
