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

package raw

import (
	"encoding/json"
	"strings"
	"testing"

	"google.golang.org/protobuf/types/known/structpb"

	"github.com/go-steer/substrate-scope/internal/axapi"
)

func encode(t *testing.T, v any) string {
	t.Helper()
	var b strings.Builder
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(b.String())
}

func TestProtoRedactsTask(t *testing.T) {
	task := &axapi.Task{
		Kind:     "Task",
		Metadata: &axapi.ObjectMeta{Atespace: "cred-test", Name: "t1"},
		Spec: &axapi.TaskSpec{
			Image:   "runner:1",
			Command: []string{"run", "--port=8080"},
			Env:     []*axapi.EnvVar{{Name: "GEMINI_API_KEY", Value: "sk-live-123"}, {Name: "LOG_LEVEL", Value: "debug"}},
			Egress: []*axapi.EgressRule{{
				Hosts:       []string{"api.example.com"},
				Credentials: []*axapi.CredentialInjection{{Header: "Authorization", Prefix: "Bearer ", CredentialUri: "sm://projects/p/secrets/key"}},
			}},
		},
		Status: &axapi.TaskStatus{Phase: "Running", Actor: "t1"},
	}
	// spec.config is free-form runner configuration; ax says it must not
	// hold secrets, but the same key-based masking applies to it.
	cfg, err := structpb.NewStruct(map[string]any{"maxTurns": 20, "model": "gemini", "apiToken": "tok-in-config"})
	if err != nil {
		t.Fatal(err)
	}
	task.Spec.Config = cfg
	v, err := Proto(task)
	if err != nil {
		t.Fatal(err)
	}
	got := encode(t, v)
	for _, leak := range []string{"sk-live-123", "debug", "sm://projects", "tok-in-config"} {
		if strings.Contains(got, leak) {
			t.Errorf("leaked %q: %s", leak, got)
		}
	}
	for _, keep := range []string{`"GEMINI_API_KEY"`, `"LOG_LEVEL"`, `"runner:1"`, `"--port=8080"`, `"api.example.com"`, `"header":"Authorization"`, `"maxTurns":20`, `"model":"gemini"`, `"phase":"Running"`} {
		if !strings.Contains(got, keep) {
			t.Errorf("missing %s: %s", keep, got)
		}
	}
}

func TestProtoRedactsWorkspace(t *testing.T) {
	ws := &axapi.Workspace{
		Metadata: &axapi.ObjectMeta{Atespace: "cred-test", Name: "repo"},
		Spec: &axapi.WorkspaceSpec{
			Git:   []*axapi.GitRepo{{Name: "app", Repo: "https://bot:ghp_abc@github.com/org/app.git", Branch: "main"}},
			Files: []*axapi.File{{Path: "/etc/agent/prompt.md", Content: "internal plan"}},
			Mcp:   &axapi.MCPConfig{Servers: []*axapi.MCPServer{{Name: "gh", Command: "gh-mcp", Args: []string{"--token", "ghp_xyz"}}}},
		},
	}
	v, err := Proto(ws)
	if err != nil {
		t.Fatal(err)
	}
	got := encode(t, v)
	for _, leak := range []string{"ghp_abc", "bot:", "internal plan", "ghp_xyz"} {
		if strings.Contains(got, leak) {
			t.Errorf("leaked %q: %s", leak, got)
		}
	}
	for _, keep := range []string{"github.com/org/app.git", `"/etc/agent/prompt.md"`, "(13 bytes)", `"gh-mcp"`, `"branch":"main"`} {
		if !strings.Contains(got, keep) {
			t.Errorf("missing %s: %s", keep, got)
		}
	}
}

func TestRedactKeepsNonSecrets(t *testing.T) {
	v := Redact(map[string]any{
		"secretKey": map[string]any{"name": "gemini", "key": "api-key"},
		"tokens":    []any{"a", "b"},
		"args":      []any{"--verbose"},
		"git":       "git@github.com:org/app.git",
	})
	got := encode(t, v)
	want := `{"args":["--verbose"],"git":"git@github.com:org/app.git","secretKey":{"key":"api-key","name":"gemini"},"tokens":["<redacted>","<redacted>"]}`
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}
