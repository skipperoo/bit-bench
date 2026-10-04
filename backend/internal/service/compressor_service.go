package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"bitbench/internal/compressor"
	"bitbench/internal/config"
	"bitbench/internal/model"
	"bitbench/internal/repository"
	"bitbench/internal/runner"
)

var (
	ErrForbidden  = errors.New("forbidden")
	ErrNotFound   = errors.New("not found")
	ErrConflict   = errors.New("conflict")
	ErrBadRequest = errors.New("bad request")
)

// PackageRunner executes a container spec; implemented by runner.DockerRunner.
type PackageRunner interface {
	Run(ctx context.Context, spec runner.Spec) (*runner.Result, error)
}

type CompressorService struct {
	repo   *repository.CompressorPackageRepository
	cfg    *config.Config
	runner PackageRunner
}

func NewCompressorService(repo *repository.CompressorPackageRepository, cfg *config.Config) *CompressorService {
	return &CompressorService{repo: repo, cfg: cfg}
}

func (s *CompressorService) SetRunner(r PackageRunner) {
	s.runner = r
}

// UploadPackage validates, stores and registers a compressor package archive.
// The package row is created in "building" state; call Build to run the build.
func (s *CompressorService) UploadPackage(ctx context.Context, owner *model.User, groupID *uuid.UUID, file io.ReadSeeker, originalFilename string) (*model.CompressorPackage, error) {
	ext := strings.ToLower(filepath.Ext(originalFilename))
	if ext != ".zip" {
		return nil, fmt.Errorf("%w: only .zip packages are accepted", ErrBadRequest)
	}

	size, err := file.Seek(0, io.SeekEnd)
	if err != nil {
		return nil, fmt.Errorf("read package size: %w", err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("rewind package: %w", err)
	}
	if s.cfg.MaxPackageSizeMB > 0 && size > s.cfg.MaxPackageSizeMB*1024*1024 {
		return nil, fmt.Errorf("%w: package exceeds max size of %d MB", ErrBadRequest, s.cfg.MaxPackageSizeMB)
	}

	checksum, err := fileChecksum(file)
	if err != nil {
		return nil, fmt.Errorf("checksum: %w", err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("rewind package: %w", err)
	}

	workID := uuid.New()
	workRoot := filepath.Join(s.cfg.CompressorDir, workID.String())
	pkgDir := filepath.Join(workRoot, "pkg")
	archivePath := filepath.Join(workRoot, "package.zip")
	cleanup := func() { os.RemoveAll(workRoot) }

	if err := os.MkdirAll(pkgDir, 0755); err != nil {
		return nil, fmt.Errorf("create workspace: %w", err)
	}

	dst, err := os.Create(archivePath)
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("store archive: %w", err)
	}
	if _, err := io.Copy(dst, file); err != nil {
		dst.Close()
		cleanup()
		return nil, fmt.Errorf("store archive: %w", err)
	}
	dst.Close()

	maxUncompressed := s.cfg.MaxPackageSizeMB * 20 * 1024 * 1024
	if err := compressor.ExtractZipFile(archivePath, pkgDir, maxUncompressed); err != nil {
		cleanup()
		return nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}

	specBytes, err := os.ReadFile(filepath.Join(pkgDir, "spec.yaml"))
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("%w: spec.yaml not found at archive root", ErrBadRequest)
	}
	spec, err := compressor.ParseSpec(specBytes)
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	if spec.Workers > s.cfg.MaxParallelism {
		cleanup()
		return nil, fmt.Errorf("%w: workers=%d exceeds the maximum of %d", ErrBadRequest, spec.Workers, s.cfg.MaxParallelism)
	}

	specJSON, err := json.Marshal(spec)
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("encode spec: %w", err)
	}

	builtPath := workID.String()
	pkg := &model.CompressorPackage{
		ID:              workID,
		OwnerID:         owner.ID,
		GroupID:         groupID,
		Name:            spec.Name,
		Version:         spec.Version,
		Description:     spec.Description,
		Language:        spec.Language,
		Entrypoint:      spec.Entrypoint,
		Workers:         spec.Workers,
		Spec:            specJSON,
		Status:          "building",
		ArchiveChecksum: checksum,
		BuiltPath:       &builtPath,
	}

	existing, err := s.repo.FindByName(ctx, spec.Name)
	if err != nil {
		cleanup()
		return nil, err
	}

	if existing != nil {
		if existing.OwnerID != owner.ID {
			cleanup()
			return nil, fmt.Errorf("%w: compressor name %q is already taken", ErrConflict, spec.Name)
		}
		pkg.ID = existing.ID
		if existing.BuiltPath != nil && *existing.BuiltPath != workID.String() {
			os.RemoveAll(filepath.Join(s.cfg.CompressorDir, *existing.BuiltPath))
		}
		if err := s.repo.Replace(ctx, pkg); err != nil {
			cleanup()
			return nil, err
		}
	} else if err := s.repo.Create(ctx, pkg); err != nil {
		cleanup()
		if strings.Contains(err.Error(), "duplicate key") {
			return nil, fmt.Errorf("%w: compressor name %q is already taken", ErrConflict, spec.Name)
		}
		return nil, err
	}

	return pkg, nil
}

