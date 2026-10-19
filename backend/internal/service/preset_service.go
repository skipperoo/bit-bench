package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"bitbench/internal/compressor"
	"bitbench/internal/config"
	"bitbench/internal/model"
	"bitbench/internal/repository"
)

const (
	maxPresetNameLen = 100
	historyKeep      = 20
)

// PresetService manages saved compressor configurations and the per-user
// configuration history.
type PresetService struct {
	repo    *repository.PresetRepository
	pkgRepo *repository.CompressorPackageRepository
	cfg     *config.Config
}

func NewPresetService(repo *repository.PresetRepository, pkgRepo *repository.CompressorPackageRepository, cfg *config.Config) *PresetService {
	return &PresetService{repo: repo, pkgRepo: pkgRepo, cfg: cfg}
}

// Create saves the current configuration as a preset.
func (s *PresetService) Create(ctx context.Context, actor *model.User, name, visibility string, compressorsJSON []byte) (*model.BenchmarkPreset, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > maxPresetNameLen {
		return nil, fmt.Errorf("%w: preset name must be 1-%d characters", ErrBadRequest, maxPresetNameLen)
	}
	visibility, err := validateVisibility(actor, visibility)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}

	resolved, err := resolveInstances(ctx, s.pkgRepo, s.cfg.MaxParallelism, s.cfg.HostPlatform, actor, compressorsJSON)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	instances := make([]compressor.Instance, 0, len(resolved))
	for _, r := range resolved {
		// Presets describe configurations, not the environment a package was
		// built for; platform metadata is resolved again on each benchmark.
		instances = append(instances, compressor.Instance{
			Name:    r.Instance.Name,
			Options: r.Instance.Options,
			Label:   r.Instance.Label,
		})
	}

	preset := &model.BenchmarkPreset{
		OwnerID:     actor.ID,
		GroupID:     actor.GroupID,
		Name:        name,
		Visibility:  visibility,
		Compressors: instances,
	}
	if err := s.repo.Create(ctx, preset); err != nil {
		if isUniqueViolation(err) {
			return nil, fmt.Errorf("%w: a preset named %q already exists", ErrConflict, name)
		}
		return nil, err
	}
	return preset, nil
}

// List returns the presets visible to the acting user.
func (s *PresetService) List(ctx context.Context, actor *model.User) ([]*model.BenchmarkPreset, error) {
	if actor == nil {
		return nil, ErrForbidden
	}
	return s.repo.ListVisible(ctx, actor.ID, actor.GroupID, actor.Role == model.RoleAdmin)
}

// Update changes the name, visibility and/or configuration of a preset.
type PresetUpdate struct {
	Name        *string
	Visibility  *string
	Compressors json.RawMessage
}

func (s *PresetService) Update(ctx context.Context, actor *model.User, id uuid.UUID, update PresetUpdate) (*model.BenchmarkPreset, error) {
	preset, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if preset == nil {
		return nil, ErrNotFound
	}
	if !CanManagePreset(actor, preset) {
		return nil, ErrForbidden
	}

	name := preset.Name
	if update.Name != nil {
		name = strings.TrimSpace(*update.Name)
		if name == "" || len(name) > maxPresetNameLen {
			return nil, fmt.Errorf("%w: preset name must be 1-%d characters", ErrBadRequest, maxPresetNameLen)
		}
	}

	visibility := preset.Visibility
	if update.Visibility != nil {
		// Only the owner and administrators may change a preset's exposure.
		// Professors editing a shared preset keep it shared.
		if actor.ID == preset.OwnerID || actor.Role == model.RoleAdmin {
			visibility, err = validateVisibility(actor, *update.Visibility)
			if err != nil {
				return nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
			}
		}
	}

	instances := preset.Compressors
	if len(update.Compressors) > 0 {
		resolved, err := resolveInstances(ctx, s.pkgRepo, s.cfg.MaxParallelism, s.cfg.HostPlatform, actor, update.Compressors)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
		}
		instances = make([]compressor.Instance, 0, len(resolved))
		for _, r := range resolved {
			instances = append(instances, compressor.Instance{
				Name:    r.Instance.Name,
				Options: r.Instance.Options,
				Label:   r.Instance.Label,
			})
		}
	}

	if err := s.repo.Update(ctx, id, name, visibility, instances); err != nil {
		if isUniqueViolation(err) {
			return nil, fmt.Errorf("%w: a preset named %q already exists", ErrConflict, name)
		}
		return nil, err
	}
	preset.Name = name
	preset.Visibility = visibility
	preset.Compressors = instances
	return preset, nil
}

func (s *PresetService) Delete(ctx context.Context, actor *model.User, id uuid.UUID) error {
	preset, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return err
	}
	if preset == nil {
		return ErrNotFound
	}
	if !CanManagePreset(actor, preset) {
		return ErrForbidden
	}
	return s.repo.Delete(ctx, id)
}

// RecordHistory stores (or refreshes) a configuration in the user's history.
func (s *PresetService) RecordHistory(ctx context.Context, userID uuid.UUID, instances []compressor.Instance) error {
	if err := s.repo.UpsertHistory(ctx, userID, instances); err != nil {
		return err
	}
	return s.repo.TrimHistory(ctx, userID, historyKeep)
}

// ListHistory returns the most recent configurations of the acting user.
func (s *PresetService) ListHistory(ctx context.Context, actor *model.User) ([]*model.BenchmarkConfigHistory, error) {
	if actor == nil {
		return nil, ErrForbidden
	}
	return s.repo.ListHistory(ctx, actor.ID, historyKeep)
}

// CanManagePreset reports whether the actor may edit or delete a preset:
// its owner, an administrator, or a professor of the preset's group for
// group-shared presets.
func CanManagePreset(actor *model.User, preset *model.BenchmarkPreset) bool {
	if actor == nil || preset == nil {
		return false
	}
	if actor.Role == model.RoleAdmin || actor.ID == preset.OwnerID {
		return true
	}
	if actor.Role == model.RoleProfessor &&
		preset.Visibility == model.PresetVisibilityGroup &&
		actor.GroupID != nil && preset.GroupID != nil &&
		*actor.GroupID == *preset.GroupID {
		return true
	}
	return false
}

func validateVisibility(actor *model.User, visibility string) (string, error) {
	switch visibility {
	case model.PresetVisibilityPrivate:
		return visibility, nil
	case model.PresetVisibilityGroup:
		if actor.GroupID == nil {
			return "", fmt.Errorf("group-shared presets require group membership")
		}
		return visibility, nil
	default:
		return "", fmt.Errorf("visibility must be %q or %q", model.PresetVisibilityPrivate, model.PresetVisibilityGroup)
	}
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if ok := asPgError(err, &pgErr); ok {
		return pgErr.Code == "23505"
	}
	return false
}

func asPgError(err error, target **pgconn.PgError) bool {
	for err != nil {
		if pgErr, ok := err.(*pgconn.PgError); ok {
			*target = pgErr
			return true
		}
		type unwrapper interface{ Unwrap() error }
		unwrapped, ok := err.(unwrapper)
		if !ok {
			return false
		}
		err = unwrapped.Unwrap()
	}
	return false
}
