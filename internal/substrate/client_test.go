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
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
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

func (f *fakeAPI) ListActors(_ context.Context, in *ateapi.ListActorsRequest, _ ...grpc.CallOption) (*ateapi.ListActorsResponse, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	start := 0
	if in.GetOptions().GetPageToken() != "" {
		var err error
		if start, err = strconv.Atoi(in.GetOptions().GetPageToken()); err != nil {
			return nil, err
		}
	}
	resp := &ateapi.ListActorsResponse{}
	end := min(start+int(in.GetOptions().GetPageSize()), f.actors)
	for i := start; i < end; i++ {
		resp.Actors = append(resp.Actors, &ateapi.Actor{
			Metadata: &ateapi.ResourceMetadata{Atespace: in.GetAtespace(), Name: fmt.Sprintf("a%03d", i)},
			Status:   &ateapi.ActorStatus{State: ateapi.ActorState_ACTOR_STATE_SUSPENDED},
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

// With authorization enforced (always, from Substrate v1.0) and no grant, the error says
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
	a := ToAgent(&ateapi.Actor{
		Metadata:      &ateapi.ResourceMetadata{Atespace: "cred-test", Name: "mast-triage", Uid: "u1"},
		ActorTemplate: &ateapi.ObjectRef{Atespace: "cred-test", Name: "ax-mast-triage"},
		Status: &ateapi.ActorStatus{
			State: ateapi.ActorState_ACTOR_STATE_RUNNING,
			WorkerAssignment: &ateapi.WorkerAssignment{
				Worker: &ateapi.ObjectRef{Name: "w-1"}, WorkerPod: "atelet-abc", NodeName: "node-1",
				WorkerPodIps: []string{"", "10.0.0.7", "fd00::7"}, WorkerEpoch: 2,
			},
			AssignedNode:           "node-1",
			LastAssignedGeneration: 1,
			Snapshots:              []*ateapi.Snapshot{durable(1, completed, "gs://b/s")},
		},
	})
	if a.State != "RUNNING" || a.Worker != "w-1" || a.WorkerPod != "atelet-abc" || a.Template != "cred-test/ax-mast-triage" || a.SnapshotURI != "gs://b/s" {
		t.Fatalf("ToAgent = %+v", a)
	}
	if a.WorkerIP != "10.0.0.7" || len(a.WorkerIPs) != 2 || a.WorkerIPs[1] != "fd00::7" || a.WorkerEpoch != 2 || a.AssignedNode != "node-1" {
		t.Fatalf("ToAgent worker IPs/epoch/node = %+v", a)
	}
	// A suspended actor whose asynchronous suspend is still uploading: no
	// worker, still attached to the node holding its local snapshot, and
	// v1.0 has no PAUSED state to show for it.
	a = ToAgent(&ateapi.Actor{
		Metadata: &ateapi.ResourceMetadata{Atespace: "x", Name: "p"},
		Status: &ateapi.ActorStatus{
			State: ateapi.ActorState_ACTOR_STATE_SUSPENDED, AssignedNode: "node-2",
			LastAssignedGeneration: 2, Snapshots: []*ateapi.Snapshot{durable(1, completed, "gs://b/old"), uploading(2, "node-2")},
		},
	})
	if a.State != "SUSPENDED" || a.Worker != "" || a.WorkerIP != "" || a.WorkerIPs != nil || a.AssignedNode != "node-2" || !a.SnapshotInProgress || a.SnapshotURI != "gs://b/old" {
		t.Fatalf("ToAgent suspended, uploading = %+v", a)
	}
}

const (
	pending   = ateapi.SnapshotStorageState_SNAPSHOT_STORAGE_STATE_PENDING
	completed = ateapi.SnapshotStorageState_SNAPSHOT_STORAGE_STATE_COMPLETED
)

func durable(gen int32, state ateapi.SnapshotStorageState, uri string) *ateapi.Snapshot {
	return &ateapi.Snapshot{Generation: gen, DurableSnapshot: &ateapi.SnapshotStorage{
		State: state, Object: &ateapi.ObjectSnapshot{SnapshotUri: uri},
	}}
}

// uploading is an asynchronous suspend's snapshot: captured on node, its
// durable copy still PENDING.
func uploading(gen int32, node string) *ateapi.Snapshot {
	s := durable(gen, pending, "gs://b/"+strconv.Itoa(int(gen)))
	s.Locality = node
	return s
}

func local(gen int32, node string) *ateapi.Snapshot {
	return &ateapi.Snapshot{Generation: gen, Locality: node}
}

// TestToAgentSnapshots covers what the actor's snapshot list turns into:
// the snapshot to show and whether one is being taken. The state is
// Substrate's, passed through: v0.5 dropped PAUSING and PAUSED, and v1.0
// removed PauseActor, so nothing is derived any more.
func TestToAgentSnapshots(t *testing.T) {
	const (
		running    = ateapi.ActorState_ACTOR_STATE_RUNNING
		suspending = ateapi.ActorState_ACTOR_STATE_SUSPENDING
		suspended  = ateapi.ActorState_ACTOR_STATE_SUSPENDED
		crashed    = ateapi.ActorState_ACTOR_STATE_CRASHED
		reverting  = ateapi.ActorState_ACTOR_STATE_REVERTING
	)
	for _, tc := range []struct {
		name       string
		state      ateapi.ActorState
		gen        int32
		snaps      []*ateapi.Snapshot
		wantState  string
		wantURI    string
		inProgress bool
	}{
		{"never snapshotted", running, 0, nil, "RUNNING", "", false},
		{"suspending", suspending, 2, []*ateapi.Snapshot{durable(1, completed, "gs://b/1"), durable(2, pending, "gs://b/2")}, "SUSPENDING", "gs://b/1", true},
		{"suspended", suspended, 2, []*ateapi.Snapshot{durable(2, completed, "gs://b/2")}, "SUSPENDED", "gs://b/2", false},
		// v1.0 suspends asynchronously by default: SUSPENDED once the
		// snapshot is on the node, with the upload still going.
		{"suspended, upload running", suspended, 2, []*ateapi.Snapshot{durable(1, completed, "gs://b/1"), uploading(2, "node-1")}, "SUSPENDED", "gs://b/1", true},
		{"suspended, first upload running", suspended, 1, []*ateapi.Snapshot{uploading(1, "node-1")}, "SUSPENDED", "", true},
		// Kept on the node after the upload (atelet holds it until detach).
		{"suspended, kept local", suspended, 1, []*ateapi.Snapshot{{Generation: 1, Locality: "node-1", DurableSnapshot: &ateapi.SnapshotStorage{State: completed, Object: &ateapi.ObjectSnapshot{SnapshotUri: "gs://b/1"}}}}, "SUSPENDED", "gs://b/1", false},
		{"suspending, not captured yet", suspending, 3, []*ateapi.Snapshot{durable(2, completed, "gs://b/2"), {Generation: 3}}, "SUSPENDING", "gs://b/2", true},
		// Resumed: the local snapshot stays, but it is running.
		{"resumed, local kept", running, 1, []*ateapi.Snapshot{local(1, "node-1")}, "RUNNING", "", false},
		{"crashed", crashed, 1, []*ateapi.Snapshot{durable(1, completed, "gs://b/1")}, "CRASHED", "gs://b/1", false},
		{"reverting", reverting, 2, []*ateapi.Snapshot{durable(1, completed, "gs://b/1")}, "REVERTING", "gs://b/1", false},
		// The newest completed copy wins, whatever the list order.
		{"newest completed", suspended, 3, []*ateapi.Snapshot{durable(3, completed, "gs://b/3"), durable(2, completed, "gs://b/2")}, "SUSPENDED", "gs://b/3", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := ToAgent(&ateapi.Actor{
				Metadata: &ateapi.ResourceMetadata{Atespace: "x", Name: "a"},
				Status:   &ateapi.ActorStatus{State: tc.state, LastAssignedGeneration: tc.gen, Snapshots: tc.snaps},
			})
			if a.State != tc.wantState || a.SnapshotURI != tc.wantURI || a.SnapshotInProgress != tc.inProgress {
				t.Fatalf("state %q, snapshot %q, in progress %v; want %q, %q, %v",
					a.State, a.SnapshotURI, a.SnapshotInProgress, tc.wantState, tc.wantURI, tc.inProgress)
			}
		})
	}
}

func TestToWorker(t *testing.T) {
	w := ToWorker(&ateapi.Worker{
		Metadata:        &ateapi.ResourceMetadata{Name: "w-1"},
		WorkerPod:       "atelet-abc",
		WorkerNamespace: "ax-workers",
		WorkerPool:      "ax-pool",
		NodeName:        "node-1",
		Status: &ateapi.WorkerStatus{
			State:           ateapi.WorkerState_WORKER_STATE_ACTIVE,
			Ips:             []string{"", "10.0.0.7"},
			RegisteredEpoch: 3,
			IssuedEpoch:     4,
			ObservedEpoch:   2,
			SandboxClasses:  []*ateapi.WorkerSandboxClass{{SandboxClass: "gvisor"}},
			// A gVisor worker with 500m / 1Gi limits offers 960Mi.
			Capacity:  &ateapi.WorkerResources{Actors: 40, CpuMillicores: 500, MemoryBytes: 960 << 20},
			Allocated: &ateapi.WorkerResources{Actors: 3, CpuMillicores: 250, MemoryBytes: 384<<20 + 1},
		},
	}, []*ateapi.ActorAssignment{{Actor: &ateapi.ObjectRef{Atespace: "a", Name: "b"}}})
	if w.State != "ACTIVE" || w.Node != "node-1" || w.Pool != "ax-pool" || w.Namespace != "ax-workers" || w.CapacityActors != 40 || w.AllocatedActors != 3 {
		t.Fatalf("ToWorker = %+v", w)
	}
	if w.CapacityCPU != "500m" || w.CapacityMemory != "960Mi" || w.AllocatedCPU != "250m" || w.AllocatedMemory != "402653185" {
		t.Fatalf("ToWorker resources = %+v", w)
	}
	if len(w.Actors) != 1 || w.Actors[0] != "a/b" {
		t.Fatalf("ToWorker actors = %v", w.Actors)
	}
	if len(w.IPs) != 1 || w.IPs[0] != "10.0.0.7" || w.Epoch != 3 || w.ObservedEpoch != 2 || w.SandboxClass != "gvisor" {
		t.Fatalf("ToWorker ips/epoch/class = %+v", w)
	}
	// Capacity but nothing allocated: an idle worker shows 0, not unknown.
	w = ToWorker(&ateapi.Worker{Metadata: &ateapi.ResourceMetadata{Name: "w-3"}, Status: &ateapi.WorkerStatus{
		Capacity: &ateapi.WorkerResources{CpuMillicores: 2000, MemoryBytes: 2 << 30},
	}}, nil)
	if w.CapacityCPU != "2" || w.CapacityMemory != "2Gi" || w.AllocatedCPU != "0" || w.AllocatedMemory != "0" {
		t.Fatalf("ToWorker idle = %+v", w)
	}
	// No resources reported: the fields stay empty.
	w = ToWorker(&ateapi.Worker{Metadata: &ateapi.ResourceMetadata{Name: "w-2"}}, nil)
	if w.CapacityCPU != "" || w.AllocatedMemory != "" || w.SandboxClass != "" {
		t.Fatalf("ToWorker without resources = %+v", w)
	}
}

func TestQuantities(t *testing.T) {
	for _, tc := range []struct {
		cpu, mem int64
		wantCPU  string
		wantMem  string
	}{
		{0, 0, "", ""},
		{-1, -1, "", ""},
		{1, 1, "1m", "1"},
		{1000, 1024, "1", "1Ki"},
		{1500, 1536 << 20, "1500m", "1536Mi"},
		{64000, 64 << 30, "64", "64Gi"},
		{999999, 3 << 40, "999999m", "3Ti"},
		{250, 1000, "250m", "1000"},
	} {
		if got := cpuQuantity(tc.cpu); got != tc.wantCPU {
			t.Errorf("cpuQuantity(%d) = %q, want %q", tc.cpu, got, tc.wantCPU)
		}
		if got := memoryQuantity(tc.mem); got != tc.wantMem {
			t.Errorf("memoryQuantity(%d) = %q, want %q", tc.mem, got, tc.wantMem)
		}
	}
}

type wireControl struct {
	ateapi.UnimplementedControlServer
}

func (wireControl) ListAtespaces(context.Context, *ateapi.ListAtespacesRequest) (*ateapi.ListAtespacesResponse, error) {
	return &ateapi.ListAtespacesResponse{Atespaces: []*ateapi.Atespace{{Metadata: &ateapi.ResourceMetadata{Name: "cred-test"}}}}, nil
}

// TestWireMethodPaths dials an in-process gRPC server: v1.0 moved the API to
// proto package substrate.ateapi.v1, so every method path changed (a v0.x
// client gets Unimplemented from a v1.0 server), and the bearer token still
// rides on each call.
func TestWireMethodPaths(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var (
		mu      sync.Mutex
		methods []string
		auth    []string
	)
	srv := grpc.NewServer(grpc.UnaryInterceptor(func(ctx context.Context, req any, info *grpc.UnaryServerInfo, h grpc.UnaryHandler) (any, error) {
		md, _ := metadata.FromIncomingContext(ctx)
		mu.Lock()
		methods = append(methods, info.FullMethod)
		auth = append(auth, strings.Join(md.Get("authorization"), ","))
		mu.Unlock()
		return h(ctx, req)
	}))
	ateapi.RegisterControlServer(srv, wireControl{})
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)

	tok := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tok, []byte("tok-1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Dial(Options{Target: lis.Addr().String(), TokenFile: tok, Plaintext: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	got, err := c.ListAtespaces(context.Background())
	if err != nil || len(got) != 1 || got[0].GetMetadata().GetName() != "cred-test" {
		t.Fatalf("ListAtespaces = %v, %v", got, err)
	}
	// Unimplemented on the fake: only the path matters here.
	_, _ = c.ListWorkers(context.Background())
	_, _ = c.GetActor(context.Background(), "a", "b")
	mu.Lock()
	defer mu.Unlock()
	want := []string{"/substrate.ateapi.v1.Control/ListAtespaces", "/substrate.ateapi.v1.Control/ListWorkers", "/substrate.ateapi.v1.Control/GetActor"}
	if !reflect.DeepEqual(methods, want) {
		t.Fatalf("methods = %v, want %v", methods, want)
	}
	if auth[0] != "Bearer tok-1" {
		t.Fatalf("authorization = %q", auth[0])
	}
}
