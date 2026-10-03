package worker

import (
	"context"
	"errors"
	"sync"
)

// ErrTooManyWorkers is returned when a request exceeds the total pool size.
var ErrTooManyWorkers = errors.New("worker requirement exceeds maximum available workers")

// SlotPool hands out CPU worker slots to concurrent compressor runs.
// A run declares how many slots it needs and waits until they are free.
type SlotPool struct {
	mu     sync.Mutex
	total  int
	used   int
	notify chan struct{}
}

func NewSlotPool(total int) *SlotPool {
	if total < 1 {
		total = 1
	}
	return &SlotPool{total: total, notify: make(chan struct{})}
}

func (p *SlotPool) Total() int {
	return p.total
}

func (p *SlotPool) Used() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.used
}

// Acquire reserves n slots, blocking until they are available or ctx is done.
func (p *SlotPool) Acquire(ctx context.Context, n int) error {
	if n < 1 {
		n = 1
	}
	if n > p.total {
		return ErrTooManyWorkers
	}

	for {
		p.mu.Lock()
		if p.used+n <= p.total {
			p.used += n
			p.mu.Unlock()
			return nil
		}
		wait := p.notify
		p.mu.Unlock()

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-wait:
		}
	}
}

// Release returns n slots to the pool.
func (p *SlotPool) Release(n int) {
	if n < 1 {
		n = 1
	}
	p.mu.Lock()
	p.used -= n
	if p.used < 0 {
		p.used = 0
	}
	close(p.notify)
	p.notify = make(chan struct{})
	p.mu.Unlock()
}
