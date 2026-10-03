package service

import (
	"runtime"
	"sync"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/load"

	"bitbench/internal/model"
)

type cpuStaticInfo struct {
	model    string
	physical int
	logical  int
	mhz      float64
	flags    []string
}

var (
	cpuOnce   sync.Once
	cpuStatic cpuStaticInfo
)

func readCPUStaticInfo() cpuStaticInfo {
	cpuOnce.Do(func() {
		logical, _ := cpu.Counts(true)
		if logical == 0 {
			logical = runtime.NumCPU()
		}
		physical, _ := cpu.Counts(false)

		var model string
		var mhz float64
		var flags []string
		if infos, err := cpu.Info(); err == nil && len(infos) > 0 {
			model = infos[0].ModelName
			mhz = infos[0].Mhz
			flags = append(flags, infos[0].Flags...)
		}

		cpuStatic = cpuStaticInfo{
			model:    model,
			physical: physical,
			logical:  logical,
			mhz:      mhz,
			flags:    flags,
		}
	})
	return cpuStatic
}

// CollectCPUStatus returns static CPU information (cached) plus live load
// averages. It never fails; unavailable fields are left at their zero value.
func CollectCPUStatus() *model.CPUStatus {
	info := readCPUStaticInfo()

	var load1, load5, load15 float64
	if avg, err := load.Avg(); err == nil {
		load1, load5, load15 = avg.Load1, avg.Load5, avg.Load15
	}

	return BuildCPUStatus(info.model, info.physical, info.logical, info.mhz, info.flags, load1, load5, load15)
}

// BuildCPUStatus assembles the CPU payload and derives utilization from the
// 1-minute load average relative to the logical core count.
func BuildCPUStatus(modelName string, physical, logical int, mhz float64, flags []string, load1, load5, load15 float64) *model.CPUStatus {
	if logical <= 0 {
		logical = runtime.NumCPU()
	}

	utilization := 0.0
	if logical > 0 {
		utilization = load1 / float64(logical) * 100
		if utilization > 100 {
			utilization = 100
		}
		if utilization < 0 {
			utilization = 0
		}
	}

	f := make([]string, len(flags))
	copy(f, flags)

	return &model.CPUStatus{
		Model:         modelName,
		PhysicalCores: physical,
		LogicalCores:  logical,
		MHz:           mhz,
		Load1:         load1,
		Load5:         load5,
		Load15:        load15,
		Utilization:   utilization,
		Flags:         f,
	}
}
