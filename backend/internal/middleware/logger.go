package middleware

import (
	"fmt"
	"net/http"
	"time"

	"bitbench/internal/logger"
)

func LoggingFunc(format string, v ...any) {
	logger.Info("request", "message", fmt.Sprintf(format, v...))
}

func StructuredLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		logger.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"duration", time.Since(start).String(),
		)
	})
}
