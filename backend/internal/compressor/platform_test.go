package compressor

import "testing"

func TestNormalizePlatform(t *testing.T) {
	valid := map[string]string{
		"linux/amd64":    PlatformAMD64,
		"linux/arm64":    PlatformARM64,
		"linux/arm64/v8": PlatformARM64,
		" LINUX/ARM64 ":  PlatformARM64,
		"linux/aarch64":  PlatformARM64,
		"linux/x86_64":   PlatformAMD64,
	}
	for input, want := range valid {
		got, err := NormalizePlatform(input)
		if err != nil {
			t.Errorf("NormalizePlatform(%q): %v", input, err)
			continue
		}
		if got != want {
			t.Errorf("NormalizePlatform(%q) = %q, want %q", input, got, want)
		}
	}

	invalid := []string{
		"",
		"arm64",
		"linux",
		"windows/amd64",
		"linux/ppc64le",
		"linux/arm/v7",
		"linux/amd64/v2",
		"linux/arm64/v9",
		"linux/amd64/extra/parts",
	}
	for _, input := range invalid {
		if _, err := NormalizePlatform(input); err == nil {
			t.Errorf("NormalizePlatform(%q) should fail", input)
		}
	}
}

func TestResolvePlatform(t *testing.T) {
	if got := ResolvePlatform("", PlatformAMD64); got != PlatformAMD64 {
		t.Errorf("empty platform = %q, want host", got)
	}
	if got := ResolvePlatform("linux/arm64/v8", PlatformAMD64); got != PlatformARM64 {
		t.Errorf("normalized platform = %q", got)
	}
	// Invalid declarations fall back to the host (they are rejected by spec
	// validation before reaching this point).
	if got := ResolvePlatform("solaris/sparc", PlatformAMD64); got != PlatformAMD64 {
		t.Errorf("invalid platform = %q, want host", got)
	}
}

func TestHostPlatform(t *testing.T) {
	tests := map[string]string{
		"x86_64":  PlatformAMD64,
		"amd64":   PlatformAMD64,
		"aarch64": PlatformARM64,
		"arm64":   PlatformARM64,
	}
	for arch, want := range tests {
		if got := HostPlatform("linux", arch); got != want {
			t.Errorf("HostPlatform(linux, %q) = %q, want %q", arch, got, want)
		}
	}
	if got := HostPlatform("linux", "riscv64"); got != "linux/riscv64" {
		t.Errorf("HostPlatform fallback = %q", got)
	}
}
