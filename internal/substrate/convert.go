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
		State:              ActorState(st.GetState()),
		SnapshotURI:        st.GetExternalSnapshot().GetSnapshotUri(),
		SnapshotInProgress: st.GetInProgressSnapshotUri() != "" || st.GetInProgressLocalSnapshotName() != "",
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
	}
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
	}
	out.CapacityCPU, out.CapacityMemory = limits(w.GetStatus().GetCapacity().GetResources())
	out.AllocatedCPU, out.AllocatedMemory = limits(w.GetStatus().GetAllocated().GetResources())
	for _, as := range assignments {
		out.Actors = append(out.Actors, model.Key(as.GetActor().GetAtespace(), as.GetActor().GetName()))
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
