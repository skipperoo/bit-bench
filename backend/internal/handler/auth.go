package handler

import (
	"encoding/json"
	"net/http"

	"bitbench/internal/model"
)

func Login(w http.ResponseWriter, r *http.Request) {
	var req model.LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	// TODO: validate credentials against DB, generate token
	_ = req

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(model.LoginResponse{Token: "placeholder"})
}

func Logout(w http.ResponseWriter, r *http.Request) {
	// TODO: add JWT to Redis blocklist
	w.WriteHeader(http.StatusOK)
}

func ChangePassword(w http.ResponseWriter, r *http.Request) {
	// TODO: update password hash
	w.WriteHeader(http.StatusOK)
}

func Me(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(claims)
}

func writeError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(model.ErrorResponse{Error: msg})
}
