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
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/protobuf/reflect/protoreflect"

	"github.com/go-steer/substrate-scope/internal/axapi"
)

// readOnly reports whether an RPC name is a read: List*, Get* or Watch*.
func readOnly(method string) bool {
	return strings.HasPrefix(method, "List") || strings.HasPrefix(method, "Get") || strings.HasPrefix(method, "Watch")
}

// mutatingRPCs returns every non-read RPC of the given services, taken from
// the proto descriptors so a new mutating RPC upstream is covered
// automatically (CreateActor, SuspendActor, ResumeActor, DrainWorker,
// MintActorJWT, SuspendTask, Create/Update/DeleteAtespaceAccessPolicy, ...).
func mutatingRPCs(t *testing.T) map[string]string {
	t.Helper()
	out := map[string]string{}
	add := func(fd protoreflect.FileDescriptor) {
		svcs := fd.Services()
		for i := 0; i < svcs.Len(); i++ {
			svc := svcs.Get(i)
			ms := svc.Methods()
			for j := 0; j < ms.Len(); j++ {
				name := string(ms.Get(j).Name())
				if !readOnly(name) {
					out[name] = string(svc.FullName())
				}
			}
		}
	}
	add(ateapipb.File_ateapi_proto)
	add(axapi.File_ax_proto)
	for _, must := range []string{
		"SuspendActor", "ResumeActor", "DeleteActor", "CreateActor", "PauseActor", "RevertActor", "DrainWorker", "SuspendTask", "ResumeTask",
		// Substrate v0.4: access policy writes (the collector must never
		// grant itself or anyone else access) and the worker-only service.
		"CreateGlobalAccessPolicy", "UpdateGlobalAccessPolicy",
		"CreateAtespaceAccessPolicy", "UpdateAtespaceAccessPolicy", "DeleteAtespaceAccessPolicy",
		"RegisterWorker", "MintAteomActorCertificate", "RequestActorSuspend",
	} {
		if _, ok := out[must]; !ok {
			t.Fatalf("descriptor scan missed %s; the test is broken", must)
		}
	}
	return out
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod not found")
		}
		dir = parent
	}
}

// TestNeverMutates fails if any non-test Go file in the module (outside the
// generated ax stubs) refers to a mutating Substrate or ax RPC, its request
// type or its stub method. The collector must only list and get, so it can
// never wake, suspend, create or delete anything.
func TestNeverMutates(t *testing.T) {
	bad := mutatingRPCs(t)
	root := moduleRoot(t)
	var violations []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case "node_modules", ".git", "vendor":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		if strings.HasPrefix(rel, filepath.Join("internal", "axapi")+string(filepath.Separator)) {
			return nil // generated stubs define every RPC
		}
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		ast.Inspect(f, func(n ast.Node) bool {
			id, ok := n.(*ast.Ident)
			if !ok {
				return true
			}
			for rpc, svc := range bad {
				if id.Name == rpc || strings.HasPrefix(id.Name, rpc+"Request") || strings.HasPrefix(id.Name, rpc+"Response") {
					violations = append(violations, fset.Position(id.Pos()).String()+": "+id.Name+" ("+svc+"/"+rpc+")")
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(violations)
	for _, v := range violations {
		t.Errorf("mutating RPC referenced: %s", v)
	}
}

// TestReadAPIIsReadOnly checks the gRPC surface the client holds has only
// read methods.
func TestReadAPIIsReadOnly(t *testing.T) {
	typ := reflect.TypeFor[readAPI]()
	for i := 0; i < typ.NumMethod(); i++ {
		if name := typ.Method(i).Name; !readOnly(name) {
			t.Errorf("readAPI has non-read method %s", name)
		}
	}
	if !typ.Implements(typ) || !reflect.TypeFor[ateapipb.ControlClient]().Implements(typ) {
		t.Fatal("ateapipb.ControlClient no longer satisfies readAPI")
	}
}

// TestReadAPIExactSet pins the RPCs the collector calls. Growing it is a
// deliberate change: a new call may need a wider grant when Substrate runs
// with authorization enabled (see "Authorization" in docs/design.md).
func TestReadAPIExactSet(t *testing.T) {
	want := []string{"GetActor", "ListActors", "ListAtespaces", "ListWorkerActorAssignments", "ListWorkers"}
	typ := reflect.TypeFor[readAPI]()
	var got []string
	for i := 0; i < typ.NumMethod(); i++ {
		got = append(got, typ.Method(i).Name)
	}
	sort.Strings(got)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("readAPI methods = %v, want %v", got, want)
	}
}
