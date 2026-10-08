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

// Package ax is a read-only client for the Agent Executor (ax) API. It lists
// tasks and nothing else; listing reads ax's store and never reaches the
// task's actor.
package ax

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/go-steer/substrate-scope/internal/axapi"
	"github.com/go-steer/substrate-scope/internal/model"
)

// pageSize is the ListTasks limit per call.
const pageSize = 200

// maxTasks bounds one atespace's listing.
const maxTasks = 100000

// readAPI is the subset of axapi.AXClient the collector may use.
type readAPI interface {
	ListTasks(ctx context.Context, in *axapi.ListTasksRequest, opts ...grpc.CallOption) (*axapi.ListTasksResponse, error)
}

// Client lists ax tasks.
type Client struct {
	conn *grpc.ClientConn
	api  readAPI
}

// Dial connects to ax-server (plaintext gRPC, as ax-server serves in-cluster).
func Dial(target string) (*Client, error) {
	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("connecting to ax at %s: %w", target, err)
	}
	return &Client{conn: conn, api: axapi.NewAXClient(conn)}, nil
}

// Close closes the connection.
func (c *Client) Close() error {
	if c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// ListTasks returns the tasks in an atespace keyed by the name of the actor
// each runs as (ax names the actor after the task).
func (c *Client) ListTasks(ctx context.Context, atespace string) (map[string]model.Task, error) {
	out := map[string]model.Task{}
	for offset := int64(0); offset < maxTasks; offset += pageSize {
		resp, err := c.api.ListTasks(ctx, &axapi.ListTasksRequest{Atespace: atespace, Limit: pageSize, Offset: offset})
		if err != nil {
			return nil, fmt.Errorf("listing ax tasks in %s: %w", atespace, err)
		}
		for _, t := range resp.GetTasks() {
			if t.GetMetadata().GetAtespace() != "" && t.GetMetadata().GetAtespace() != atespace {
				continue
			}
			name := t.GetStatus().GetActor()
			if name == "" {
				name = t.GetMetadata().GetName()
			}
			out[name] = ToTask(t)
		}
		if len(resp.GetTasks()) < pageSize {
			return out, nil
		}
	}
	return out, nil
}

func ts(t *timestamppb.Timestamp) *time.Time {
	if t == nil || !t.IsValid() {
		return nil
	}
	v := t.AsTime()
	return &v
}

// ToTask converts an ax task.
func ToTask(t *axapi.Task) model.Task {
	sp := t.GetSpec()
	out := model.Task{
		Phase:            t.GetStatus().GetPhase(),
		Image:            sp.GetImage(),
		Command:          sp.GetCommand(),
		IdleSuspendAfter: sp.GetIdle().GetSuspendAfter(),
		IdleBusyPath:     sp.GetIdle().GetBusyPath(),
		OnCompletion:     sp.GetOnCompletion(),
		HTTPPort:         sp.GetHttp().GetPort(),
		CreateTime:       ts(t.GetMetadata().GetCreationTimestamp()),
	}
	for _, w := range sp.GetWorkspaces() {
		out.Workspaces = append(out.Workspaces, w.GetName())
	}
	for _, c := range t.GetStatus().GetConditions() {
		out.Conditions = append(out.Conditions, model.Condition{
			Type:               c.GetType(),
			Status:             c.GetStatus(),
			Reason:             c.GetReason(),
			Message:            c.GetMessage(),
			LastTransitionTime: ts(c.GetLastTransitionTime()),
		})
	}
	return out
}
