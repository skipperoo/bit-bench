//go:build integration

package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/skipperoo/routy"

	"bitbench/internal/config"
	"bitbench/internal/middleware"
	"bitbench/internal/model"
)

func TestShares(t *testing.T) {
	_ = setupBenchmarkTest(t)
	prev := AppConfig
	cfg := config.Config{}
	if prev != nil {
		cfg = *prev
	}
	cfg.JWTSecret = "test-secret"
	AppConfig = &cfg
	t.Cleanup(func() { AppConfig = prev })
	protected := routy.NewRouter()
	protected.
		AddMiddleware(middleware.JWTAuth).
		AddMiddleware(middleware.ResolveUser).
		AddHandler("POST /benchmarks", CreateBenchmark).
		AddHandler("DELETE /benchmarks/{id}", DeleteBenchmark).
		AddHandler("POST /shares", CreateShare).
		AddHandler("GET /shares", ListShares).
		AddHandler("GET /shares/received", ListReceivedShares).
		AddHandler("PATCH /shares/{id}", UpdateShare).
		AddHandler("DELETE /shares/{id}", DeleteShare)
	router := routy.NewRouter()
	router.
		AddHandler("GET /api/v1/shared/{token}", middleware.OptionalAuth(http.HandlerFunc(GetShared)).ServeHTTP).
		AddHandler("GET /api/v1/shared/{token}/series/{id}", middleware.OptionalAuth(http.HandlerFunc(GetSharedSeries)).ServeHTTP)
	router.AddSubroute("/api/v1/", protected.Finalize())
	h := router.Finalize()

	emails := []string{"share-owner@test.com", "share-friend@test.com", "share-other@test.com"}
	for _, e := range emails {
		createTestUser(t, e, model.RoleStudent, nil)
	}
	t.Cleanup(func() {
		testDB.Exec(context.Background(), `DELETE FROM users WHERE email = ANY($1)`, emails)
	})
	owner, friend, other := tokenFor(t, emails[0]), tokenFor(t, emails[1]), tokenFor(t, emails[2])

	create := func(name string) model.Benchmark {
		w := doCreateBenchmarkWithCompressors(h, owner, name, map[string][]byte{"x.bin": sampleBinBytes(t, 8)}, `[{"name":"gzip","options":{}}]`)
		var b model.Benchmark
		json.Unmarshal(w.Body.Bytes(), &b)
		if w.Code != http.StatusCreated && w.Code != http.StatusOK {
			t.Fatalf("create benchmark: %d %s", w.Code, w.Body.String())
		}
		return b
	}
	a, b := create("share-a"), create("share-b")
	ids := []string{a.ID.String(), b.ID.String()}
	decode := func(w interface{ Bytes() []byte }) model.Share {
		var s model.Share
		json.Unmarshal(w.Bytes(), &s)
		return s
	}

	// Only the owner can share; unknown recipients are rejected.
	if w := doRequest(h, "POST", "/api/v1/shares", other, map[string]any{"kind": "public", "benchmark_ids": ids}); w.Code != http.StatusNotFound {
		t.Fatalf("foreign share = %d", w.Code)
	}
	if w := doRequest(h, "POST", "/api/v1/shares", owner, map[string]any{"kind": "private", "benchmark_ids": ids, "emails": []string{"nobody@test.com"}}); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown email = %d", w.Code)
	}
	if w := doRequest(h, "POST", "/api/v1/shares", owner, map[string]any{"kind": "private", "benchmark_ids": ids, "expires_at": time.Now().Add(-time.Hour)}); w.Code != http.StatusBadRequest {
		t.Fatalf("past expiry / no recipients = %d", w.Code)
	}

	// Private: the recipient (and owner) open it; others and anonymous don't.
	w := doRequest(h, "POST", "/api/v1/shares", owner, map[string]any{"kind": "private", "benchmark_ids": ids, "emails": []string{"Share-Friend@test.com"}})
	if w.Code != http.StatusCreated {
		t.Fatalf("private share = %d %s", w.Code, w.Body.String())
	}
	priv := decode(w.Body)
	if len(priv.Token) != 43 || len(priv.Recipients) != 1 || priv.Recipients[0] != emails[1] {
		t.Fatalf("private share = %+v", priv)
	}
	path := "/api/v1/shared/" + priv.Token
	for tok, want := range map[string]int{owner: 200, friend: 200, other: 404, "": 401} {
		if w := doRequest(h, "GET", path, tok, nil); w.Code != want {
			t.Fatalf("open private as %q = %d, want %d", tok[:min(len(tok), 8)], w.Code, want)
		}
	}
	w = doRequest(h, "GET", path, friend, nil)
	var page struct {
		OwnerEmail string                           `json:"owner_email"`
		Benchmarks []*model.BenchmarkDetailResponse `json:"benchmarks"`
	}
	json.Unmarshal(w.Body.Bytes(), &page)
	if page.OwnerEmail != emails[0] || len(page.Benchmarks) != 2 || page.Benchmarks[0].Benchmark.ID != a.ID || page.Benchmarks[0].Benchmark.UserID.String() != "00000000-0000-0000-0000-000000000000" {
		t.Fatalf("shared page = %s", w.Body.String())
	}
	if w := doRequest(h, "GET", path+"/series/"+a.ID.String(), friend, nil); w.Code != 200 {
		t.Fatalf("shared series = %d", w.Code)
	}
	if w := doRequest(h, "GET", path+"/series/"+priv.ID.String(), friend, nil); w.Code != 404 {
		t.Fatalf("series outside the share = %d", w.Code)
	}
	var received struct{ Shares []map[string]any }
	json.Unmarshal(doRequest(h, "GET", "/api/v1/shares/received", friend, nil).Body.Bytes(), &received)
	if len(received.Shares) != 1 || received.Shares[0]["token"] != priv.Token {
		t.Fatalf("received = %+v", received)
	}

	// Recipients can be replaced; a revoked link stops opening.
	sharePath := "/api/v1/shares/" + priv.ID.String()
	if w := doRequest(h, "PATCH", sharePath, other, map[string]any{"revoked": true}); w.Code != 404 {
		t.Fatalf("foreign patch = %d", w.Code)
	}
	if w := doRequest(h, "PATCH", sharePath, owner, map[string]any{"emails": []string{emails[2]}}); w.Code != 200 || decode(w.Body).Recipients[0] != emails[2] {
		t.Fatalf("patch recipients = %d %s", w.Code, w.Body.String())
	}
	if w := doRequest(h, "GET", path, other, nil); w.Code != 200 {
		t.Fatalf("new recipient = %d", w.Code)
	}
	doRequest(h, "PATCH", sharePath, owner, map[string]any{"revoked": true})
	if w := doRequest(h, "GET", path, other, nil); w.Code != 404 {
		t.Fatalf("revoked = %d", w.Code)
	}

	// Public: anonymous access, the same token for the same set (any order), expiry.
	w = doRequest(h, "POST", "/api/v1/shares", owner, map[string]any{"kind": "public", "benchmark_ids": ids})
	pub := decode(w.Body)
	if w.Code != http.StatusCreated || pub.Token[:2] != "p-" {
		t.Fatalf("public share = %d %s", w.Code, w.Body.String())
	}
	if w := doRequest(h, "GET", "/api/v1/shared/"+pub.Token, "", nil); w.Code != 200 {
		t.Fatalf("anonymous public = %d", w.Code)
	}
	doRequest(h, "PATCH", "/api/v1/shares/"+pub.ID.String(), owner, map[string]any{"revoked": true})
	again := decode(doRequest(h, "POST", "/api/v1/shares", owner, map[string]any{"kind": "public", "benchmark_ids": []string{ids[1], ids[0]}, "expires_at": time.Now().Add(time.Hour)}).Body)
	if again.Token != pub.Token || again.ID != pub.ID || again.RevokedAt != nil || again.ExpiresAt == nil {
		t.Fatalf("re-shared public = %+v, first %+v", again, pub)
	}
	var listed struct{ Shares []model.Share }
	json.Unmarshal(doRequest(h, "GET", "/api/v1/shares?benchmark_ids="+ids[1]+","+ids[0], owner, nil).Body.Bytes(), &listed)
	if len(listed.Shares) != 2 {
		t.Fatalf("listed = %d", len(listed.Shares))
	}
	testDB.Exec(context.Background(), `UPDATE shares SET expires_at = NOW() - interval '1 second' WHERE id = $1`, pub.ID)
	if w := doRequest(h, "GET", "/api/v1/shared/"+pub.Token, "", nil); w.Code != 404 {
		t.Fatalf("expired public = %d", w.Code)
	}
	testDB.Exec(context.Background(), `UPDATE shares SET expires_at = NULL WHERE id = $1`, pub.ID)

	// Deleting a benchmark drops it from the share; deleting the share ends it.
	if w := doRequest(h, "DELETE", "/api/v1/benchmarks/"+b.ID.String(), owner, nil); w.Code != http.StatusNoContent {
		t.Fatalf("delete benchmark = %d", w.Code)
	}
	page.OwnerEmail, page.Benchmarks = "", nil
	json.Unmarshal(doRequest(h, "GET", "/api/v1/shared/"+pub.Token, "", nil).Body.Bytes(), &page)
	if len(page.Benchmarks) != 1 || page.OwnerEmail != "" {
		t.Fatalf("after delete = %d benchmarks, owner %q", len(page.Benchmarks), page.OwnerEmail)
	}
	if w := doRequest(h, "DELETE", "/api/v1/shares/"+pub.ID.String(), owner, nil); w.Code != http.StatusNoContent {
		t.Fatalf("delete share = %d", w.Code)
	}
	if w := doRequest(h, "GET", "/api/v1/shared/"+pub.Token, "", nil); w.Code != 404 {
		t.Fatalf("deleted share = %d", w.Code)
	}
}
