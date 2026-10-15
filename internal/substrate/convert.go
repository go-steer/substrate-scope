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
	"strings"
	"time"

	"github.com/agent-substrate/substrate/pkg/proto/ateapipb"
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
func ActorState(s ateapipb.ActorState) string {
	return strings.TrimPrefix(s.String(), "ACTOR_STATE_")
}

// agentState is the model's state for an actor. Substrate v0.5 dropped
// ACTOR_STATE_PAUSING and ACTOR_STATE_PAUSED (a pause is now a suspend that
// keeps a node-local snapshot), so they are derived the way the API server
// itself tells a pause from a suspend (controlapi/snapshot_helpers.go at
// v0.5.0): PAUSED is SUSPENDED with a latest snapshot that is node-local and
// has no durable copy; PAUSING is SUSPENDING with a latest snapshot that has
// neither a locality nor a durable copy yet (a suspend's has a pending
// durable copy).
func agentState(st *ateapipb.ActorStatus) string {
	latest := latestSnapshot(st)
	switch st.GetState() {
	case ateapipb.ActorState_ACTOR_STATE_SUSPENDED:
		if latest.GetLocality() != "" && latest.GetDurableSnapshot() == nil {
			return model.StatePaused
		}
	case ateapipb.ActorState_ACTOR_STATE_SUSPENDING:
		if latest != nil && latest.GetLocality() == "" && latest.GetDurableSnapshot() == nil {
			return model.StatePausing
		}
	}
	return ActorState(st.GetState())
}

// latestSnapshot returns the snapshot at the actor's last assigned
// generation, nil if it has none.
func latestSnapshot(st *ateapipb.ActorStatus) *ateapipb.Snapshot {
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
func latestCompletedDurable(st *ateapipb.ActorStatus) *ateapipb.Snapshot {
	var out *ateapipb.Snapshot
	for _, s := range st.GetSnapshots() {
		if s.GetDurableSnapshot().GetStatus() == ateapipb.SnapshotStorageStatus_SNAPSHOT_STORAGE_STATUS_COMPLETED &&
			(out == nil || s.GetGeneration() >= out.GetGeneration()) {
			out = s
		}
	}
	return out
}

// snapshotInProgress reports whether the actor's latest snapshot is still
// being taken: its durable copy is pending, or it is a local checkpoint not
// captured yet (no locality and no durable copy).
func snapshotInProgress(st *ateapipb.ActorStatus) bool {
	latest := latestSnapshot(st)
	if latest == nil {
		return false
	}
	if d := latest.GetDurableSnapshot(); d != nil {
		return d.GetStatus() == ateapipb.SnapshotStorageStatus_SNAPSHOT_STORAGE_STATUS_PENDING
	}
	return latest.GetLocality() == ""
}

// ToAgent converts a Substrate actor.
func ToAgent(a *ateapipb.Actor) model.Agent {
	md := a.GetMetadata()
	st := a.GetStatus()
	out := model.Agent{
		Atespace:           md.GetAtespace(),
		Name:               md.GetName(),
		UID:                md.GetUid(),
		Version:            md.GetVersion(),
		CreateTime:         ts(md.GetCreateTime()),
		UpdateTime:         ts(md.GetUpdateTime()),
		State:              agentState(st),
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
func ToWorker(w *ateapipb.Worker, assignments []*ateapipb.ActorAssignment) model.Worker {
	out := model.Worker{
		Name:            w.GetMetadata().GetName(),
		Pool:            w.GetWorkerPool(),
		Pod:             w.GetWorkerPod(),
		Namespace:       w.GetWorkerNamespace(),
		Node:            w.GetNodeName(),
		SandboxClass:    w.GetSandboxClass(),
		State:           strings.TrimPrefix(w.GetStatus().GetState().String(), "WORKER_STATE_"),
		CapacityActors:  w.GetStatus().GetCapacity().GetActors(),
		AllocatedActors: w.GetStatus().GetAllocated().GetActors(),
		IPs:             nonEmpty(w.GetIps()),
		Epoch:           w.GetEpoch(),
		ObservedEpoch:   w.GetStatus().GetObservedEpoch(),
	}
	out.CapacityCPU, out.CapacityMemory = limits(w.GetStatus().GetCapacity().GetResources())
	out.AllocatedCPU, out.AllocatedMemory = limits(w.GetStatus().GetAllocated().GetResources())
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

// limits returns the cpu and memory quantities of a resource list.
func limits(r *ateapipb.Resources) (cpu, memory string) {
	for _, l := range r.GetLimits() {
		switch l.GetName() {
		case "cpu":
			cpu = l.GetQuantity()
		case "memory":
			memory = l.GetQuantity()
		}
	}
	return cpu, memory
}

// ToAtespace converts a Substrate atespace.
func ToAtespace(a *ateapipb.Atespace) model.Atespace {
	return model.Atespace{Name: a.GetMetadata().GetName(), CreateTime: ts(a.GetMetadata().GetCreateTime())}
}
