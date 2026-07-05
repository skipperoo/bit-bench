package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
)

// ProgressHub manages SSE connections for real-time progress updates.
type ProgressHub struct {
	mu          sync.RWMutex
	subscribers map[string]map[chan []byte]struct{} // benchmarkID → set of channels
}

var GlobalProgressHub = &ProgressHub{
	subscribers: make(map[string]map[chan []byte]struct{}),
}

// Subscribe creates a channel for a benchmark and returns it.
func (h *ProgressHub) Subscribe(benchmarkID string) chan []byte {
	h.mu.Lock()
	defer h.mu.Unlock()

	ch := make(chan []byte, 8)
	if h.subscribers[benchmarkID] == nil {
		h.subscribers[benchmarkID] = make(map[chan []byte]struct{})
	}
	h.subscribers[benchmarkID][ch] = struct{}{}
	return ch
}

// Unsubscribe removes a channel for a benchmark.
func (h *ProgressHub) Unsubscribe(benchmarkID string, ch chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if subs, ok := h.subscribers[benchmarkID]; ok {
		delete(subs, ch)
		close(ch)
		if len(subs) == 0 {
			delete(h.subscribers, benchmarkID)
		}
	}
}

// Broadcast sends a progress update to all subscribers of a benchmark.
func (h *ProgressHub) Broadcast(benchmarkID string, progress int) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	msg, _ := json.Marshal(map[string]interface{}{
		"benchmark_id": benchmarkID,
		"progress":     progress,
	})

	if subs, ok := h.subscribers[benchmarkID]; ok {
		for ch := range subs {
			select {
			case ch <- msg:
			default:
				// drop if buffer full
			}
		}
	}
}

// SSEProgressHandler serves SSE events for a benchmark's progress.
func SSEProgressHandler(w http.ResponseWriter, r *http.Request) {
	benchmarkID := r.PathValue("id")
	if benchmarkID == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	rc := http.NewResponseController(w)

	// Send initial event to confirm connection
	fmt.Fprintf(w, "data: {\"type\":\"connected\"}\n\n")
	rc.Flush()

	ch := GlobalProgressHub.Subscribe(benchmarkID)
	defer GlobalProgressHub.Unsubscribe(benchmarkID, ch)

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", msg)
			rc.Flush()
		}
	}
}
