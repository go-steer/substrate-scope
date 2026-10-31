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

package ax

import (
	"context"
	"fmt"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/go-steer/substrate-scope/internal/axapi"
)

type fakeAX struct {
	tasks []*axapi.Task
	calls int
}

func (f *fakeAX) ListTasks(_ context.Context, in *axapi.ListTasksRequest, _ ...grpc.CallOption) (*axapi.ListTasksResponse, error) {
	f.calls++
	start := min(int(in.GetOffset()), len(f.tasks))
	end := min(start+int(in.GetLimit()), len(f.tasks))
	return &axapi.ListTasksResponse{Tasks: f.tasks[start:end]}, nil
}

func (f *fakeAX) GetTask(_ context.Context, in *axapi.GetTaskRequest, _ ...grpc.CallOption) (*axapi.Task, error) {
	for _, t := range f.tasks {
		if t.GetMetadata().GetAtespace() == in.GetAtespace() && t.GetMetadata().GetName() == in.GetName() {
			return t, nil
		}
	}
	return nil, status.Error(codes.NotFound, "no such task")
}

func (f *fakeAX) GetWorkspace(_ context.Context, in *axapi.GetWorkspaceRequest, _ ...grpc.CallOption) (*axapi.Workspace, error) {
	return &axapi.Workspace{Metadata: &axapi.ObjectMeta{Atespace: in.GetAtespace(), Name: in.GetName()}}, nil
}

func TestListTasksPaginatesAndKeysByActor(t *testing.T) {
	f := &fakeAX{}
	for i := 0; i < 450; i++ {
		f.tasks = append(f.tasks, &axapi.Task{
			Metadata: &axapi.ObjectMeta{Atespace: "cred-test", Name: fmt.Sprintf("t%03d", i)},
			Spec:     &axapi.TaskSpec{Idle: &axapi.TaskIdle{SuspendAfter: "10m"}, Http: &axapi.TaskHTTP{Port: 8484}},
			Status: &axapi.TaskStatus{Phase: "Suspended", Actor: fmt.Sprintf("t%03d", i), Conditions: []*axapi.Condition{
				{Type: "Ready", Status: "False", Reason: "Suspended"},
				{Type: "AutoSuspended", Status: "True", Reason: "IdleSuspended"},
			}},
		})
	}
	c := &Client{api: f}
	got, err := c.ListTasks(context.Background(), "cred-test")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 450 || f.calls != 3 {
		t.Fatalf("got %d tasks in %d calls, want 450 in 3", len(got), f.calls)
	}
	task := got["t123"]
	if task.Phase != "Suspended" || task.IdleSuspendAfter != "10m" || task.HTTPPort != 8484 || task.Ready().Reason != "Suspended" || task.AutoSuspended().Reason != "IdleSuspended" {
		t.Fatalf("task = %+v", task)
	}
}

func TestToTask(t *testing.T) {
	created := timestamppb.New(time.Date(2026, 10, 31, 9, 0, 0, 0, time.UTC))
	read := timestamppb.New(time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC))
	suspended := timestamppb.New(time.Date(2026, 10, 31, 11, 0, 0, 0, time.UTC))
	task := &axapi.Task{
		Metadata: &axapi.ObjectMeta{Atespace: "cred-test", Name: "triage", CreateTime: created},
		Spec: &axapi.TaskSpec{
			Image:        "runner",
			Command:      []string{"mast"},
			Workspace:    &axapi.WorkspaceRef{Name: "repo"},
			Idle:         &axapi.TaskIdle{SuspendAfter: "10m", BusyPath: "/busy"},
			OnCompletion: "Suspend",
			Http:         &axapi.TaskHTTP{Port: 8484},
		},
		Status: &axapi.TaskStatus{Phase: "Suspended", Conditions: []*axapi.Condition{
			{Type: "Ready", Status: "False", Reason: "Suspended", UpdateTime: read},
			{Type: "AutoSuspended", Status: "True", Reason: "IdleSuspended", Message: "No requests for 10m0s", UpdateTime: suspended},
		}},
	}
	got := ToTask(task)
	if got.Name != "triage" || got.Workspace != "repo" || got.CreateTime == nil || !got.CreateTime.Equal(created.AsTime()) ||
		got.IdleSuspendAfter != "10m" || got.IdleBusyPath != "/busy" || got.OnCompletion != "Suspend" || got.HTTPPort != 8484 {
		t.Fatalf("ToTask = %+v", got)
	}
	// Ready is derived on every read: its time is the read's, so it is dropped.
	if r := got.Ready(); r == nil || r.Reason != "Suspended" || r.UpdateTime != nil {
		t.Fatalf("Ready = %+v", r)
	}
	if a := got.AutoSuspended(); a == nil || a.Status != "True" || a.Reason != "IdleSuspended" || a.UpdateTime == nil || !a.UpdateTime.Equal(suspended.AsTime()) {
		t.Fatalf("AutoSuspended = %+v", a)
	}
	// Failed covers both ax's own failures and a crashed actor (derived),
	// so Ready has no time there either.
	task.Status = &axapi.TaskStatus{Phase: "Failed", Conditions: []*axapi.Condition{{Type: "Ready", Status: "False", Reason: "ActorNotFound", UpdateTime: read}}}
	failed := ToTask(task)
	if r := failed.Ready(); r == nil || r.Reason != "ActorNotFound" || r.UpdateTime != nil {
		t.Fatalf("failed Ready = %+v", r)
	}
	// Unknown: ax could not reach Substrate.
	task.Status = &axapi.TaskStatus{Phase: "Unknown", Conditions: []*axapi.Condition{{Type: "Ready", Status: "Unknown", Reason: "SubstrateUnavailable", UpdateTime: read}}}
	if got := ToTask(task); got.Phase != "Unknown" || got.Ready().Reason != "SubstrateUnavailable" || got.Ready().UpdateTime != nil {
		t.Fatalf("unknown = %+v", got)
	}
}
