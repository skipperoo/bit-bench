package service

import (
	"runtime"
	"testing"
)

func TestBuildCPUStatus(t *testing.T) {
	flags := []string{"sse4_2", "avx2", "avx512f"}
	status := BuildCPUStatus("AMD Ryzen 9 7950X", 16, 32, 4500, flags, 8, 7, 6)

	if status.Model != "AMD Ryzen 9 7950X" {
		t.Errorf("Model = %q", status.Model)
	}
	if status.PhysicalCores != 16 || status.LogicalCores != 32 {
		t.Errorf("cores = %d/%d, want 16/32", status.PhysicalCores, status.LogicalCores)
	}
	if status.MHz != 4500 {
		t.Errorf("MHz = %v, want 4500", status.MHz)
	}
	if status.Load1 != 8 || status.Load5 != 7 || status.Load15 != 6 {
		t.Errorf("loads = %v/%v/%v, want 8/7/6", status.Load1, status.Load5, status.Load15)
	}
	if status.Utilization != 25 {
		t.Errorf("Utilization = %v, want 25", status.Utilization)
	}
	if len(status.Flags) != 3 || status.Flags[1] != "avx2" {
		t.Errorf("Flags = %v", status.Flags)
	}
}

func TestBuildCPUStatusClampsUtilization(t *testing.T) {
	status := BuildCPUStatus("cpu", 4, 8, 0, nil, 24, 0, 0)
	if status.Utilization != 100 {
		t.Errorf("Utilization = %v, want clamped to 100", status.Utilization)
	}
}

func TestBuildCPUStatusNegativeLoad(t *testing.T) {
	status := BuildCPUStatus("cpu", 4, 8, 0, nil, -1, 0, 0)
	if status.Utilization != 0 {
		t.Errorf("Utilization = %v, want 0", status.Utilization)
	}
}

func TestBuildCPUStatusZeroLogicalFallback(t *testing.T) {
	status := BuildCPUStatus("cpu", 0, 0, 0, nil, 1, 1, 1)
	if status.LogicalCores != runtime.NumCPU() {
		t.Errorf("LogicalCores = %d, want runtime.NumCPU() = %d", status.LogicalCores, runtime.NumCPU())
	}
}

func TestBuildCPUStatusCopiesFlags(t *testing.T) {
	flags := []string{"avx2"}
	status := BuildCPUStatus("cpu", 1, 2, 0, flags, 0, 0, 0)
	flags[0] = "mutated"
	if status.Flags[0] != "avx2" {
		t.Errorf("Flags aliases the input slice: %v", status.Flags)
	}
}