// Build runs the package's build step and verifies the entrypoint.
func (s *CompressorService) Build(ctx context.Context, id uuid.UUID) error {
	pkg, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return err
	}
	if pkg == nil {
		return fmt.Errorf("%w: package not found", ErrNotFound)
	}
	if pkg.BuiltPath == nil {
		return s.markFailed(ctx, id, "package has no workspace")
	}

	pkgDir := filepath.Join(s.cfg.CompressorDir, *pkg.BuiltPath, "pkg")

	var spec compressor.PackageSpec
	if err := json.Unmarshal(pkg.Spec, &spec); err != nil {
		return s.markFailed(ctx, id, fmt.Sprintf("decode spec: %v", err))
	}

	if s.runner == nil {
		return s.markFailed(ctx, id, "runner unavailable: Docker is not configured")
	}

	var logs string
	buildCmd := ""
	if spec.Build != nil && strings.TrimSpace(spec.Build.Command) != "" {
		buildCmd = spec.Build.Command
	} else if _, err := os.Stat(filepath.Join(pkgDir, "Makefile")); err == nil {
		buildCmd = "make"
	}

	if buildCmd != "" {
		timeout := s.cfg.BuildTimeout
		if spec.Build != nil && spec.Build.TimeoutSeconds > 0 {
			timeout = time.Duration(spec.Build.TimeoutSeconds) * time.Second
		}
		buildCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()

		result, err := s.runner.Run(buildCtx, runner.Spec{
			Mounts:     []runner.Mount{s.compressorMount(false)},
			WorkingDir: filepath.Join(s.cfg.CompressorDir, *pkg.BuiltPath, "pkg"),
			Command:    buildCmd,
			Env:        buildEnv(),
			User:       "0",
		})
		if err != nil {
			return s.markFailed(ctx, id, fmt.Sprintf("build failed: %v", err))
		}
		logs = truncateLog(result.Logs)
		if result.ExitCode != 0 {
			return s.markFailedWithLog(ctx, id, fmt.Sprintf("build failed with exit code %d", result.ExitCode), logs)
		}
	}

	if err := s.verifyEntrypoint(pkgDir, pkg.Entrypoint); err != nil {
		return s.markFailedWithLog(ctx, id, err.Error(), logs)
	}

	if err := s.repo.UpdateStatus(ctx, id, "ready", nil, pkg.BuiltPath, logs); err != nil {
		return err
	}
	return nil
}

func (s *CompressorService) verifyEntrypoint(pkgDir, entrypoint string) error {
	fields := strings.Fields(entrypoint)
	if len(fields) == 0 {
		return fmt.Errorf("entrypoint is empty")
	}
	command := fields[0]
	if !strings.Contains(command, "/") {
		return nil
	}

	path := filepath.Join(pkgDir, filepath.FromSlash(command))
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("entrypoint %q not found after build", command)
	}
	if info.IsDir() {
		return fmt.Errorf("entrypoint %q is a directory", command)
	}
	if info.Mode().Perm()&0100 == 0 {
		return fmt.Errorf("entrypoint %q is not executable", command)
	}
	return nil
}

