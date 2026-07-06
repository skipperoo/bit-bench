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

func l() *slog.Logger {
	if log == nil {
		return slog.Default()
	}
	return log
}

func Info(msg string, args ...any) {
	l().Info(msg, args...)
}

func Error(msg string, args ...any) {
	l().Error(msg, args...)
}

func Warn(msg string, args ...any) {
	l().Warn(msg, args...)
}

func Debug(msg string, args ...any) {
	l().Debug(msg, args...)
}

func Fatal(msg string, args ...any) {
	l().Error(msg, args...)
	os.Exit(1)
}
