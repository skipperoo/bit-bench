package worker

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestSlotPoolAcquireRelease(t *testing.T) {
	pool := NewSlotPool(2)

	if err := pool.Acquire(context.Background(), 1); err != nil {
		t.Fatalf("acquire 1: %v", err)
	}
	if pool.Used() != 1 {
		t.Fatalf("used = %d, want 1", pool.Used())
	}
	if err := pool.Acquire(context.Background(), 1); err != nil {
		t.Fatalf("acquire 2: %v", err)
	}
	if pool.Used() != 2 {
		t.Fatalf("used = %d, want 2", pool.Used())
	}

	pool.Release(2)
	if pool.Used() != 0 {
		t.Fatalf("used = %d, want 0", pool.Used())
	}
}

func TestSlotPoolWaitsForRelease(t *testing.T) {
	pool := NewSlotPool(1)
	if err := pool.Acquire(context.Background(), 1); err != nil {
		t.Fatalf("acquire: %v", err)
	}

	acquired := make(chan struct{})
	go func() {
		if err := pool.Acquire(context.Background(), 1); err == nil {
			close(acquired)
		}
	}()

	select {
	case <-acquired:
		t.Fatal("acquired while pool was full")
	case <-time.After(100 * time.Millisecond):
	}

	pool.Release(1)

	select {
	case <-acquired:
	case <-time.After(time.Second):
		t.Fatal("did not acquire after release")
	}
}

func TestSlotPoolRejectsOverMax(t *testing.T) {
	pool := NewSlotPool(2)
	if err := pool.Acquire(context.Background(), 3); err != ErrTooManyWorkers {
		t.Fatalf("acquire 3 of 2 = %v, want ErrTooManyWorkers", err)
	}
}

func TestSlotPoolAcquireCancel(t *testing.T) {
	pool := NewSlotPool(1)
	if err := pool.Acquire(context.Background(), 1); err != nil {
		t.Fatalf("acquire: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := pool.Acquire(ctx, 1); err != context.Canceled {
		t.Fatalf("acquire cancelled = %v, want context.Canceled", err)
	}
	pool.Release(1)
}

func TestSlotPoolConcurrent(t *testing.T) {
	pool := NewSlotPool(4)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := pool.Acquire(context.Background(), 2); err != nil {
				t.Errorf("acquire: %v", err)
				return
			}
			time.Sleep(5 * time.Millisecond)
			pool.Release(2)
		}()
	}
	wg.Wait()

	if pool.Used() != 0 {
		t.Fatalf("used = %d after all jobs, want 0", pool.Used())
	}
}
