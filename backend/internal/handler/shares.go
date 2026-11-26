package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"bitbench/internal/compressor"
	"bitbench/internal/middleware"
	"bitbench/internal/model"
	"bitbench/internal/service"
)

// maxShareBenchmarks matches the experiment view's limit.
const maxShareBenchmarks = 32

// originPattern accepts the scheme://host[:port] the frontend runs on; it is
// only used to build the link in notification emails.
var originPattern = regexp.MustCompile(`^https?://[A-Za-z0-9.\-\[\]:]+$`)

type shareRequest struct {
	Kind         string      `json:"kind"`
	BenchmarkIDs []uuid.UUID `json:"benchmark_ids"`
	Emails       []string    `json:"emails"`
	ExpiresAt    *time.Time  `json:"expires_at"`
	Origin       string      `json:"origin"`
}

// resolveRecipients maps emails to active users (the owner is dropped); the
// error lists the emails that are not BitBench accounts.
func resolveRecipients(r *http.Request, owner *model.User, emails []string) ([]uuid.UUID, []*model.User, error) {
	var ids []uuid.UUID
	var users []*model.User
	var unknown []string
	for _, e := range emails {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		u, err := service.UserRepo.FindByEmail(r.Context(), e)
		if err != nil {
			return nil, nil, err
		}
		if u == nil {
			unknown = append(unknown, e)
			continue
		}
		if u.ID == owner.ID || slices.Contains(ids, u.ID) {
			continue
		}
		ids = append(ids, u.ID)
		users = append(users, u)
	}
	if len(unknown) > 0 {
		return nil, nil, errUnknownEmails(unknown)
	}
	return ids, users, nil
}

type errUnknownEmails []string

func (e errUnknownEmails) Error() string {
	return "not BitBench accounts: " + strings.Join(e, ", ")
}

// notifyRecipients queues an email per new recipient when SMTP is configured.
func notifyRecipients(r *http.Request, owner *model.User, s *model.Share, users []*model.User, origin string) {
	if AppConfig == nil || !AppConfig.SMTPEnabled() || !originPattern.MatchString(origin) {
		return
	}
	link := origin + "/s/" + s.Token
	body := fmt.Sprintf("%s shared BitBench results with you (read-only):\n\n%s\n\nLog in with your BitBench account to open the link.", owner.Email, link)
	if s.ExpiresAt != nil {
		body += "\nThe link expires on " + s.ExpiresAt.UTC().Format("2 Jan 2006 15:04 MST") + "."
	}
	for _, u := range users {
		_ = service.ShareRepo.QueueEmail(r.Context(), u.Email, "BitBench results shared with you", body)
	}
}

