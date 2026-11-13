package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"bitbench/internal/middleware"
	"bitbench/internal/model"
	"bitbench/internal/repository"
	"bitbench/internal/service"
)

// canViewBenchmark reports whether actor may read a benchmark: its owner or an
// administrator (the same scope as the benchmark list).
func canViewBenchmark(actor *model.User, b *model.Benchmark) bool {
	if actor == nil || b == nil {
		return false
	}
	return actor.Role == model.RoleAdmin || b.UserID == actor.ID
}

// loadViewableBenchmark parses the {id} path value and loads the benchmark,
// writing the error response itself when it is missing or not visible.
func loadViewableBenchmark(w http.ResponseWriter, r *http.Request) *model.Benchmark {
	benchID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, "invalid id", http.StatusBadRequest)
		return nil
	}
	benchmark, err := service.App.Benchmark.GetBenchmarkStatus(r.Context(), benchID)
	if err != nil {
		writeError(w, "failed to get benchmark", http.StatusInternalServerError)
		return nil
	}
	// Report foreign benchmarks as missing so ids cannot be probed.
	if benchmark == nil || !canViewBenchmark(middleware.UserFromContext(r.Context()), benchmark) {
		writeError(w, "benchmark not found", http.StatusNotFound)
		return nil
	}
	return benchmark
}

