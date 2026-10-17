package service

import (
	"testing"

	"github.com/google/uuid"

	"bitbench/internal/compressor"
	"bitbench/internal/model"
	"bitbench/internal/repository"
)

func TestFingerprintConfig(t *testing.T) {
	config := []compressor.Instance{
		{Name: "gzip", Options: map[string]interface{}{"level": 9}, Label: "gzip · level 9"},
		{Name: "gorilla", Options: map[string]interface{}{}, Label: "gorilla"},
	}
	other := []compressor.Instance{
		{Name: "gzip", Options: map[string]interface{}{"level": 1}, Label: "gzip · level 1"},
	}

	fp := repository.FingerprintConfig(config)
	if fp != repository.FingerprintConfig(config) {
		t.Error("fingerprint must be stable")
	}
	// Labels are display metadata and must not affect the fingerprint.
	relabelled := []compressor.Instance{
		{Name: "gzip", Options: map[string]interface{}{"level": 9}, Label: "Gzip #1"},
		{Name: "gorilla", Options: map[string]interface{}{}, Label: "Gorilla"},
	}
	if fp != repository.FingerprintConfig(relabelled) {
		t.Error("labels must not change the fingerprint")
	}
	if fp == repository.FingerprintConfig(other) {
		t.Error("different configurations must have different fingerprints")
	}
}

func TestCanManagePreset(t *testing.T) {
	ownerID := uuid.New()
	groupA := uuid.New()
	groupB := uuid.New()

	presetOwner := &model.BenchmarkPreset{OwnerID: ownerID, GroupID: &groupA, Visibility: model.PresetVisibilityGroup}
	presetPrivate := &model.BenchmarkPreset{OwnerID: ownerID, GroupID: &groupA, Visibility: model.PresetVisibilityPrivate}

	admin := &model.User{ID: uuid.New(), Role: model.RoleAdmin, GroupID: &groupB}
	owner := &model.User{ID: ownerID, Role: model.RoleStudent, GroupID: &groupA}
	profSameGroup := &model.User{ID: uuid.New(), Role: model.RoleProfessor, GroupID: &groupA}
	profOtherGroup := &model.User{ID: uuid.New(), Role: model.RoleProfessor, GroupID: &groupB}
	phd := &model.User{ID: uuid.New(), Role: model.RolePhD, GroupID: &groupA}

	tests := []struct {
		name    string
		actor   *model.User
		preset  *model.BenchmarkPreset
		allowed bool
	}{
		{"owner", owner, presetOwner, true},
		{"admin", admin, presetOwner, true},
		{"professor same group on shared", profSameGroup, presetOwner, true},
		{"professor other group", profOtherGroup, presetOwner, false},
		{"professor same group on private", profSameGroup, presetPrivate, false},
		{"phd", phd, presetOwner, false},
		{"nil actor", nil, presetOwner, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := CanManagePreset(tt.actor, tt.preset); got != tt.allowed {
				t.Errorf("CanManagePreset = %v, want %v", got, tt.allowed)
			}
		})
	}
}
