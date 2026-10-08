// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Package server serves the collector's HTTP API and the embedded front end.
//
//	GET /api/snapshot                          the whole picture
//	GET /api/stream                            WebSocket: snapshot, then event batches
//	GET /api/agents/{atespace}/{name}          side panel details (+ runner status if running)
//	ANY /api/agents/{atespace}/{name}/attach/… optional proxy to the agent's session API
//	GET /healthz
package server

import (
	"context"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/go-steer/substrate-scope/internal/collector"
	"github.com/go-steer/substrate-scope/internal/model"
	"github.com/go-steer/substrate-scope/internal/router"
)

// ActorStateGetter confirms an actor's current state with Substrate (a read
// that never wakes the actor) right before the server sends anything to it
// through the router.
type ActorStateGetter interface {
	ActorState(ctx context.Context, atespace, name string) (string, error)
}

// RunnerStatusReader reads an ax runner's status through the router.
type RunnerStatusReader interface {
	RunnerStatus(ctx context.Context, atespace, name string) (*router.RunnerStatus, error)
}

// Options configures the server.
type Options struct {
	Store *collector.Store
	// Web is the front end; nil serves no UI.
	Web fs.FS
	// Actors confirms state before router calls. Required for RunnerStatus
	// and Attach.
	Actors ActorStateGetter
	// Runner, when set, reads runner status for running agents on demand.
	Runner RunnerStatusReader
	// Attach, when set, is the attach reverse proxy.
	Attach *router.Client
	// AttachToken supplies the agent bearer token for Attach.
	AttachToken router.TokenSource
	// RunnerCacheTTL caches runner status per agent, default 2s.
	RunnerCacheTTL time.Duration
	// PingInterval keeps WebSockets alive, default 20s.
	PingInterval time.Duration
}

// Server is the HTTP handler.
type Server struct {
	o   Options
	mux *http.ServeMux

	mu    sync.Mutex
	cache map[string]runnerEntry
}

type runnerEntry struct {
	at  time.Time
	st  *router.RunnerStatus
	err string
}

// New builds the handler.
func New(o Options) *Server {
	if o.RunnerCacheTTL <= 0 {
		o.RunnerCacheTTL = 2 * time.Second
	}
	if o.PingInterval <= 0 {
		o.PingInterval = 20 * time.Second
	}
	s := &Server{o: o, mux: http.NewServeMux(), cache: map[string]runnerEntry{}}
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	s.mux.HandleFunc("GET /api/snapshot", s.snapshot)
	s.mux.HandleFunc("GET /api/stream", s.stream)
	s.mux.HandleFunc("GET /api/agents/{atespace}/{name}", s.agent)
	s.mux.HandleFunc("/api/agents/{atespace}/{name}/attach/{rest...}", s.attach)
	if o.Web != nil {
		s.mux.Handle("/", http.FileServerFS(o.Web))
	}
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) snapshot(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.o.Store.Snapshot())
}

// StreamMessage is one WebSocket message.
type StreamMessage struct {
	// Type is "snapshot" or "events".
	Type     string          `json:"type"`
	Snapshot *model.Snapshot `json:"snapshot,omitempty"`
	Events   []model.Event   `json:"events,omitempty"`
	// Resync is set on a snapshot sent because the client fell behind.
	Resync bool `json:"resync,omitempty"`
}

func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer c.CloseNow()
	ctx := c.CloseRead(r.Context())

	send := func(m StreamMessage) error {
		b, err := json.Marshal(m)
		if err != nil {
			return err
		}
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return c.Write(wctx, websocket.MessageText, b)
	}

	ping := time.NewTicker(s.o.PingInterval)
	defer ping.Stop()
	resync := false
	for {
		snap, sub := s.o.Store.Subscribe()
		if err := send(StreamMessage{Type: "snapshot", Snapshot: &snap, Resync: resync}); err != nil {
			sub.Cancel()
			return
		}
	events:
		for {
			select {
			case <-ctx.Done():
				sub.Cancel()
				c.Close(websocket.StatusNormalClosure, "")
				return
			case <-ping.C:
				pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
				err := c.Ping(pctx)
				cancel()
				if err != nil {
					sub.Cancel()
					return
				}
			case evs, ok := <-sub.C:
				if !ok {
					if sub.Lagged() {
						slog.Info("stream client fell behind; resyncing", "remote", r.RemoteAddr)
						resync = true
						break events
					}
					return
				}
				if err := send(StreamMessage{Type: "events", Events: evs}); err != nil {
					sub.Cancel()
					return
				}
			}
		}
	}
}