// CreateShare creates a private or public read-only link to benchmarks the
// caller owns.
func CreateShare(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	var req shareRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Kind != model.ShareKindPrivate && req.Kind != model.ShareKindPublic {
		writeError(w, "kind must be private or public", http.StatusBadRequest)
		return
	}
	if len(req.BenchmarkIDs) == 0 || len(req.BenchmarkIDs) > maxShareBenchmarks {
		writeError(w, fmt.Sprintf("share 1 to %d benchmarks", maxShareBenchmarks), http.StatusBadRequest)
		return
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range req.BenchmarkIDs {
		if seen[id] {
			writeError(w, "duplicate benchmark id", http.StatusBadRequest)
			return
		}
		seen[id] = true
		b, err := service.App.Benchmark.GetBenchmarkStatus(r.Context(), id)
		if err != nil {
			writeError(w, "failed to load benchmark", http.StatusInternalServerError)
			return
		}
		// Only the owner shares, admins included.
		if b == nil || b.UserID != user.ID {
			writeError(w, "benchmark not found", http.StatusNotFound)
			return
		}
	}
	if req.ExpiresAt != nil && !req.ExpiresAt.After(time.Now()) {
		writeError(w, "the expiry must be in the future", http.StatusBadRequest)
		return
	}

	s := &model.Share{OwnerID: user.ID, Kind: req.Kind, ExpiresAt: req.ExpiresAt, BenchmarkIDs: req.BenchmarkIDs}
	var recipients []*model.User
	if req.Kind == model.ShareKindPrivate {
		ids, users, err := resolveRecipients(r, user, req.Emails)
		if err != nil {
			if _, ok := err.(errUnknownEmails); ok {
				writeError(w, err.Error(), http.StatusBadRequest)
			} else {
				writeError(w, "failed to look up recipients", http.StatusInternalServerError)
			}
			return
		}
		if len(ids) == 0 {
			writeError(w, "add at least one BitBench account other than yours", http.StatusBadRequest)
			return
		}
		s.RecipientIDs, recipients = ids, users
		if s.Token, err = model.NewPrivateShareToken(); err != nil {
			writeError(w, "failed to create the link", http.StatusInternalServerError)
			return
		}
	} else {
		s.Token = model.PublicShareToken(AppConfig.JWTSecret, req.BenchmarkIDs)
	}
	if err := service.ShareRepo.Create(r.Context(), s); err != nil {
		writeError(w, "failed to create the link", http.StatusInternalServerError)
		return
	}
	saved, err := service.ShareRepo.FindByID(r.Context(), s.ID)
	if err != nil || saved == nil {
		writeError(w, "failed to load the link", http.StatusInternalServerError)
		return
	}
	notifyRecipients(r, user, saved, recipients, req.Origin)
	writeJSON(w, http.StatusCreated, saved)
}

// ListShares returns the caller's links for exactly ?benchmark_ids=a,b.
func ListShares(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	var ids []uuid.UUID
	for _, s := range strings.Split(r.URL.Query().Get("benchmark_ids"), ",") {
		id, err := uuid.Parse(strings.TrimSpace(s))
		if err != nil {
			writeError(w, "invalid benchmark_ids", http.StatusBadRequest)
			return
		}
		ids = append(ids, id)
	}
	shares, err := service.ShareRepo.ListForSet(r.Context(), user.ID, ids)
	if err != nil {
		writeError(w, "failed to list links", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"shares": shares})
}

// loadOwnShare returns the share in the path if the caller owns it (404 otherwise).
func loadOwnShare(w http.ResponseWriter, r *http.Request) *model.Share {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, "invalid id", http.StatusBadRequest)
		return nil
	}
	s, err := service.ShareRepo.FindByID(r.Context(), id)
	if err != nil {
		writeError(w, "failed to load the link", http.StatusInternalServerError)
		return nil
	}
	if s == nil || s.OwnerID != middleware.UserFromContext(r.Context()).ID {
		writeError(w, "link not found", http.StatusNotFound)
		return nil
	}
	return s
}

