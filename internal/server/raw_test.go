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
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"

	"github.com/go-steer/substrate-scope/internal/axapi"
	"github.com/go-steer/substrate-scope/internal/collector"
	"github.com/go-steer/substrate-scope/internal/model"
)

type fakeRaw struct{ gets []string }

func (f *fakeRaw) GetActor(_ context.Context, as, name string) (*ateapi.Actor, error) {
	f.gets = append(f.gets, "actor "+as+"/"+name)
	return &ateapi.Actor{Metadata: &ateapi.ResourceMetadata{Atespace: as, Name: name}}, nil
}

func (f *fakeRaw) GetTask(_ context.Context, as, name string) (*axapi.Task, error) {
	f.gets = append(f.gets, "task "+as+"/"+name)
	return &axapi.Task{
		Metadata: &axapi.ObjectMeta{Atespace: as, Name: name},
		Spec:     &axapi.TaskSpec{Image: "runner:1", Env: []*axapi.EnvVar{{Name: "GEMINI_API_KEY", Value: "sk-live-123"}}},
	}, nil
}

func (f *fakeRaw) GetWorkspace(_ context.Context, as, name string) (*axapi.Workspace, error) {
	f.gets = append(f.gets, "workspace "+as+"/"+name)
	if name == "gone" {
		return nil, errors.New("not found")
	}
	return &axapi.Workspace{Metadata: &axapi.ObjectMeta{Atespace: as, Name: name}}, nil
}

func TestRawObjects(t *testing.T) {
	store := collector.NewStore(collector.Options{Cluster: "test", Source: "test"})
	store.Update(collector.Update{
		Actors: map[string][]model.Agent{"cred-test": {
			{Atespace: "cred-test", Name: "run-actor", State: model.StateSuspended},
			{Atespace: "cred-test", Name: "plain", State: model.StateRunning},
		}},
		Tasks: map[string]map[string]model.Task{"cred-test": {"run-actor": {Name: "run", Phase: "Suspended", Workspaces: []string{"repo", "gone"}}}},
	})
	f := &fakeRaw{}
	srv := httptest.NewServer(New(Options{Store: store, RawActors: f, RawTasks: f}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/agents/cred-test/run-actor/raw")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var d RawDetail
	if err := json.Unmarshal(body, &d); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "sk-live-123") {
		t.Errorf("env value leaked: %s", body)
	}
	var got []string
	for _, o := range d.Objects {
		got = append(got, o.Section+" "+o.Kind+" "+o.Name+" "+o.Error)
	}
	want := []string{"substrate Actor run-actor ", "task Task run ", "task Workspace repo ", "task Workspace gone not found"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("objects:\n got %q\nwant %q", got, want)
	}
	// The task is read by its own name, not the actor's.
	if f.gets[1] != "task cred-test/run" {
		t.Errorf("reads: %q", f.gets)
	}

	// Not an ax task: only the actor.
	f.gets = nil
	if code := getJSON(t, srv.URL+"/api/agents/cred-test/plain/raw", &d); code != http.StatusOK || len(d.Objects) != 1 || d.Objects[0].Kind != "Actor" {
		t.Errorf("plain: %d %+v", code, d)
	}
	if code := getJSON(t, srv.URL+"/api/agents/cred-test/nope/raw", nil); code != http.StatusNotFound {
		t.Errorf("unknown agent: %d", code)
	}
}
