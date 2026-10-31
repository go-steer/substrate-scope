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

package cluster

import (
	"context"
	"errors"
	"sync"
	"testing"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"

	"github.com/go-steer/substrate-scope/internal/collector"
	"github.com/go-steer/substrate-scope/internal/model"
)

type fakeSubstrate struct {
	mu     sync.Mutex
	states map[string]map[string]ateapi.ActorState
	fail   string
}

func (f *fakeSubstrate) ListAtespaces(context.Context) ([]*ateapi.Atespace, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*ateapi.Atespace
	for as := range f.states {
		out = append(out, &ateapi.Atespace{Metadata: &ateapi.ResourceMetadata{Name: as}})
	}
	return out, nil
}

func (f *fakeSubstrate) ListActors(_ context.Context, as string) ([]*ateapi.Actor, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if as == f.fail {
		return nil, errors.New("unavailable")
	}
	var out []*ateapi.Actor
	for name, st := range f.states[as] {
		out = append(out, &ateapi.Actor{
			Metadata: &ateapi.ResourceMetadata{Atespace: as, Name: name},
			Status:   &ateapi.ActorStatus{State: st},
		})
	}
	return out, nil
}

func (f *fakeSubstrate) ListWorkers(context.Context) ([]*ateapi.Worker, error) {
	return []*ateapi.Worker{{Metadata: &ateapi.ResourceMetadata{Name: "w1"}, WorkerPod: "atelet-1"}}, nil
}

func (f *fakeSubstrate) ListWorkerActorAssignments(_ context.Context, w string) ([]*ateapi.ActorAssignment, error) {
	return []*ateapi.ActorAssignment{{Actor: &ateapi.ObjectRef{Atespace: "a", Name: "x"}}}, nil
}

type fakeAX struct{ seen []string }

func (f *fakeAX) ListTasks(_ context.Context, as string) (map[string]model.Task, error) {
	f.seen = append(f.seen, as)
	return map[string]model.Task{"x": {Phase: "Running"}}, nil
}

func TestPollActorsAndKick(t *testing.T) {
	f := &fakeSubstrate{states: map[string]map[string]ateapi.ActorState{
		"a": {"x": ateapi.ActorState_ACTOR_STATE_RUNNING},
		"b": {"y": ateapi.ActorState_ACTOR_STATE_SUSPENDED},
	}}
	s := New(Options{Substrate: f, AX: &fakeAX{}})
	u := s.PollActors(context.Background())
	if u.Err != nil || len(u.Atespaces) != 2 || len(u.Actors["a"]) != 1 || u.Actors["b"][0].State != model.StateSuspended {
		t.Fatalf("update = %+v", u)
	}
	select {
	case <-s.kick:
	default:
		t.Fatal("the first poll should kick the task poller (it waits for atespaces)")
	}
	s.PollActors(context.Background())
	select {
	case <-s.kick:
		t.Fatal("an unchanged poll should not kick the task poller")
	default:
	}
	f.mu.Lock()
	f.states["a"]["x"] = ateapi.ActorState_ACTOR_STATE_SUSPENDING
	f.mu.Unlock()
	s.PollActors(context.Background())
	select {
	case <-s.kick:
	default:
		t.Fatal("a state change should kick the task poller")
	}
}

func TestPollActorsFailsWhole(t *testing.T) {
	f := &fakeSubstrate{states: map[string]map[string]ateapi.ActorState{"a": {}, "b": {}}, fail: "b"}
	u := New(Options{Substrate: f}).PollActors(context.Background())
	if u.Err == nil || u.Actors != nil {
		t.Fatalf("expected a failed update, got %+v", u)
	}
}

func TestPollWorkersAndTasks(t *testing.T) {
	f := &fakeSubstrate{states: map[string]map[string]ateapi.ActorState{"a": {"x": ateapi.ActorState_ACTOR_STATE_RUNNING}}}
	ax := &fakeAX{}
	s := New(Options{Substrate: f, AX: ax})
	w := s.PollWorkers(context.Background())
	if w.Err != nil || len(w.Workers) != 1 || w.Workers[0].Actors[0] != "a/x" {
		t.Fatalf("workers update = %+v", w)
	}
	s.PollActors(context.Background())
	tu := s.PollTasks(context.Background())
	if tu.Err != nil || tu.Tasks["a"]["x"].Phase != "Running" || len(ax.seen) != 1 {
		t.Fatalf("tasks update = %+v", tu)
	}

	store := collector.NewStore(collector.Options{})
	store.Apply(s.PollActors(context.Background()))
	store.Apply(w)
	store.Apply(tu)
	snap := store.Snapshot()
	if len(snap.Agents) != 1 || snap.Agents[0].Task == nil || len(snap.Workers) != 1 {
		t.Fatalf("snapshot = %+v", snap)
	}
}
