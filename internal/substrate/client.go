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

// Package substrate is a read-only client for Agent Substrate's control API.
//
// It exposes list and get calls only. None of them can wake an actor: they are
// answered by Substrate's API server from its database and never reach the
// actor. The gRPC stub is held behind readAPI, an interface with exactly those
// methods, so calling a mutating RPC would need a change here that
// TestNeverMutates catches.
package substrate

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"strings"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

// DefaultPageSize is the page size for list calls.
const DefaultPageSize = 500

// readAPI is the subset of ateapi.ControlClient the collector may use.
type readAPI interface {
	ListAtespaces(ctx context.Context, in *ateapi.ListAtespacesRequest, opts ...grpc.CallOption) (*ateapi.ListAtespacesResponse, error)
	ListActors(ctx context.Context, in *ateapi.ListActorsRequest, opts ...grpc.CallOption) (*ateapi.ListActorsResponse, error)
	GetActor(ctx context.Context, in *ateapi.GetActorRequest, opts ...grpc.CallOption) (*ateapi.Actor, error)
	ListWorkers(ctx context.Context, in *ateapi.ListWorkersRequest, opts ...grpc.CallOption) (*ateapi.ListWorkersResponse, error)
	ListWorkerActorAssignments(ctx context.Context, in *ateapi.ListWorkerActorAssignmentsRequest, opts ...grpc.CallOption) (*ateapi.ListWorkerActorAssignmentsResponse, error)
}

// Options configures the connection, the same way ax-server connects.
type Options struct {
	// Target is host:port, default api.ate-system.svc.cluster.local:443.
	Target string
	// Authority is the TLS server name and :authority, default
	// api.ate-system.svc.
	Authority string
	// TokenFile holds a bearer token (a projected service account token with
	// audience api.ate-system.svc). It is re-read on every call, so kubelet
	// rotation just works.
	TokenFile string
	// CAFile is the PEM bundle to trust (the servicedns cluster trust
	// bundle). Empty uses the system roots.
	CAFile string
	// InsecureSkipVerify skips server certificate checks (dev only).
	InsecureSkipVerify bool
	// Plaintext dials without TLS (tests only).
	Plaintext bool
}

// Client is the read-only Substrate client.
type Client struct {
	conn     *grpc.ClientConn
	api      readAPI
	PageSize int32
}

type tokenAuth struct {
	tokenFile string
	secure    bool
}

func (t tokenAuth) GetRequestMetadata(context.Context, ...string) (map[string]string, error) {
	b, err := os.ReadFile(t.tokenFile)
	if err != nil {
		return nil, fmt.Errorf("reading token file %q: %w", t.tokenFile, err)
	}
	return map[string]string{"authorization": "Bearer " + strings.TrimSpace(string(b))}, nil
}

func (t tokenAuth) RequireTransportSecurity() bool { return t.secure }

// Dial connects to Substrate. The connection is lazy; errors show up on the
// first call.
func Dial(o Options) (*Client, error) {
	if o.Target == "" {
		o.Target = "api.ate-system.svc.cluster.local:443"
	}
	if o.Authority == "" && strings.Contains(o.Target, "api.ate-system.svc") {
		o.Authority = "api.ate-system.svc"
	}
	var opts []grpc.DialOption
	if o.Plaintext {
		opts = append(opts, grpc.WithTransportCredentials(insecure.NewCredentials()))
	} else {
		cfg := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: o.Authority, InsecureSkipVerify: o.InsecureSkipVerify} //nolint:gosec // dev flag
		if o.CAFile != "" {
			pem, err := os.ReadFile(o.CAFile)
			if err != nil {
				return nil, fmt.Errorf("reading CA file %q: %w", o.CAFile, err)
			}
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM(pem) {
				return nil, fmt.Errorf("no certificates in CA file %q", o.CAFile)
			}
			cfg.RootCAs = pool
		}
		opts = append(opts, grpc.WithTransportCredentials(credentials.NewTLS(cfg)))
	}
	if o.Authority != "" {
		opts = append(opts, grpc.WithAuthority(o.Authority))
	}
	if o.TokenFile != "" {
		opts = append(opts, grpc.WithPerRPCCredentials(tokenAuth{tokenFile: o.TokenFile, secure: !o.Plaintext}))
	}
	conn, err := grpc.NewClient(o.Target, opts...)
	if err != nil {
		return nil, fmt.Errorf("connecting to Substrate at %s: %w", o.Target, err)
	}
	return &Client{conn: conn, api: ateapi.NewControlClient(conn), PageSize: DefaultPageSize}, nil
}

// newClient wraps an existing read API (tests).
func newClient(api readAPI) *Client { return &Client{api: api, PageSize: DefaultPageSize} }

