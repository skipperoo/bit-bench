package logger

import (
	"log/slog"
	"os"
)

var log *slog.Logger

func InitLogger() {
	log = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(log)
}

func CloseLogger() {}

func Info(msg string, args ...any) {
	log.Info(msg, args...)
}

func Error(msg string, args ...any) {
	log.Error(msg, args...)
}

func Warn(msg string, args ...any) {
	log.Warn(msg, args...)
}

func Debug(msg string, args ...any) {
	log.Debug(msg, args...)
}

func Fatal(msg string, args ...any) {
	log.Error(msg, args...)
	os.Exit(1)
}
