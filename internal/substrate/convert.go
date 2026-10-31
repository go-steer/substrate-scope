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
	"strconv"
	"strings"
	"time"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/go-steer/substrate-scope/internal/model"
)

func ts(t *timestamppb.Timestamp) *time.Time {
	if t == nil || !t.IsValid() {
		return nil
	}
	v := t.AsTime()
	return &v
}

// ActorState converts a Substrate state to the model's name for it.
func ActorState(s ateapi.ActorState) string {
	return strings.TrimPrefix(s.String(), "ACTOR_STATE_")
}

// latestSnapshot returns the snapshot at the actor's last assigned
// generation, nil if it has none.
func latestSnapshot(st *ateapi.ActorStatus) *ateapi.Snapshot {
	for _, s := range st.GetSnapshots() {
		if s.GetGeneration() == st.GetLastAssignedGeneration() {
			return s
		}
	}
	return nil
}

// latestCompletedDurable returns the highest-generation snapshot with a
// completed durable copy (the one a suspended actor resumes from), nil if
// there is none.
func latestCompletedDurable(st *ateapi.ActorStatus) *ateapi.Snapshot {
	var out *ateapi.Snapshot
	for _, s := range st.GetSnapshots() {
		if s.GetDurableSnapshot().GetState() == ateapi.SnapshotStorageState_SNAPSHOT_STORAGE_STATE_COMPLETED &&
			(out == nil || s.GetGeneration() >= out.GetGeneration()) {
			out = s
		}
	}
	return out
}

// snapshotInProgress reports whether the actor's latest snapshot is still
// being taken: its durable copy is pending (in v1.0 that includes the upload
// an asynchronous suspend leaves running after the actor is SUSPENDED), or it
// has neither a locality nor a durable copy yet.
func snapshotInProgress(st *ateapi.ActorStatus) bool {
	latest := latestSnapshot(st)
	if latest == nil {
		return false
	}
	if d := latest.GetDurableSnapshot(); d != nil {
		return d.GetState() == ateapi.SnapshotStorageState_SNAPSHOT_STORAGE_STATE_PENDING
	}
	return latest.GetLocality() == ""
}

// ToAgent converts a Substrate actor.
func ToAgent(a *ateapi.Actor) model.Agent {
	md := a.GetMetadata()
	st := a.GetStatus()
	out := model.Agent{
		Atespace:           md.GetAtespace(),
		Name:               md.GetName(),
		UID:                md.GetUid(),
		Version:            md.GetVersion(),
		CreateTime:         ts(md.GetCreateTime()),
		UpdateTime:         ts(md.GetUpdateTime()),
		State:              ActorState(st.GetState()),
		SnapshotURI:        latestCompletedDurable(st).GetDurableSnapshot().GetObject().GetSnapshotUri(),
		SnapshotInProgress: snapshotInProgress(st),
	}
	if t := a.GetActorTemplate(); t != nil {
		out.Template = model.Key(t.GetAtespace(), t.GetName())
	}
	if wa := st.GetWorkerAssignment(); wa != nil {
		out.Worker = wa.GetWorker().GetName()
		if out.Worker == "" {
			out.Worker = wa.GetWorkerPod()
		}
		out.WorkerPod = wa.GetWorkerPod()
		out.WorkerNode = wa.GetNodeName()
		out.WorkerPool = wa.GetWorkerPool()
		out.WorkerIPs = nonEmpty(wa.GetWorkerPodIps())
		if len(out.WorkerIPs) > 0 {
			out.WorkerIP = out.WorkerIPs[0]
		}
		out.WorkerEpoch = wa.GetWorkerEpoch()
	}
	out.AssignedNode = st.GetAssignedNode()
	if c := st.GetCrash(); c != nil {
		out.Crash = &model.Crash{Message: c.GetMessage(), Time: ts(c.GetCrashTime())}
	}
	return out
}

// ToWorker converts a Substrate worker and its assignments.
func ToWorker(w *ateapi.Worker, assignments []*ateapi.ActorAssignment) model.Worker {
	st := w.GetStatus()
	out := model.Worker{
		Name:            w.GetMetadata().GetName(),
		Pool:            w.GetWorkerPool(),
		Pod:             w.GetWorkerPod(),
		Namespace:       w.GetWorkerNamespace(),
		Node:            w.GetNodeName(),
		State:           strings.TrimPrefix(st.GetState().String(), "WORKER_STATE_"),
		CapacityActors:  st.GetCapacity().GetActors(),
		AllocatedActors: st.GetAllocated().GetActors(),
		IPs:             nonEmpty(st.GetIps()),
		Epoch:           st.GetRegisteredEpoch(),
		ObservedEpoch:   st.GetObservedEpoch(),
		CapacityCPU:     cpuQuantity(st.GetCapacity().GetCpuMillicores()),
		CapacityMemory:  memoryQuantity(st.GetCapacity().GetMemoryBytes()),
		AllocatedCPU:    cpuQuantity(st.GetAllocated().GetCpuMillicores()),
		AllocatedMemory: memoryQuantity(st.GetAllocated().GetMemoryBytes()),
	}
	// Zero allocated is "0" next to a reported capacity: the worker is
	// idle, not silent about it.
	if out.AllocatedCPU == "" && out.CapacityCPU != "" {
		out.AllocatedCPU = "0"
	}
	if out.AllocatedMemory == "" && out.CapacityMemory != "" {
		out.AllocatedMemory = "0"
	}
	// One entry today (one per WorkerPool sandbox class); the first is the
	// worker's class. Empty until the worker process reports its runtimes.
	for _, sc := range st.GetSandboxClasses() {
		if out.SandboxClass = sc.GetSandboxClass(); out.SandboxClass != "" {
			break
		}
	}
	for _, as := range assignments {
		out.Actors = append(out.Actors, model.Key(as.GetActor().GetAtespace(), as.GetActor().GetName()))
	}
	return out
}

// nonEmpty returns the non-empty strings of ss, nil when there are none (so
// unchanged workers and actors stay reflect.DeepEqual across polls).
func nonEmpty(ss []string) []string {
	var out []string
	for _, s := range ss {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// cpuQuantity formats millicores as a Kubernetes quantity ("500m", "2"), ""
// for none.
func cpuQuantity(m int64) string {
	switch {
	case m <= 0:
		return ""
	case m%1000 == 0:
		return strconv.FormatInt(m/1000, 10)
	default:
		return strconv.FormatInt(m, 10) + "m"
	}
}

// memoryQuantity formats bytes as a Kubernetes quantity, with the largest
// binary suffix that divides it exactly ("960Mi", "2Gi", "1000"), "" for none.
func memoryQuantity(b int64) string {
	if b <= 0 {
		return ""
	}
	for _, u := range []struct {
		suffix string
		size   int64
	}{{"Ti", 1 << 40}, {"Gi", 1 << 30}, {"Mi", 1 << 20}, {"Ki", 1 << 10}} {
		if b%u.size == 0 {
			return strconv.FormatInt(b/u.size, 10) + u.suffix
		}
	}
	return strconv.FormatInt(b, 10)
}

// ToAtespace converts a Substrate atespace.
func ToAtespace(a *ateapi.Atespace) model.Atespace {
	return model.Atespace{Name: a.GetMetadata().GetName(), CreateTime: ts(a.GetMetadata().GetCreateTime())}
}