func (s *CompressorService) markFailed(ctx context.Context, id uuid.UUID, msg string) error {
	errMsg := msg
	if err := s.repo.UpdateStatus(ctx, id, "failed", &errMsg, nil, ""); err != nil {
		return err
	}
	return fmt.Errorf("%s", msg)
}

func (s *CompressorService) markFailedWithLog(ctx context.Context, id uuid.UUID, msg, logs string) error {
	errMsg := msg
	if err := s.repo.UpdateStatus(ctx, id, "failed", &errMsg, nil, logs); err != nil {
		return err
	}
	return fmt.Errorf("%s", msg)
}

// ListVisible returns packages visible to the acting user.
func (s *CompressorService) ListVisible(ctx context.Context, actor *model.User) ([]*model.CompressorPackage, error) {
	if actor == nil {
		return nil, ErrForbidden
	}
	return s.repo.ListVisible(ctx, actor.ID, actor.GroupID, actor.Role == model.RoleAdmin)
}

// DeletePackage removes a package and its workspace if the actor may manage it.
func (s *CompressorService) DeletePackage(ctx context.Context, actor *model.User, id uuid.UUID) error {
	pkg, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return err
	}
	if pkg == nil {
		return ErrNotFound
	}
	if !canManagePackage(actor, pkg) {
		return ErrForbidden
	}
	if pkg.BuiltPath != nil {
		os.RemoveAll(filepath.Join(s.cfg.CompressorDir, *pkg.BuiltPath))
	}
	return s.repo.Delete(ctx, id)
}

func canManagePackage(actor *model.User, pkg *model.CompressorPackage) bool {
	if actor == nil {
		return false
	}
	if actor.Role == model.RoleAdmin || actor.ID == pkg.OwnerID {
		return true
	}
	if actor.Role == model.RoleProfessor && actor.GroupID != nil && pkg.GroupID != nil && *actor.GroupID == *pkg.GroupID {
		return true
	}
	return false
}

// VisibleOptions returns the option sets of ready packages visible to actor.
func (s *CompressorService) VisibleOptions(ctx context.Context, actor *model.User) (map[string]map[string]compressor.Option, error) {
	packages, err := s.ListVisible(ctx, actor)
	if err != nil {
		return nil, err
	}

	options := make(map[string]map[string]compressor.Option)
	for _, pkg := range packages {
		if pkg.Status != "ready" {
			continue
		}
		var spec compressor.PackageSpec
		if err := json.Unmarshal(pkg.Spec, &spec); err != nil {
			continue
		}
		if spec.Options == nil {
			spec.Options = map[string]compressor.Option{}
		}
		options[pkg.Name] = spec.Options
	}
	return options, nil
}

func (s *CompressorService) compressorMount(readOnly bool) runner.Mount {
	if s.cfg.CompressorVolume != "" {
		return runner.Mount{
			Type:     "volume",
			Source:   s.cfg.CompressorVolume,
			Target:   s.cfg.CompressorDir,
			ReadOnly: readOnly,
		}
	}
	return runner.Mount{
		Type:     "bind",
		Source:   s.cfg.CompressorDir,
		Target:   s.cfg.CompressorDir,
		ReadOnly: readOnly,
	}
}

func buildEnv() []string {
	return []string{
		"HOME=/tmp",
		"TMPDIR=/tmp",
		"GOCACHE=/tmp/go-build",
		"GOMODCACHE=/tmp/go/pkg/mod",
		"GOPATH=/tmp/go",
		"CARGO_HOME=/tmp/cargo",
		"RUSTUP_HOME=/tmp/rustup",
	}
}

func truncateLog(s string) string {
	const max = 64 * 1024
	if len(s) > max {
		return s[:max] + "\n...[truncated]"
	}
	return s
}
