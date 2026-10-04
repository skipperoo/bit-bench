// Package runner executes user-provided compressor packages inside
// sandboxed Docker containers. Containers never receive the Docker socket.
package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
	"time"

	"github.com/moby/go-archive"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

// Mount describes a mount for a runner container.
type Mount struct {
	Type     string // "volume" or "bind"
	Source   string
	Target   string
	ReadOnly bool
}

// Container spec for a single execution.
type Spec struct {
	Mounts     []Mount
	WorkingDir string
	Command    string // executed as /bin/sh -c
	Env        []string
	User       string // "0" for build, non-root for runs
	Workers    int    // CPU quota; <= 0 means unlimited
	// KillOnThrottle kills the container and returns ErrWorkerQuota when the
	// process exceeds its declared CPU quota by more than the tolerated margin.
	KillOnThrottle bool
}

// Result of a container execution.
type Result struct {
	ExitCode int
	Logs     string
}

var (
	// ErrTimeout indicates the container exceeded its context deadline.
	ErrTimeout = errors.New("container timed out")
	// ErrWorkerQuota indicates the process used more CPU than declared.
	ErrWorkerQuota = errors.New("worker quota exceeded")
)

// DockerRunner spawns sandboxed containers using the Docker daemon.
type DockerRunner struct {
	cli       *client.Client
	image     string
	memoryMB  int64
	pidsLimit int64
}

func NewDockerRunner(image string, memoryMB, pidsLimit int64) (*DockerRunner, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("docker client: %w", err)
	}
	return &DockerRunner{cli: cli, image: image, memoryMB: memoryMB, pidsLimit: pidsLimit}, nil
}

func (d *DockerRunner) Close() error {
	if d.cli == nil {
		return nil
	}
	return d.cli.Close()
}

// Ping verifies connectivity to the Docker daemon and image availability.
func (d *DockerRunner) Ping(ctx context.Context) error {
	if _, err := d.cli.Ping(ctx, client.PingOptions{}); err != nil {
		return fmt.Errorf("docker daemon unreachable: %w", err)
	}
	if _, err := d.cli.ImageInspect(ctx, d.image); err != nil {
		return fmt.Errorf("runner image %q not available: %w", d.image, err)
	}
	return nil
}

// Run executes a container spec and waits for it to finish.
func (d *DockerRunner) Run(ctx context.Context, spec Spec) (*Result, error) {
	if spec.Command == "" {
		return nil, fmt.Errorf("empty command")
	}

	mounts := make([]mount.Mount, 0, len(spec.Mounts))
	for _, m := range spec.Mounts {
		mt := mount.TypeVolume
		if m.Type == "bind" {
			mt = mount.TypeBind
		}
		mounts = append(mounts, mount.Mount{
			Type:     mt,
			Source:   m.Source,
			Target:   m.Target,
			ReadOnly: m.ReadOnly,
		})
	}

	user := spec.User
	if user == "" {
		user = "0"
	}

	cfg := &container.Config{
		Image:           d.image,
		Cmd:             []string{"/bin/sh", "-c", spec.Command},
		WorkingDir:      spec.WorkingDir,
		Env:             spec.Env,
		User:            user,
		NetworkDisabled: true,
		AttachStdout:    true,
		AttachStderr:    true,
	}

	pids := d.pidsLimit
	resources := container.Resources{}
	if d.memoryMB > 0 {
		resources.Memory = d.memoryMB * 1024 * 1024
	}
	if pids > 0 {
		resources.PidsLimit = &pids
	}
	if spec.Workers > 0 {
		resources.NanoCPUs = int64(spec.Workers) * 1_000_000_000
	}

	hostCfg := &container.HostConfig{
		NetworkMode:    "none",
		ReadonlyRootfs: true,
		Tmpfs:          map[string]string{"/tmp": "rw,size=2g"},
		Mounts:         mounts,
		Resources:      resources,
	}

	created, err := d.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
		Config:           cfg,
		HostConfig:       hostCfg,
		NetworkingConfig: &network.NetworkingConfig{},
	})
	if err != nil {
		return nil, fmt.Errorf("create container: %w", err)
	}
	defer func() {
		removeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, _ = d.cli.ContainerRemove(removeCtx, created.ID, client.ContainerRemoveOptions{Force: true})
	}()

	start := time.Now()
	if _, err := d.cli.ContainerStart(ctx, created.ID, client.ContainerStartOptions{}); err != nil {
		return nil, fmt.Errorf("start container: %w", err)
	}

	stopMonitor := make(chan struct{})
	var quotaExceeded atomic.Bool
	if spec.KillOnThrottle && spec.Workers > 0 {
		go d.monitorThrottling(ctx, created.ID, start, stopMonitor, &quotaExceeded)
	}

	wait := d.cli.ContainerWait(ctx, created.ID, client.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	var exitCode int
	var waitErr error
	select {
	case <-ctx.Done():
		close(stopMonitor)
		killCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_, _ = d.cli.ContainerKill(killCtx, created.ID, client.ContainerKillOptions{Signal: "SIGKILL"})
		cancel()
		return nil, fmt.Errorf("%w: %v", ErrTimeout, ctx.Err())
	case err := <-wait.Error:
		waitErr = err
	case status := <-wait.Result:
		exitCode = int(status.StatusCode)
	}
	close(stopMonitor)

	if waitErr != nil {
		return nil, fmt.Errorf("wait container: %w", waitErr)
	}
	if quotaExceeded.Load() {
		return nil, ErrWorkerQuota
	}

	logs, logErr := d.containerLogs(ctx, created.ID)
	if logErr != nil {
		return nil, fmt.Errorf("read container logs: %w", logErr)
	}

	return &Result{ExitCode: exitCode, Logs: logs}, nil
}

