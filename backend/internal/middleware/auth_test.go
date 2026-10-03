package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"bitbench/internal/model"
)

type fakeLookup struct {
	users map[uuid.UUID]*model.User
}

func (f *fakeLookup) FindByID(_ context.Context, id uuid.UUID) (*model.User, error) {
	if u, ok := f.users[id]; ok {
		return u, nil
	}
	return nil, nil
}

func withClaims(r *http.Request, sub string) *http.Request {
	ctx := context.WithValue(r.Context(), ClaimsKey, &model.Claims{Sub: sub})
	return r.WithContext(ctx)
}

func withUser(r *http.Request, user *model.User) *http.Request {
	ctx := context.WithValue(r.Context(), UserKey, user)
	return r.WithContext(ctx)
}

func TestResolveUser(t *testing.T) {
	id := uuid.New()
	lookup := &fakeLookup{users: map[uuid.UUID]*model.User{
		id: {ID: id, Email: "user@test.com", Role: model.RoleStudent},
	}}
	InitUserResolver(lookup)
	defer InitUserResolver(nil)

	var got *model.User
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = UserFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	})
	handler := ResolveUser(next)

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, withClaims(httptest.NewRequest("GET", "/", nil), id.String()))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if got == nil || got.Email != "user@test.com" {
		t.Fatalf("resolved user = %+v", got)
	}

	tests := []struct {
		name   string
		claims *model.Claims
	}{
		{"no claims", nil},
		{"invalid sub", &model.Claims{Sub: "not-a-uuid"}},
		{"unknown user", &model.Claims{Sub: uuid.New().String()}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			if tt.claims != nil {
				r = r.WithContext(context.WithValue(r.Context(), ClaimsKey, tt.claims))
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("expected 401, got %d", w.Code)
			}
		})
	}
}

func TestRequireRole(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	tests := []struct {
		name       string
		user       *model.User
		middleware func(http.HandlerFunc) http.HandlerFunc
		want       int
	}{
		{"admin allowed", &model.User{Role: model.RoleAdmin}, RequireAdmin, http.StatusOK},
		{"student denied", &model.User{Role: model.RoleStudent}, RequireAdmin, http.StatusForbidden},
		{"professor denied admin", &model.User{Role: model.RoleProfessor}, RequireAdmin, http.StatusForbidden},
		{"professor allowed staff", &model.User{Role: model.RoleProfessor}, RequireAdminOrProfessor, http.StatusOK},
		{"phd denied staff", &model.User{Role: model.RolePhD}, RequireAdminOrProfessor, http.StatusForbidden},
		{"nil user denied", nil, RequireAdminOrProfessor, http.StatusForbidden},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			if tt.user != nil {
				r = withUser(r, tt.user)
			}
			w := httptest.NewRecorder()
			tt.middleware(next).ServeHTTP(w, r)
			if w.Code != tt.want {
				t.Fatalf("expected %d, got %d", tt.want, w.Code)
			}
		})
	}
}
