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

	"google.golang.org/grpc"

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

func TestListTasksPaginatesAndKeysByActor(t *testing.T) {
	f := &fakeAX{}
	for i := 0; i < 450; i++ {
		f.tasks = append(f.tasks, &axapi.Task{
			Metadata: &axapi.ObjectMeta{Atespace: "cred-test", Name: fmt.Sprintf("t%03d", i)},
			Spec:     &axapi.TaskSpec{Idle: &axapi.TaskIdle{SuspendAfter: "10m"}, Http: &axapi.TaskHTTP{Port: 8484}},
			Status: &axapi.TaskStatus{Phase: "Suspended", Actor: fmt.Sprintf("t%03d", i), Conditions: []*axapi.Condition{
				{Type: "Ready", Status: "False", Reason: "IdleSuspended"},
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
	if task.Phase != "Suspended" || task.IdleSuspendAfter != "10m" || task.HTTPPort != 8484 || task.Ready().Reason != "IdleSuspended" {
		t.Fatalf("task = %+v", task)
	}
}