// UpdateShare changes a link's expiry ("expires_at": null = never), revokes or
// restores it, or replaces its recipients (private links).
func UpdateShare(w http.ResponseWriter, r *http.Request) {
	s := loadOwnShare(w, r)
	if s == nil {
		return
	}
	var body struct {
		ExpiresAt json.RawMessage `json:"expires_at"`
		Revoked   *bool           `json:"revoked"`
		Emails    *[]string       `json:"emails"`
		Origin    string          `json:"origin"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if len(body.ExpiresAt) > 0 {
		var t *time.Time
		if err := json.Unmarshal(body.ExpiresAt, &t); err != nil {
			writeError(w, "invalid expires_at", http.StatusBadRequest)
			return
		}
		if t != nil && !t.After(time.Now()) {
			writeError(w, "the expiry must be in the future", http.StatusBadRequest)
			return
		}
		s.ExpiresAt = t
	}
	if body.Revoked != nil {
		s.RevokedAt = nil
		if *body.Revoked {
			now := time.Now()
			s.RevokedAt = &now
		}
	}
	user := middleware.UserFromContext(r.Context())
	var added []*model.User
	if body.Emails != nil {
		if s.Kind != model.ShareKindPrivate {
			writeError(w, "public links have no recipients", http.StatusBadRequest)
			return
		}
		ids, users, err := resolveRecipients(r, user, *body.Emails)
		if err != nil {
			if _, ok := err.(errUnknownEmails); ok {
				writeError(w, err.Error(), http.StatusBadRequest)
			} else {
				writeError(w, "failed to look up recipients", http.StatusInternalServerError)
			}
			return
		}
		if len(ids) == 0 {
			writeError(w, "add at least one BitBench account other than yours", http.StatusBadRequest)
			return
		}
		for _, u := range users {
			if !slices.Contains(s.RecipientIDs, u.ID) {
				added = append(added, u)
			}
		}
		s.RecipientIDs = ids
	}
	if err := service.ShareRepo.Update(r.Context(), s); err != nil {
		writeError(w, "failed to update the link", http.StatusInternalServerError)
		return
	}
	saved, err := service.ShareRepo.FindByID(r.Context(), s.ID)
	if err != nil || saved == nil {
		writeError(w, "failed to load the link", http.StatusInternalServerError)
		return
	}
	if saved.Usable(time.Now()) {
		notifyRecipients(r, user, saved, added, body.Origin)
	}
	writeJSON(w, http.StatusOK, saved)
}

func DeleteShare(w http.ResponseWriter, r *http.Request) {
	s := loadOwnShare(w, r)
	if s == nil {
		return
	}
	if err := service.ShareRepo.Delete(r.Context(), s.ID); err != nil {
		writeError(w, "failed to delete the link", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListReceivedShares lists the usable private links shared with the caller.
func ListReceivedShares(w http.ResponseWriter, r *http.Request) {
	shares, err := service.ShareRepo.ListReceived(r.Context(), middleware.UserFromContext(r.Context()).ID)
	if err != nil {
		writeError(w, "failed to list shared links", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"shares": shares})
}

// loadOpenShare resolves the token in the path for the (optional) caller:
// 401 for a private link opened without logging in, 404 for anything else
// that does not open.
func loadOpenShare(w http.ResponseWriter, r *http.Request) (*model.Share, string) {
	s, ownerEmail, err := service.ShareRepo.FindOpenable(r.Context(), r.PathValue("token"))
	if err != nil {
		writeError(w, "failed to load the link", http.StatusInternalServerError)
		return nil, ""
	}
	if s == nil || !s.Usable(time.Now()) {
		writeError(w, "link not available", http.StatusNotFound)
		return nil, ""
	}
	user := middleware.UserFromContext(r.Context())
	if !s.CanOpen(user) {
		if user == nil {
			writeError(w, "log in to open this link", http.StatusUnauthorized)
		} else {
			writeError(w, "link not available", http.StatusNotFound)
		}
		return nil, ""
	}
	return s, ownerEmail
}

// GetShared returns the read-only page data of a share: the benchmarks with
// their results, the owner's chart styles and the custom package colours.
func GetShared(w http.ResponseWriter, r *http.Request) {
	s, ownerEmail := loadOpenShare(w, r)
	if s == nil {
		return
	}
	benchmarks := []*model.BenchmarkDetailResponse{}
	colors := map[string]string{}
	for _, id := range s.BenchmarkIDs {
		d, err := service.App.Benchmark.GetBenchmark(r.Context(), id)
		if err != nil {
			writeError(w, "failed to load benchmark", http.StatusInternalServerError)
			return
		}
		if d == nil {
			continue
		}
		// The viewer needs the results, not the owner's internals.
		b := *d.Benchmark
		b.UserID, b.Error, b.FileChecksum = uuid.Nil, nil, ""
		d.Benchmark = &b
		benchmarks = append(benchmarks, d)
		for _, inst := range b.Compressors {
			if _, builtin := compressor.Registry[inst.Name]; builtin || colors[inst.Name] != "" {
				continue
			}
			if pkg, _ := service.PackageRepo.FindByName(r.Context(), inst.Name); pkg != nil {
				var spec struct {
					Color string `json:"color"`
				}
				if json.Unmarshal(pkg.Spec, &spec) == nil && spec.Color != "" {
					colors[inst.Name] = spec.Color
				}
			}
		}
	}
	styles, err := service.UserRepo.GetChartStyles(r.Context(), s.OwnerID)
	if err != nil {
		writeError(w, "failed to load chart styles", http.StatusInternalServerError)
		return
	}
	if styles == nil {
		styles = &model.ChartStyles{Shapes: map[string]string{}, Colors: map[string]string{}, Names: map[string]string{}}
	}
	resp := map[string]any{
		"kind":           s.Kind,
		"expires_at":     s.ExpiresAt,
		"benchmarks":     benchmarks,
		"chart_styles":   styles,
		"package_colors": colors,
	}
	// Recipients know who shared with them; anonymous viewers don't learn the owner's address.
	if s.Kind == model.ShareKindPrivate {
		resp["owner_email"] = ownerEmail
	}
	writeJSON(w, http.StatusOK, resp)
}

// GetSharedSeries returns the per-signal results of one benchmark of a share.
func GetSharedSeries(w http.ResponseWriter, r *http.Request) {
	s, _ := loadOpenShare(w, r)
	if s == nil {
		return
	}
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil || !slices.Contains(s.BenchmarkIDs, id) {
		writeError(w, "benchmark not found", http.StatusNotFound)
		return
	}
	series, err := service.App.Benchmark.GetSeriesResults(r.Context(), id)
	if err != nil {
		writeError(w, "failed to load series results", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"series": series})
}
