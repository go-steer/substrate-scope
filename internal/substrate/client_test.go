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

package substrate

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// fakeAPI serves n actors in pages of the requested size.
type fakeAPI struct {
	readAPI
	actors   int
	calls    int
	badToken bool
	err      error
}

func (f *fakeAPI) ListActors(_ context.Context, in *ateapipb.ListActorsRequest, _ ...grpc.CallOption) (*ateapipb.ListActorsResponse, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	start := 0
	if in.GetPageToken() != "" {
		var err error
		if start, err = strconv.Atoi(in.GetPageToken()); err != nil {
			return nil, err
		}
	}
	resp := &ateapipb.ListActorsResponse{}
	end := min(start+int(in.GetPageSize()), f.actors)
	for i := start; i < end; i++ {
		resp.Actors = append(resp.Actors, &ateapipb.Actor{
			Metadata: &ateapipb.ResourceMetadata{Atespace: in.GetAtespace(), Name: fmt.Sprintf("a%03d", i)},
			Status:   &ateapipb.ActorStatus{State: ateapipb.ActorState_ACTOR_STATE_SUSPENDED},
		})
	}
	if end < f.actors {
		resp.NextPageToken = strconv.Itoa(end)
		if f.badToken {
			resp.NextPageToken = "same"
		}
	}
	return resp, nil
}

func TestListActorsPaginates(t *testing.T) {
	f := &fakeAPI{actors: 1234}
	c := newClient(f)
	c.PageSize = 100
	got, err := c.ListActors(context.Background(), "cred-test")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1234 || f.calls != 13 {
		t.Fatalf("got %d actors in %d calls, want 1234 in 13", len(got), f.calls)
	}
	if got[1233].GetMetadata().GetName() != "a1233" {
		t.Fatalf("last actor = %s", got[1233].GetMetadata().GetName())
	}
}

// With Substrate v0.4 authorization enforced and no grant, the error says
// what to grant and keeps its gRPC code.
func TestPermissionDeniedExplained(t *testing.T) {
	denied := status.Error(codes.PermissionDenied, `permission denied: principal "user:system%3Aserviceaccount%3Asubstrate-scope%3Asubstrate-scope" lacks "can_list_actors" on "atespace:x"`)
	c := newClient(&fakeAPI{err: denied})
	_, err := c.ListActors(context.Background(), "x")
	if status.Code(err) != codes.PermissionDenied || !strings.Contains(err.Error(), "global viewer") {
		t.Fatalf("err = %v", err)
	}
	other := status.Error(codes.Unavailable, "down")
	_, err = newClient(&fakeAPI{err: other}).ListActors(context.Background(), "x")
	if strings.Contains(err.Error(), "viewer") {
		t.Fatalf("non-authz error got the hint: %v", err)
	}
}

func TestListActorsStopsOnRepeatedToken(t *testing.T) {
	f := &fakeAPI{actors: 1000, badToken: true}
	c := newClient(f)
	c.PageSize = 10
	if _, err := c.ListActors(context.Background(), "x"); err == nil {
		t.Fatal("expected an error for a repeated page token")
	}
}

func TestToAgent(t *testing.T) {
	a := ToAgent(&ateapipb.Actor{
		Metadata:      &ateapipb.ResourceMetadata{Atespace: "cred-test", Name: "mast-triage", Uid: "u1"},
		ActorTemplate: &ateapipb.ObjectRef{Atespace: "cred-test", Name: "ax-mast-triage"},
		Status: &ateapipb.ActorStatus{
			State: ateapipb.ActorState_ACTOR_STATE_RUNNING,
			WorkerAssignment: &ateapipb.WorkerAssignment{
				Worker: &ateapipb.ObjectRef{Name: "w-1"}, WorkerPod: "atelet-abc", NodeName: "node-1",
				WorkerPodIps: []string{"", "10.0.0.7", "fd00::7"}, WorkerEpoch: 2,
			},
			AssignedNode:     "node-1",
			ExternalSnapshot: &ateapipb.ExternalSnapshot{SnapshotUri: "gs://b/s"},
		},
	})
	if a.State != "RUNNING" || a.Worker != "w-1" || a.WorkerPod != "atelet-abc" || a.Template != "cred-test/ax-mast-triage" || a.SnapshotURI != "gs://b/s" {
		t.Fatalf("ToAgent = %+v", a)
	}
	if a.WorkerIP != "10.0.0.7" || len(a.WorkerIPs) != 2 || a.WorkerIPs[1] != "fd00::7" || a.WorkerEpoch != 2 || a.AssignedNode != "node-1" {
		t.Fatalf("ToAgent worker IPs/epoch/node = %+v", a)
	}
	// PAUSED: no worker, but still attached to the node holding its local
	// snapshot.
	a = ToAgent(&ateapipb.Actor{
		Metadata: &ateapipb.ResourceMetadata{Atespace: "x", Name: "p"},
		Status:   &ateapipb.ActorStatus{State: ateapipb.ActorState_ACTOR_STATE_PAUSED, AssignedNode: "node-2"},
	})
	if a.State != "PAUSED" || a.Worker != "" || a.WorkerIP != "" || a.WorkerIPs != nil || a.AssignedNode != "node-2" {
		t.Fatalf("ToAgent paused = %+v", a)
	}
}

func TestToWorker(t *testing.T) {
	res := func(cpu, mem string) *ateapipb.Resources {
		return &ateapipb.Resources{Limits: []*ateapipb.Limits{{Name: "cpu", Quantity: cpu}, {Name: "memory", Quantity: mem}}}
	}
	w := ToWorker(&ateapipb.Worker{
		Metadata:  &ateapipb.ResourceMetadata{Name: "w-1"},
		WorkerPod: "atelet-abc",
		NodeName:  "node-1",
		Ips:       []string{"10.0.0.7"},
		Epoch:     3,
		Status: &ateapipb.WorkerStatus{
			State:         ateapipb.WorkerState_WORKER_STATE_ACTIVE,
			ObservedEpoch: 2,
			Capacity:      &ateapipb.WorkerResources{Actors: 40, Resources: res("16", "64Gi")},
			Allocated:     &ateapipb.WorkerResources{Actors: 3, Resources: res("750m", "3Gi")},
		},
	}, []*ateapipb.ActorAssignment{{Actor: &ateapipb.ObjectRef{Atespace: "a", Name: "b"}}})
	if w.State != "ACTIVE" || w.Node != "node-1" || w.CapacityActors != 40 || w.AllocatedActors != 3 {
		t.Fatalf("ToWorker = %+v", w)
	}
	if w.CapacityCPU != "16" || w.CapacityMemory != "64Gi" || w.AllocatedCPU != "750m" || w.AllocatedMemory != "3Gi" {
		t.Fatalf("ToWorker resources = %+v", w)
	}
	if len(w.Actors) != 1 || w.Actors[0] != "a/b" {
		t.Fatalf("ToWorker actors = %v", w.Actors)
	}
	if len(w.IPs) != 1 || w.IPs[0] != "10.0.0.7" || w.Epoch != 3 || w.ObservedEpoch != 2 {
		t.Fatalf("ToWorker ips/epoch = %+v", w)
	}
	// No resources reported: the fields stay empty.
	w = ToWorker(&ateapipb.Worker{Metadata: &ateapipb.ResourceMetadata{Name: "w-2"}}, nil)
	if w.CapacityCPU != "" || w.AllocatedMemory != "" {
		t.Fatalf("ToWorker without resources = %+v", w)
	}
}
