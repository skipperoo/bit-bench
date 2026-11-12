package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"bitbench/internal/model"
)

func TestRateLimiterKeyFunc(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "192.168.1.1:12345"
	if key := IPKeyFunc(r); key != "192.168.1.1" {
		t.Errorf("IPKeyFunc = %q, want 192.168.1.1 (port stripped)", key)
	}
}

func TestRateLimiterKeyFuncUsesRealIP(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "172.18.0.5:40000"
	r.Header.Set("X-Real-IP", "10.0.0.1")
	if key := IPKeyFunc(r); key != "10.0.0.1" {
		t.Errorf("IPKeyFunc = %q, want 10.0.0.1", key)
	}
}

func TestRateLimiterKeyFuncIgnoresForwardedFor(t *testing.T) {
	// X-Forwarded-For is client-controlled (nginx appends to it), so rotating
	// it must not yield a fresh rate-limit bucket.
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "192.168.1.1:12345"
	r.Header.Set("X-Forwarded-For", "10.0.0.1")
	if key := IPKeyFunc(r); key != "192.168.1.1" {
		t.Errorf("IPKeyFunc = %q, want 192.168.1.1", key)
	}
}

func TestRateLimiterNilRedis(t *testing.T) {
	// When Redis is nil, the middleware should pass through
	rl := NewRateLimiter(nil, 5, time.Minute, IPKeyFunc)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	rl.Middleware(handler).ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 with nil redis, got %d", w.Code)
	}
}

func TestRateLimiterWrap(t *testing.T) {
	rl := NewRateLimiter(nil, 5, time.Minute, IPKeyFunc)

	called := false
	wrapped := rl.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	wrapped(w, r)

	if !called {
		t.Error("wrapped handler was not called")
	}
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestUserKeyFunc(t *testing.T) {
	r := httptest.NewRequest("POST", "/", nil)
	r.RemoteAddr = "10.1.1.1:5000"
	if got := UserKeyFunc(r); got != "ip:10.1.1.1" {
		t.Errorf("anonymous key = %q", got)
	}
	u := &model.User{ID: uuid.MustParse("11111111-1111-1111-1111-111111111111")}
	r = r.WithContext(context.WithValue(r.Context(), UserKey, u))
	if got := UserKeyFunc(r); got != "user:11111111-1111-1111-1111-111111111111" {
		t.Errorf("user key = %q", got)
	}
}

func TestRateLimiterDisabledWithZeroLimit(t *testing.T) {
	rl := NewRateLimiter(redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"}), 0, time.Minute, IPKeyFunc)
	called := false
	rl.Wrap(func(w http.ResponseWriter, r *http.Request) { called = true })(httptest.NewRecorder(), httptest.NewRequest("POST", "/", nil))
	if !called {
		t.Fatal("a zero limit must disable rate limiting without touching Redis")
	}
}