func ListChecksums(w http.ResponseWriter, r *http.Request) {
	checksums, err := service.App.Benchmark.ListChecksums(r.Context())
	if err != nil {
		writeError(w, "failed to list checksums", http.StatusInternalServerError)
		return
	}
	result := make([]map[string]string, len(checksums))
	for i, c := range checksums {
		result[i] = map[string]string{"checksum": c}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func CreateBenchmark(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// Normalization (CSV/zip/tar -> .bin) runs synchronously in this handler,
	// so allow well beyond the server's default write timeout for large files.
	// The server-wide ReadTimeout (60s) would also cut large uploads short.
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetReadDeadline(time.Now().Add(30 * time.Minute))
		_ = rc.SetWriteDeadline(time.Now().Add(40 * time.Minute))
	}

	if err := r.ParseMultipartForm(100 << 20); err != nil { // 100 MB max memory
		writeError(w, "failed to parse form", http.StatusBadRequest)
		return
	}

	name := r.FormValue("name")
	if name == "" {
		writeError(w, "name is required", http.StatusBadRequest)
		return
	}

	compressorsStr := r.FormValue("compressors")
	if strings.TrimSpace(compressorsStr) == "" {
		writeError(w, "compressors are required", http.StatusBadRequest)
		return
	}

	// Accept one or many files: "files" (repeated) or the legacy "file" field.
	var headers []*multipart.FileHeader
	if r.MultipartForm != nil {
		headers = r.MultipartForm.File["files"]
		if len(headers) == 0 {
			headers = r.MultipartForm.File["file"]
		}
	}
	if len(headers) == 0 {
		writeError(w, "file is required", http.StatusBadRequest)
		return
	}

	uploads := make([]service.UploadedFile, 0, len(headers))
	openFiles := make([]multipart.File, 0, len(headers))
	defer func() {
		for _, f := range openFiles {
			f.Close()
		}
	}()

	for _, header := range headers {
		file, err := header.Open()
		if err != nil {
			writeError(w, "failed to read uploaded file", http.StatusBadRequest)
			return
		}
		openFiles = append(openFiles, file)
		uploads = append(uploads, service.UploadedFile{Reader: file, Filename: header.Filename})
	}

	opts := service.DefaultBenchmarkOptions()
	if agg := r.FormValue("aggregation"); agg != "" {
		opts.Aggregation = agg
	}
	if mm := r.FormValue("measure_memory"); mm != "" {
		opts.MeasureMemory = mm == "true" || mm == "1"
	}

	// mode=separate: one benchmark per file, named "<name> (<file stem>)", in
	// a single request (so the per-user upload rate limit counts it once).
	if r.FormValue("mode") == "separate" && len(uploads) > 1 {
		opts.ExperimentID = uuid.New()
		created := make([]*model.Benchmark, 0, len(uploads))
		for _, up := range uploads {
			stem := strings.TrimSuffix(filepath.Base(up.Filename), filepath.Ext(up.Filename))
			b, err := service.App.Benchmark.CreateBenchmarkWithOptions(r.Context(), actor,
				fmt.Sprintf("%s (%s)", name, stem), []service.UploadedFile{up}, []byte(compressorsStr), opts)
			if err != nil {
				if len(created) == 0 {
					writeError(w, err.Error(), http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]interface{}{
					"benchmarks": created,
					"error":      fmt.Sprintf("%s: %v", up.Filename, err),
				})
				return
			}
			created = append(created, b)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]interface{}{"benchmarks": created})
		return
	}

	benchmark, err := service.App.Benchmark.CreateBenchmarkWithOptions(r.Context(), actor, name, uploads, []byte(compressorsStr), opts)
	if err != nil {
		msg := err.Error()
		// Detect stale JWT after DB reset
		if strings.Contains(msg, "violates foreign key constraint") && strings.Contains(msg, "user_id") {
			writeError(w, "user session invalid, please re-login", http.StatusUnauthorized)
			return
		}
		writeError(w, msg, http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(benchmark)
}

func ListBenchmarks(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = 20
	}
	params := repository.ListBenchmarksParams{
		UserID:     &actor.ID,
		Search:     q.Get("q"),
		Status:     q.Get("status"),
		Source:     q.Get("source"),
		Dataset:    q.Get("dataset"),
		Compressor: q.Get("compressor"),
		Limit:      limit,
	}
	if c := q.Get("cursor"); c != "" {
		if t, err := time.Parse(time.RFC3339Nano, c); err == nil {
			params.Cursor = &t
		}
	}

	result, err := service.App.Benchmark.ListBenchmarks(r.Context(), params)
	if err != nil {
		writeError(w, "failed to list benchmarks", http.StatusInternalServerError)
		return
	}

	benchmarks := result.Benchmarks
	if benchmarks == nil {
		benchmarks = []*model.Benchmark{}
	}

	resp := map[string]interface{}{
		"benchmarks": benchmarks,
	}
	if result.NextCursor != nil {
		resp["next_cursor"] = result.NextCursor.Format(time.RFC3339Nano)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// DeleteBenchmark lets the owner (or an admin) delete a benchmark.
func DeleteBenchmark(w http.ResponseWriter, r *http.Request) {
	benchmark := loadViewableBenchmark(w, r)
	if benchmark == nil {
		return
	}
	if err := service.App.Benchmark.DeleteBenchmark(r.Context(), benchmark.ID); err != nil {
		writeError(w, "failed to delete benchmark", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RenameBenchmark lets the owner (or an admin) rename a benchmark: body {name}.
func RenameBenchmark(w http.ResponseWriter, r *http.Request) {
	benchmark := loadViewableBenchmark(w, r)
	if benchmark == nil {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	name, err := service.App.Benchmark.RenameBenchmark(r.Context(), benchmark.ID, body.Name)
	if errors.Is(err, service.ErrInvalidBenchmarkName) {
		writeError(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err != nil {
		writeError(w, "failed to rename benchmark", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"id": benchmark.ID.String(), "name": name})
}

// CancelBenchmark lets the owner (or an admin) cancel a queued or running
// benchmark.
func CancelBenchmark(w http.ResponseWriter, r *http.Request) {
	benchmark := loadViewableBenchmark(w, r)
	if benchmark == nil {
		return
	}
	ok, err := service.App.Benchmark.CancelBenchmark(r.Context(), benchmark.ID, "cancelled by user")
	if err != nil {
		writeError(w, "failed to cancel benchmark", http.StatusInternalServerError)
		return
	}
	if !ok {
		writeError(w, "benchmark already finished", http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "cancelled"})
}

func GetBenchmark(w http.ResponseWriter, r *http.Request) {
	benchmark := loadViewableBenchmark(w, r)
	if benchmark == nil {
		return
	}

	resp, err := service.App.Benchmark.GetBenchmark(r.Context(), benchmark.ID)
	if err != nil {
		writeError(w, "failed to get benchmark", http.StatusInternalServerError)
		return
	}
	if resp == nil {
		writeError(w, "benchmark not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func GetBenchmarkStatus(w http.ResponseWriter, r *http.Request) {
	benchmark := loadViewableBenchmark(w, r)
	if benchmark == nil {
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(benchmarkStatusPayload(benchmark))
}

// benchmarkStatusPayload is the polling view of a benchmark, shared by the
// status and progress endpoints.
func benchmarkStatusPayload(b *model.Benchmark) map[string]interface{} {
	return map[string]interface{}{
		"benchmark_id": b.ID,
		"status":       b.Status,
		"progress":     b.Progress,
		"started_at":   b.StartedAt,
		"finished_at":  b.FinishedAt,
		"error":        b.Error,
	}
}

func CompareBenchmarks(w http.ResponseWriter, r *http.Request) {
	idsStr := r.URL.Query().Get("ids")
	if idsStr == "" {
		writeError(w, "ids parameter is required", http.StatusBadRequest)
		return
	}

	idStrs := strings.Split(idsStr, ",")
	if AppConfig != nil && AppConfig.MaxCompare > 0 && len(idStrs) > AppConfig.MaxCompare {
		maxCompare := AppConfig.MaxCompare
		idStrs = idStrs[:maxCompare]
	}

	ids := make([]uuid.UUID, 0, len(idStrs))
	for _, s := range idStrs {
		id, err := uuid.Parse(strings.TrimSpace(s))
		if err != nil {
			writeError(w, "invalid id: "+s, http.StatusBadRequest)
			return
		}
		ids = append(ids, id)
	}

	resp, err := service.App.Benchmark.CompareBenchmarks(r.Context(), middleware.UserFromContext(r.Context()), ids)
	if err != nil {
		writeError(w, "failed to compare", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func GetStatus(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	var status *model.StatusResponse
	var err error
	if claims != nil {
		uid, _ := uuid.Parse(claims.Sub)
		status, err = service.App.Benchmark.GetUserStatus(r.Context(), &uid)
	} else {
		status, err = service.App.Benchmark.GetStatus(r.Context())
	}
	if err != nil {
		writeError(w, "failed to get status", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// ListBenchmarkTasks returns the task table of a benchmark for the live run
// view (owner or admin).
func ListBenchmarkTasks(w http.ResponseWriter, r *http.Request) {
	benchmark := loadViewableBenchmark(w, r)
	if benchmark == nil {
		return
	}
	tasks, err := service.App.Benchmark.ListTasks(r.Context(), benchmark.ID)
	if err != nil {
		writeError(w, "failed to list tasks", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"tasks": tasks})
}
