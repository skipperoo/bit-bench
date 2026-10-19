package compressor

import (
	"fmt"
	"strings"
)

const (
	// PlatformAMD64 is the canonical x86-64 Linux platform string.
	PlatformAMD64 = "linux/amd64"
	// PlatformARM64 is the canonical 64-bit ARM Linux platform string.
	PlatformARM64 = "linux/arm64"
)

// SupportedPlatforms lists the platforms user packages may target.
var SupportedPlatforms = []string{PlatformAMD64, PlatformARM64}

// NormalizePlatform validates an os/arch[/variant] platform string and returns
// the canonical linux/amd64 or linux/arm64 form.
func NormalizePlatform(platform string) (string, error) {
	trimmed := strings.ToLower(strings.TrimSpace(platform))
	parts := strings.Split(trimmed, "/")
	if len(parts) < 2 || len(parts) > 3 {
		return "", fmt.Errorf("invalid platform %q: expected os/arch[/variant]", platform)
	}
	if parts[0] != "linux" {
		return "", fmt.Errorf("unsupported platform %q: only linux is supported", platform)
	}

	switch parts[1] {
	case "amd64", "x86_64":
		if len(parts) == 3 && parts[2] != "" {
			return "", fmt.Errorf("unsupported platform %q: amd64 has no supported variants", platform)
		}
		return PlatformAMD64, nil
	case "arm64", "aarch64":
		if len(parts) == 3 && parts[2] != "" && parts[2] != "v8" {
			return "", fmt.Errorf("unsupported platform %q: only the arm64/v8 variant is supported", platform)
		}
		return PlatformARM64, nil
	default:
		return "", fmt.Errorf("unsupported platform %q: supported platforms are %s and %s",
			platform, PlatformAMD64, PlatformARM64)
	}
}

// ResolvePlatform returns the normalized declared platform, or the host
// platform when the package leaves the platform unspecified.
func ResolvePlatform(declared, hostPlatform string) string {
	if strings.TrimSpace(declared) == "" {
		return hostPlatform
	}
	normalized, err := NormalizePlatform(declared)
	if err != nil {
		return hostPlatform
	}
	return normalized
}

// HostPlatform maps Go/Docker architecture names to an OCI platform string.
func HostPlatform(goos, arch string) string {
	if goos == "" {
		goos = "linux"
	}
	switch arch {
	case "x86_64", "amd64":
		return PlatformAMD64
	case "aarch64", "arm64":
		return PlatformARM64
	default:
		return goos + "/" + arch
	}
}

// PlatformArch returns the architecture component of a canonical platform.
func PlatformArch(platform string) string {
	if _, arch, ok := strings.Cut(platform, "/"); ok {
		return arch
	}
	return platform
}
