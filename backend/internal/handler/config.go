package handler

import (
	"encoding/json"
	"net/http"

	"bitbench/internal/config"
	"bitbench/internal/model"
)

var AppConfig *config.Config

func InitHandlers(cfg *config.Config) {
	AppConfig = cfg
}

func GetConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(model.ConfigResponse{
		MaxFileSizeMB: AppConfig.MaxFileSizeMB,
		MaxCompare:    AppConfig.MaxCompare,
		SMTPEnabled:   AppConfig.SMTPEnabled(),
	})
}