// AgentDetail is the side panel's data.
type AgentDetail struct {
	Agent model.Agent `json:"agent"`
	// Runner is the ax runner's status, read only when the agent is running.
	Runner *router.RunnerStatus `json:"runner,omitempty"`
	// RunnerNote says why Runner is missing.
	RunnerNote string `json:"runnerNote,omitempty"`
	// RunnerTime is when Runner was read.
	RunnerTime *time.Time    `json:"runnerTime,omitempty"`
	Worker     *model.Worker `json:"worker,omitempty"`
	Attach     bool          `json:"attach"`
}

func (s *Server) agent(w http.ResponseWriter, r *http.Request) {
	as, name := r.PathValue("atespace"), r.PathValue("name")
	a, ok := s.o.Store.Agent(as, name)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such agent"})
		return
	}
	d := AgentDetail{Agent: a, Attach: s.o.Attach != nil}
	if a.Worker != "" {
		for _, wk := range s.o.Store.Snapshot().Workers {
			if wk.Name == a.Worker {
				wk := wk
				d.Worker = &wk
				break
			}
		}
	}
	switch {
	case s.o.Runner == nil || s.o.Actors == nil:
		d.RunnerNote = "runner status is not configured"
	case a.Task == nil:
		d.RunnerNote = "not an ax task"
	case a.State != model.StateRunning:
		d.RunnerNote = "not running; the collector never contacts a suspended agent"
	default:
		st, at, note := s.runnerStatus(r.Context(), as, name)
		d.Runner, d.RunnerNote = st, note
		if st != nil {
			d.RunnerTime = &at
		}
	}
	writeJSON(w, http.StatusOK, d)
}

// runnerStatus reads (or returns the cached) runner status, after confirming
// with Substrate that the actor is still running: the store's view can be a
// poll interval old, and the router would resume an actor that suspended in
// the meantime.
func (s *Server) runnerStatus(ctx context.Context, as, name string) (*router.RunnerStatus, time.Time, string) {
	key := model.Key(as, name)
	s.mu.Lock()
	e, ok := s.cache[key]
	s.mu.Unlock()
	if ok && time.Since(e.at) < s.o.RunnerCacheTTL {
		return e.st, e.at, e.err
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	e = runnerEntry{at: time.Now()}
	state, err := s.o.Actors.ActorState(ctx, as, name)
	switch {
	case err != nil:
		e.err = "could not confirm the actor is running: " + err.Error()
	case state != model.StateRunning:
		e.err = "actor is " + state + "; not contacting it"
	default:
		st, err := s.o.Runner.RunnerStatus(ctx, as, name)
		if err != nil {
			e.err = err.Error()
		} else {
			e.st = st
		}
	}
	s.mu.Lock()
	s.cache[key] = e
	if len(s.cache) > 4096 {
		for k, v := range s.cache {
			if time.Since(v.at) > s.o.RunnerCacheTTL {
				delete(s.cache, k)
			}
		}
	}
	s.mu.Unlock()
	return e.st, e.at, e.err
}

// WakeParam and WakeHeader confirm that a request through the attach proxy
// may wake a suspended agent. Without one, the proxy refuses unless Substrate
// says the agent is running.
const (
	WakeParam  = "scope_wake"
	WakeHeader = "X-Scope-Wake"
)

func (s *Server) attach(w http.ResponseWriter, r *http.Request) {
	if s.o.Attach == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "the attach proxy is not configured"})
		return
	}
	as, name, rest := r.PathValue("atespace"), r.PathValue("name"), r.PathValue("rest")
	a, ok := s.o.Store.Agent(as, name)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such agent"})
		return
	}
	wake := r.URL.Query().Get(WakeParam) == "1" || r.Header.Get(WakeHeader) == "1"
	if !wake {
		state := a.State
		if state == model.StateRunning && s.o.Actors != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			st, err := s.o.Actors.ActorState(ctx, as, name)
			cancel()
			if err != nil {
				writeJSON(w, http.StatusBadGateway, map[string]string{"error": "could not confirm the agent is running: " + err.Error()})
				return
			}
			state = st
		}
		if state != model.StateRunning {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": "agent is " + state + "; a request through the router wakes it. Repeat with " + WakeParam + "=1 to wake it.",
				"state": state,
				"wakes": true,
			})
			return
		}
	}
	if strings.Contains(rest, "..") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad path"})
		return
	}
	s.o.Attach.AttachProxy(s.o.AttachToken, func(*http.Request) (string, string) {
		return model.Key(as, name), "/" + rest
	}).ServeHTTP(w, r)
}