// Close closes the connection.
func (c *Client) Close() error {
	if c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// explain adds what to do to a PermissionDenied error. Substrate v1.0
// always enforces authorization and checks every RPC the collector makes;
// the global viewer role covers them all.
func explain(err error) error {
	if status.Code(err) == codes.PermissionDenied {
		return fmt.Errorf("%w (Substrate enforces authorization: grant user:system:serviceaccount:<namespace>:<serviceaccount> the global viewer role, see \"Authorization\" in docs/design.md)", err)
	}
	return err
}

// maxPages bounds a list loop in case a server keeps returning a token.
const maxPages = 10000

// paginate calls fetch until it returns an empty page token.
func paginate(fetch func(token string) (next string, err error)) error {
	token := ""
	seen := map[string]bool{}
	for i := 0; i < maxPages; i++ {
		next, err := fetch(token)
		if err != nil {
			return err
		}
		if next == "" {
			return nil
		}
		if seen[next] {
			return fmt.Errorf("server repeated page token %q", next)
		}
		seen[next] = true
		token = next
	}
	return fmt.Errorf("gave up after %d pages", maxPages)
}

// ListAtespaces returns every atespace.
func (c *Client) ListAtespaces(ctx context.Context) ([]*ateapi.Atespace, error) {
	var out []*ateapi.Atespace
	err := paginate(func(token string) (string, error) {
		resp, err := c.api.ListAtespaces(ctx, &ateapi.ListAtespacesRequest{Options: &ateapi.ListOptions{PageSize: c.PageSize, PageToken: token}})
		if err != nil {
			return "", fmt.Errorf("listing atespaces: %w", explain(err))
		}
		out = append(out, resp.GetAtespaces()...)
		return resp.GetNextPageToken(), nil
	})
	return out, err
}

// ListActors returns every actor in an atespace.
func (c *Client) ListActors(ctx context.Context, atespace string) ([]*ateapi.Actor, error) {
	var out []*ateapi.Actor
	err := paginate(func(token string) (string, error) {
		resp, err := c.api.ListActors(ctx, &ateapi.ListActorsRequest{Atespace: atespace, Options: &ateapi.ListOptions{PageSize: c.PageSize, PageToken: token}})
		if err != nil {
			return "", fmt.Errorf("listing actors in %s: %w", atespace, explain(err))
		}
		out = append(out, resp.GetActors()...)
		return resp.GetNextPageToken(), nil
	})
	return out, err
}

// GetActor returns one actor. Like the list calls it is answered from
// Substrate's database and does not wake the actor.
func (c *Client) GetActor(ctx context.Context, atespace, name string) (*ateapi.Actor, error) {
	a, err := c.api.GetActor(ctx, &ateapi.GetActorRequest{Actor: &ateapi.ObjectRef{Atespace: atespace, Name: name}})
	if err != nil {
		return nil, fmt.Errorf("getting actor %s/%s: %w", atespace, name, explain(err))
	}
	return a, nil
}

// ListWorkers returns every worker.
func (c *Client) ListWorkers(ctx context.Context) ([]*ateapi.Worker, error) {
	var out []*ateapi.Worker
	err := paginate(func(token string) (string, error) {
		resp, err := c.api.ListWorkers(ctx, &ateapi.ListWorkersRequest{Options: &ateapi.ListOptions{PageSize: c.PageSize, PageToken: token}})
		if err != nil {
			return "", fmt.Errorf("listing workers: %w", explain(err))
		}
		out = append(out, resp.GetWorkers()...)
		return resp.GetNextPageToken(), nil
	})
	return out, err
}

// ListWorkerActorAssignments returns the actors assigned to a worker.
func (c *Client) ListWorkerActorAssignments(ctx context.Context, worker string) ([]*ateapi.ActorAssignment, error) {
	var out []*ateapi.ActorAssignment
	err := paginate(func(token string) (string, error) {
		resp, err := c.api.ListWorkerActorAssignments(ctx, &ateapi.ListWorkerActorAssignmentsRequest{
			Worker: &ateapi.ObjectRef{Name: worker}, Options: &ateapi.ListOptions{PageSize: c.PageSize, PageToken: token},
		})
		if err != nil {
			return "", fmt.Errorf("listing assignments of worker %s: %w", worker, explain(err))
		}
		out = append(out, resp.GetActorAssignments()...)
		return resp.GetNextPageToken(), nil
	})
	return out, err
}

// ActorState returns an actor's current state ("RUNNING", "SUSPENDED", ...).
func (c *Client) ActorState(ctx context.Context, atespace, name string) (string, error) {
	a, err := c.GetActor(ctx, atespace, name)
	if err != nil {
		return "", err
	}
	return ActorState(a.GetStatus().GetState()), nil
}
