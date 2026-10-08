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

package model

import (
	"time"
)

// Event types.
const (
	EventAgentAdded       = "agent_added"
	EventAgentRemoved     = "agent_removed"
	EventAgentState       = "agent_state"
	EventAgentWoke        = "agent_woke"
	EventAgentSuspended   = "agent_suspended"
	EventAgentCrashed     = "agent_crashed"
	EventAgentUpdated     = "agent_updated"
	EventWorkerAssignment = "worker_assignment"
	EventTaskUpdated      = "task_updated"
	EventWorkerAdded      = "worker_added"
	EventWorkerRemoved    = "worker_removed"
	EventWorkerUpdated    = "worker_updated"
	EventAtespaceAdded    = "atespace_added"
	EventAtespaceRemoved  = "atespace_removed"
)

// Event is one change to the picture. Agent events carry the agent as it is
// after the change (as it was, for agent_removed), so a client can apply any
// agent event by replacing its copy.
type Event struct {
	Seq      uint64    `json:"seq"`
	Time     time.Time `json:"time"`
	Type     string    `json:"type"`
	Key      string    `json:"key,omitempty"`
	Agent    *Agent    `json:"agent,omitempty"`
	Worker   *Worker   `json:"worker,omitempty"`
	Atespace *Atespace `json:"atespace,omitempty"`
	// From and To are the old and new state (agent_state), or the old and
	// new worker (worker_assignment).
	From string `json:"from,omitempty"`
	To   string `json:"to,omitempty"`
	// Reason explains agent_suspended (IdleSuspended, CompletedSuspended,
	// ActorSuspended) and agent_woke (ResumedByRequest when ax says the
	// router resumed the task).
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
	// New marks a task_updated for a task the agent didn't have before.
	New bool `json:"new,omitempty"`
}
