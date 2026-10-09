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

// Package router talks to actors through Agent Substrate's atenet router,
// which picks the actor from the ate-target-actor header.
//
// Anything sent through the router reaches the actor, and the router resumes
// a suspended actor to deliver it. So callers must only use RunnerStatus for
// actors Substrate reports as running, and the attach proxy only on an
// explicit user action; internal/server enforces both.
package router

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

// TargetHeader is the router's routing header, value "<atespace>/<name>".
const TargetHeader = "ate-target-actor"

// StatusPath is where an ax runner reports activity. Reading it does not
// count as activity, so polling it doesn't keep a task awake.
const StatusPath = "/metadata/v1alpha1/ax/status"

// RunnerStatus is the body served at StatusPath (ax fork, task-idle-suspend).
type RunnerStatus struct {
	IdleSeconds int64  `json:"idleSeconds"`
	InFlight    int    `json:"inFlight"`
	Busy        bool   `json:"busy"`
	BusyError   string `json:"busyError,omitempty"`
	Exited      bool   `json:"exited"`
	ExitCode    int    `json:"exitCode"`
}

// Client reaches actors through the router.
type Client struct {
	// Addr is the router's host:port, e.g.
	// atenet-router.ate-system.svc.cluster.local:80.
	Addr string
	// HTTP defaults to a client with a 5s timeout.
	HTTP *http.Client
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 5 * time.Second}
}

func (c *Client) base() string {
	if strings.HasPrefix(c.Addr, "http://") || strings.HasPrefix(c.Addr, "https://") {
		return strings.TrimSuffix(c.Addr, "/")
	}
	return "http://" + c.Addr
}

// RunnerStatus reads an ax runner's status. The caller must have checked the
// actor is running.
func (c *Client) RunnerStatus(ctx context.Context, atespace, name string) (*RunnerStatus, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base()+StatusPath, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set(TargetHeader, atespace+"/"+name)
	resp, err := c.http().Do(req)
	if err != nil {
		return nil, fmt.Errorf("reading runner status of %s/%s: %w", atespace, name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("runner status of %s/%s: %s", atespace, name, resp.Status)
	}
	var st RunnerStatus
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&st); err != nil {
		return nil, fmt.Errorf("decoding runner status of %s/%s: %w", atespace, name, err)
	}
	return &st, nil
}

// TokenSource returns the bearer token the attach proxy sends to agents.
type TokenSource func() (string, error)

// FileToken reads the token from a file on every call (so a rotated Secret
// is picked up).
func FileToken(path string) TokenSource {
	return func() (string, error) {
		b, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("reading agent token: %w", err)
		}
		return strings.TrimSpace(string(b)), nil
	}
}

// StaticToken returns a fixed token (from an environment variable).
func StaticToken(tok string) TokenSource {
	return func() (string, error) { return tok, nil }
}

// AttachProxy returns a reverse proxy that sends a request to the actor
// named by target(r) at the path path(r), adding the routing header and the
// agent bearer token. Browser credentials (cookies, Authorization) are not
// forwarded. Streaming responses (SSE) are flushed as they arrive.
func (c *Client) AttachProxy(token TokenSource, target func(*http.Request) (actor, path string)) http.Handler {
	base, _ := url.Parse(c.base())
	return &httputil.ReverseProxy{
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			actor, p := target(pr.In)
			pr.SetURL(base)
			pr.Out.URL.Path = p
			pr.Out.URL.RawPath = ""
			q := pr.In.URL.Query()
			q.Del("scope_wake")
			pr.Out.URL.RawQuery = q.Encode()
			pr.Out.Host = base.Host
			pr.Out.Header.Del("Cookie")
			pr.Out.Header.Del("Authorization")
			pr.Out.Header.Del("X-Scope-Wake")
			pr.Out.Header.Set(TargetHeader, actor)
			if tok, err := token(); err == nil && tok != "" {
				pr.Out.Header.Set("Authorization", "Bearer "+tok)
			}
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, "attach proxy: "+err.Error(), http.StatusBadGateway)
		},
	}
}
