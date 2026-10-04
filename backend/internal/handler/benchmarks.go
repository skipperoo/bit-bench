package handler

import (
	"encoding/json"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"bitbench/internal/middleware"
	"bitbench/internal/model"
	"bitbench/internal/service"
)

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
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Now().Add(10 * time.Minute))
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
	var compressors map[string]interface{}
	if compressorsStr != "" {
		if err := json.Unmarshal([]byte(compressorsStr), &compressors); err != nil {
			writeError(w, "invalid compressors JSON", http.StatusBadRequest)
			return
		}
	} else {
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

	benchmark, err := service.App.Benchmark.CreateBenchmark(r.Context(), actor, name, uploads, compressors)
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
	claims := middleware.ClaimsFromContext(r.Context())
	if claims == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	userID, _ := uuid.Parse(claims.Sub)

	q := r.URL.Query()
	search := q.Get("q")
	status := q.Get("status")
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = 20
	}

	var cursor *time.Time
	if c := q.Get("cursor"); c != "" {
		t, err := time.Parse(time.RFC3339Nano, c)
		if err == nil {
			cursor = &t
		}
	}

	result, err := service.App.Benchmark.ListBenchmarks(r.Context(), &userID, cursor, search, status, limit)
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

func GetBenchmark(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, "invalid id", http.StatusBadRequest)
		return
	}

	benchID, err := uuid.Parse(id)
	if err != nil {
		writeError(w, "invalid id", http.StatusBadRequest)
		return
	}

	resp, err := service.App.Benchmark.GetBenchmark(r.Context(), benchID)
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
	id := r.PathValue("id")
	if id == "" {
		writeError(w, "invalid id", http.StatusBadRequest)
		return
	}

	benchID, err := uuid.Parse(id)
	if err != nil {
		writeError(w, "invalid id", http.StatusBadRequest)
		return
	}

	benchmark, err := service.App.Benchmark.GetBenchmarkStatus(r.Context(), benchID)
	if err != nil {
		writeError(w, "failed to get status", http.StatusInternalServerError)
		return
	}
	if benchmark == nil {
		writeError(w, "benchmark not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":      benchmark.Status,
		"progress":    benchmark.Progress,
		"started_at":  benchmark.StartedAt,
		"finished_at": benchmark.FinishedAt,
		"error":       benchmark.Error,
	})
}

func CompareBenchmarks(w http.ResponseWriter, r *http.Request) {
	idsStr := r.URL.Query().Get("ids")
	if idsStr == "" {
		writeError(w, "ids parameter is required", http.StatusBadRequest)
		return
	}

	idStrs := strings.Split(idsStr, ",")
	if len(idStrs) > 5 {
		idStrs = idStrs[:5]
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

	resp, err := service.App.Benchmark.CompareBenchmarks(r.Context(), ids)
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
