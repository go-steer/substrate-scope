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

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"github.com/go-steer/substrate-scope/internal/collector"
	"github.com/go-steer/substrate-scope/internal/model"
	"github.com/go-steer/substrate-scope/internal/router"
)

type fakeActors struct {
	mu     sync.Mutex
	states map[string]string
	calls  int
}

func (f *fakeActors) ActorState(_ context.Context, as, name string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.states[model.Key(as, name)], nil
}

// fakeRouter records what reached it, like the atenet router would deliver
// (and wake) actors.
type fakeRouter struct {
	mu       sync.Mutex
	requests []*http.Request
}

func (f *fakeRouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.requests = append(f.requests, r.Clone(context.Background()))
	f.mu.Unlock()
	switch r.URL.Path {
	case router.StatusPath:
		_, _ = w.Write([]byte(`{"idleSeconds":42,"inFlight":0,"busy":false,"exited":false,"exitCode":0}`))
	case "/sessions":
		_, _ = w.Write([]byte(`{"sessions":[{"sessionID":"s1"}]}`))
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeRouter) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

type rig struct {
	store  *collector.Store
	actors *fakeActors
	router *fakeRouter
	srv    *httptest.Server
}

func newRig(t *testing.T) *rig {
	t.Helper()
	store := collector.NewStore(collector.Options{Cluster: "test", Source: "test"})
	store.Update(collector.Update{Actors: map[string][]model.Agent{"cred-test": {
		{Atespace: "cred-test", Name: "run", State: model.StateRunning},
		{Atespace: "cred-test", Name: "sleep", State: model.StateSuspended},
	}}, Tasks: map[string]map[string]model.Task{"cred-test": {"run": {Phase: "Running"}, "sleep": {Phase: "Suspended"}}}})
	fr := &fakeRouter{}
	rs := httptest.NewServer(fr)
	t.Cleanup(rs.Close)
	fa := &fakeActors{states: map[string]string{"cred-test/run": model.StateRunning, "cred-test/sleep": model.StateSuspended}}
	rc := &router.Client{Addr: rs.URL}
	s := New(Options{
		Store:       store,
		Web:         fstest.MapFS{"index.html": {Data: []byte("<!doctype html>scope")}},
		Actors:      fa,
		Runner:      rc,
		Attach:      rc,
		AttachToken: router.StaticToken("agent-token"),
	})
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return &rig{store: store, actors: fa, router: fr, srv: srv}
}

func getJSON(t *testing.T, url string, v any) int {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if v != nil {
		if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode
}

func TestSnapshotAndUI(t *testing.T) {
	r := newRig(t)
	var snap model.Snapshot
	if code := getJSON(t, r.srv.URL+"/api/snapshot", &snap); code != 200 || len(snap.Agents) != 2 || snap.Seq == 0 {
		t.Fatalf("snapshot %d %+v", code, snap)
	}
	resp, err := http.Get(r.srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(b), "scope") {
		t.Fatalf("UI not served: %q", b)
	}
}

func TestAgentDetailRunnerOnlyWhenRunning(t *testing.T) {
	r := newRig(t)
	var d AgentDetail
	if code := getJSON(t, r.srv.URL+"/api/agents/cred-test/run", &d); code != 200 {
		t.Fatalf("code %d", code)
	}
	if d.Runner == nil || d.Runner.IdleSeconds != 42 || !d.Attach {
		t.Fatalf("running agent detail = %+v", d)
	}
	before := r.router.count()
	d = AgentDetail{}
	if code := getJSON(t, r.srv.URL+"/api/agents/cred-test/sleep", &d); code != 200 {
		t.Fatalf("code %d", code)
	}
	if d.Runner != nil || d.RunnerNote == "" {
		t.Fatalf("suspended agent detail = %+v", d)
	}
	if r.router.count() != before {
		t.Fatal("the server contacted a suspended agent through the router")
	}
	if code := getJSON(t, r.srv.URL+"/api/agents/cred-test/nope", nil); code != 404 {
		t.Fatalf("missing agent code %d", code)
	}
}

func TestAgentDetailConfirmsRunningBeforeRouter(t *testing.T) {
	r := newRig(t)
	// The store still says RUNNING, but Substrate says it just suspended.
	r.actors.mu.Lock()
	r.actors.states["cred-test/run"] = model.StateSuspending
	r.actors.mu.Unlock()
	var d AgentDetail
	getJSON(t, r.srv.URL+"/api/agents/cred-test/run", &d)
	if d.Runner != nil || r.router.count() != 0 {
		t.Fatalf("runner read despite the actor suspending: %+v, %d router requests", d, r.router.count())
	}
}

func TestAttachRefusesToWakeWithoutConsent(t *testing.T) {
	r := newRig(t)
	var body map[string]any
	if code := getJSON(t, r.srv.URL+"/api/agents/cred-test/sleep/attach/sessions", &body); code != http.StatusConflict {
		t.Fatalf("code %d, want 409", code)
	}
	if body["wakes"] != true || r.router.count() != 0 {
		t.Fatalf("body %+v, router requests %d", body, r.router.count())
	}
	if code := getJSON(t, r.srv.URL+"/api/agents/cred-test/sleep/attach/sessions?scope_wake=1", &body); code != 200 {
		t.Fatalf("with consent: code %d", code)
	}
	if r.router.count() != 1 {
		t.Fatalf("router requests %d", r.router.count())
	}
}

func TestAttachProxiesWithRoutingHeaderAndToken(t *testing.T) {
	r := newRig(t)
	req, _ := http.NewRequest("GET", r.srv.URL+"/api/agents/cred-test/run/attach/sessions?x=1", nil)
	req.Header.Set("Authorization", "Bearer browser-secret")
	req.Header.Set("Cookie", "c=1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(b), "s1") {
		t.Fatalf("proxy response %d %s", resp.StatusCode, b)
	}
	got := r.router.requests[0]
	if got.URL.Path != "/sessions" || got.URL.Query().Get("x") != "1" {
		t.Fatalf("forwarded URL %s", got.URL)
	}
	if got.Header.Get(router.TargetHeader) != "cred-test/run" || got.Header.Get("Authorization") != "Bearer agent-token" || got.Header.Get("Cookie") != "" {
		t.Fatalf("forwarded headers %v", got.Header)
	}
}

func TestAttachDisabled(t *testing.T) {
	store := collector.NewStore(collector.Options{})
	srv := httptest.NewServer(New(Options{Store: store}))
	defer srv.Close()
	if code := getJSON(t, srv.URL+"/api/agents/a/b/attach/sessions", nil); code != 404 {
		t.Fatalf("code %d", code)
	}
}

func readMsg(t *testing.T, ctx context.Context, c *websocket.Conn) StreamMessage {
	t.Helper()
	_, b, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var m StreamMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestStreamSnapshotThenEvents(t *testing.T) {
	r := newRig(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(r.srv.URL, "http")+"/api/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	m := readMsg(t, ctx, c)
	if m.Type != "snapshot" || m.Snapshot == nil || len(m.Snapshot.Agents) != 2 {
		t.Fatalf("first message = %+v", m)
	}
	r.store.Update(collector.Update{Actors: map[string][]model.Agent{"cred-test": {
		{Atespace: "cred-test", Name: "run", State: model.StateRunning},
		{Atespace: "cred-test", Name: "sleep", State: model.StateResuming},
		{Atespace: "cred-test", Name: "lookout-1", State: model.StateRunning},
	}}})
	snapSeq := m.Snapshot.Seq
	m = readMsg(t, ctx, c)
	if m.Type != "events" || m.Events[0].Seq != snapSeq+1 {
		t.Fatalf("events message = %+v (snapshot seq %d)", m, snapSeq)
	}
	got := map[string]bool{}
	for _, e := range m.Events {
		got[e.Type] = true
	}
	if !got[model.EventAgentAdded] || !got[model.EventAgentWoke] || !got[model.EventAgentState] {
		t.Fatalf("event types = %v", got)
	}
}

func TestStreamResyncsLaggingClient(t *testing.T) {
	store := collector.NewStore(collector.Options{SubscriberBuffer: 1})
	srv := httptest.NewServer(New(Options{Store: store}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	c.SetReadLimit(-1)
	readMsg(t, ctx, c)
	// Flood without reading: big batches fill the socket buffers, the
	// server's writes block and the subscription overflows.
	states := []string{model.StateRunning, model.StateSuspending, model.StateSuspended, model.StateResuming}
	for i := 0; i < 60; i++ {
		list := make([]model.Agent, 2000)
		for j := range list {
			list[j] = model.Agent{Atespace: "a", Name: fmt.Sprintf("agent-%04d", j), State: states[i%4]}
		}
		store.Update(collector.Update{Actors: map[string][]model.Agent{"a": list}})
	}
	for {
		m := readMsg(t, ctx, c)
		if m.Type == "snapshot" {
			if !m.Resync {
				t.Fatal("second snapshot not marked resync")
			}
			return
		}
	}
}

// Behind a proxy that rewrites Host (Cloud Workstations, IAP), the browser's
// Origin no longer matches, so the stream must accept the configured patterns
// and still refuse everything else.
func TestStreamAllowedOrigins(t *testing.T) {
	store := collector.NewStore(collector.Options{Cluster: "test", Source: "test"})
	srv := httptest.NewServer(New(Options{Store: store, AllowedOrigins: []string{"*.cloudworkstations.dev"}}))
	t.Cleanup(srv.Close)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/stream"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	for origin, wantOK := range map[string]bool{
		"https://8080-basic-default2.cluster-abc.cloudworkstations.dev": true,
		"https://evil.example.com":                                      false,
	} {
		c, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}}})
		if wantOK {
			if err != nil {
				t.Errorf("origin %s refused: %v", origin, err)
				continue
			}
			c.CloseNow()
			continue
		}
		if err == nil {
			c.CloseNow()
			t.Errorf("origin %s accepted, want refused", origin)
		} else if resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Errorf("origin %s: err %v, want 403", origin, err)
		}
	}
}