// monitorThrottling polls cgroup CPU counters and kills the container when
// throttled time exceeds max(2s, 5% of runtime).
func (d *DockerRunner) monitorThrottling(ctx context.Context, id string, start time.Time, stop <-chan struct{}, exceeded *atomic.Bool) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-stop:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			throttled, err := d.throttledTime(ctx, id)
			if err != nil {
				continue
			}
			threshold := 2 * time.Second
			if frac := time.Duration(float64(time.Since(start)) * 0.05); frac > threshold {
				threshold = frac
			}
			if throttled > threshold {
				exceeded.Store(true)
				killCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				_, _ = d.cli.ContainerKill(killCtx, id, client.ContainerKillOptions{Signal: "SIGKILL"})
				cancel()
				return
			}
		}
	}
}

func (d *DockerRunner) throttledTime(ctx context.Context, id string) (time.Duration, error) {
	resp, err := d.cli.ContainerStats(ctx, id, client.ContainerStatsOptions{Stream: false})
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	var stats container.StatsResponse
	if err := json.NewDecoder(resp.Body).Decode(&stats); err != nil {
		return 0, err
	}
	return time.Duration(stats.CPUStats.ThrottlingData.ThrottledTime) * time.Nanosecond, nil
}

func (d *DockerRunner) containerLogs(ctx context.Context, id string) (string, error) {
	rc, err := d.cli.ContainerLogs(ctx, id, client.ContainerLogsOptions{
		ShowStdout: true,
		ShowStderr: true,
	})
	if err != nil {
		return "", err
	}
	defer rc.Close()

	var buf bytes.Buffer
	if _, err := stdcopy.StdCopy(&buf, &buf, rc); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// BuildImage builds a Docker image from contextDir. Used by tooling and E2E tests.
func (d *DockerRunner) BuildImage(ctx context.Context, contextDir, tag string) (string, error) {
	tar, err := archive.TarWithOptions(contextDir, &archive.TarOptions{})
	if err != nil {
		return "", fmt.Errorf("tar context: %w", err)
	}
	defer tar.Close()

	resp, err := d.cli.ImageBuild(ctx, tar, client.ImageBuildOptions{
		Tags:       []string{tag},
		Dockerfile: "Dockerfile",
		Remove:     true,
	})
	if err != nil {
		return "", fmt.Errorf("image build: %w", err)
	}
	defer resp.Body.Close()

	var logs strings.Builder
	if _, err := io.Copy(&logs, resp.Body); err != nil {
		return logs.String(), fmt.Errorf("read build output: %w", err)
	}
	return logs.String(), nil
}

// Tail returns the last n lines of s.
func Tail(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) <= n {
		return strings.Join(lines, "\n")
	}
	return strings.Join(lines[len(lines)-n:], "\n")
}
