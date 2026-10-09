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

// Command substrate-scope is the per-cluster collector: it polls Agent
// Substrate and ax, keeps the current picture in memory, streams changes to
// browsers and serves the 3D front end.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-steer/substrate-scope/internal/ax"
	"github.com/go-steer/substrate-scope/internal/cluster"
	"github.com/go-steer/substrate-scope/internal/collector"
	"github.com/go-steer/substrate-scope/internal/model"
	"github.com/go-steer/substrate-scope/internal/router"
	"github.com/go-steer/substrate-scope/internal/server"
	"github.com/go-steer/substrate-scope/internal/substrate"
	"github.com/go-steer/substrate-scope/web"
)

func main() {
	if err := run(); err != nil {
		slog.Error("substrate-scope failed", "error", err)
		os.Exit(1)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func run() error {
	var (
		addr        = flag.String("addr", envOr("SCOPE_ADDR", ":8080"), "listen address")
		clusterName = flag.String("cluster", envOr("SCOPE_CLUSTER", "cluster"), "cluster name shown on the island")
		source      = flag.String("source", "cluster", "data source: cluster (Substrate + ax); sim arrives in milestone 2")
		origins     = flag.String("allowed-origins", envOr("SCOPE_ALLOWED_ORIGINS", ""), "comma-separated extra host patterns allowed to open the event stream, e.g. *.cloudworkstations.dev (for proxies that rewrite Host)")
		webDir      = flag.String("web-dir", "", "serve the front end from this directory instead of the embedded copy (development)")

		subEndpoint  = flag.String("substrate-endpoint", "api.ate-system.svc.cluster.local:443", "Substrate control API host:port")
		subAuthority = flag.String("substrate-authority", "api.ate-system.svc", "TLS server name and :authority for the control API")
		subToken     = flag.String("substrate-token-file", "/var/run/secrets/ateapi/token", "bearer token file (projected SA token, audience api.ate-system.svc)")
		subCA        = flag.String("substrate-ca-file", "/run/servicedns-ca/trust-bundle.pem", "CA bundle for the control API (servicedns cluster trust bundle)")
		subInsecure  = flag.Bool("substrate-insecure-skip-verify", false, "skip TLS verification (development only)")

		axAddr     = flag.String("ax-endpoint", envOr("SCOPE_AX_ENDPOINT", "ax-server.ax-system.svc.cluster.local:8080"), "ax-server gRPC host:port; empty disables ax")
		routerAddr = flag.String("router", envOr("SCOPE_ROUTER", "atenet-router.ate-system.svc.cluster.local:80"), "atenet router host:port; empty disables runner status and attach")

		attachTokenFile = flag.String("attach-token-file", envOr("SCOPE_ATTACH_TOKEN_FILE", ""), "agent bearer token file; enables the attach proxy")

		actorEvery  = flag.Duration("actor-interval", 2*time.Second, "actor poll interval")
		workerEvery = flag.Duration("worker-interval", 10*time.Second, "worker poll interval")
		taskEvery   = flag.Duration("task-interval", 10*time.Second, "ax task poll interval")
	)
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *source != "cluster" {
		return fmt.Errorf("--source=%s is not supported yet (only cluster; the simulator is milestone 2)", *source)
	}

	sub, err := substrate.Dial(substrate.Options{
		Target:             *subEndpoint,
		Authority:          *subAuthority,
		TokenFile:          existing(*subToken),
		CAFile:             existing(*subCA),
		InsecureSkipVerify: *subInsecure,
	})
	if err != nil {
		return err
	}
	defer sub.Close()

	copts := cluster.Options{
		Substrate:      sub,
		ActorInterval:  *actorEvery,
		WorkerInterval: *workerEvery,
		TaskInterval:   *taskEvery,
	}
	if *axAddr != "" {
		axc, err := ax.Dial(*axAddr)
		if err != nil {
			return err
		}
		defer axc.Close()
		copts.AX = axc
	}
	var src collector.Source = cluster.New(copts)

	sopts := server.Options{Actors: sub, AllowedOrigins: splitList(*origins)}
	features := model.Features{}
	if *routerAddr != "" {
		rc := &router.Client{Addr: *routerAddr}
		sopts.Runner = rc
		features.RunnerStatus = true
		token := router.TokenSource(nil)
		switch {
		case existing(*attachTokenFile) != "":
			token = router.FileToken(*attachTokenFile)
		case os.Getenv("SCOPE_ATTACH_TOKEN") != "":
			token = router.StaticToken(os.Getenv("SCOPE_ATTACH_TOKEN"))
		}
		if token != nil {
			sopts.Attach = &router.Client{Addr: *routerAddr, HTTP: &http.Client{}}
			sopts.AttachToken = token
			features.Attach = true
		}
	}

	store := collector.NewStore(collector.Options{Cluster: *clusterName, Source: src.Name(), Features: features})
	sopts.Store = store
	if *webDir != "" {
		sopts.Web = os.DirFS(*webDir)
	} else {
		sopts.Web = web.FS()
	}
	if _, err := fs.Stat(sopts.Web, "index.html"); err != nil {
		return fmt.Errorf("front end has no index.html: %w", err)
	}

	go func() {
		if err := src.Run(ctx, store); err != nil && !errors.Is(err, context.Canceled) {
			slog.Error("source stopped", "error", err)
		}
	}()

	srv := &http.Server{Addr: *addr, Handler: server.New(sopts), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	slog.Info("substrate-scope listening", "addr", *addr, "cluster", *clusterName,
		"ax", *axAddr != "", "router", *routerAddr != "", "attach", features.Attach)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// existing returns path if the file exists, so the in-cluster defaults don't
// break a local run that passes its own flags.
func existing(path string) string {
	if path == "" {
		return ""
	}
	if _, err := os.Stat(path); err != nil {
		slog.Warn("file not found; continuing without it", "path", path)
		return ""
	}
	return path
}

// splitList splits a comma-separated flag value, dropping empty entries.
func splitList(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
