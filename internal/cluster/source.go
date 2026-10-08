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

// Package cluster is the live collector.Source: it polls Agent Substrate's
// control API and ax's API on their own schedules and reports what it sees.
// Only list calls are made here; none of them reaches an actor.
package cluster

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"golang.org/x/sync/errgroup"

	"github.com/go-steer/substrate-scope/internal/collector"
	"github.com/go-steer/substrate-scope/internal/model"
	"github.com/go-steer/substrate-scope/internal/substrate"
)

// Poller names, as reported in the snapshot's sources.
const (
	PollerActors  = "substrate/actors"
	PollerWorkers = "substrate/workers"
	PollerTasks   = "ax/tasks"
)

// SubstrateLister is the part of the Substrate client the pollers use.
type SubstrateLister interface {
	ListAtespaces(ctx context.Context) ([]*ateapipb.Atespace, error)
	ListActors(ctx context.Context, atespace string) ([]*ateapipb.Actor, error)
	ListWorkers(ctx context.Context) ([]*ateapipb.Worker, error)
	ListWorkerActorAssignments(ctx context.Context, worker string) ([]*ateapipb.ActorAssignment, error)
}

// TaskLister is the part of the ax client the pollers use.
type TaskLister interface {
	ListTasks(ctx context.Context, atespace string) (map[string]model.Task, error)
}

// Options configures the pollers.
type Options struct {
	Substrate SubstrateLister
	// AX is optional; without it agents carry no task details.
	AX TaskLister
	// ActorInterval defaults to 2s, WorkerInterval and TaskInterval to 10s.
	ActorInterval  time.Duration
	WorkerInterval time.Duration
	TaskInterval   time.Duration
	// Timeout bounds one poll, default 15s.
	Timeout time.Duration
	// Parallel bounds concurrent per-atespace and per-worker calls, default 8.
	Parallel int
}

// Source is the live cluster source.
type Source struct {
	o Options

	mu         sync.Mutex
	atespaces  []string
	lastStates map[string]string
	kick       chan struct{}
}

// New returns a cluster source.
func New(o Options) *Source {
	if o.ActorInterval <= 0 {
		o.ActorInterval = 2 * time.Second
	}
	if o.WorkerInterval <= 0 {
		o.WorkerInterval = 10 * time.Second
	}
	if o.TaskInterval <= 0 {
		o.TaskInterval = 10 * time.Second
	}
	if o.Timeout <= 0 {
		o.Timeout = 15 * time.Second
	}
	if o.Parallel <= 0 {
		o.Parallel = 8
	}
	return &Source{o: o, lastStates: map[string]string{}, kick: make(chan struct{}, 1)}
}

// Name implements collector.Source.
func (s *Source) Name() string { return "cluster" }

// Run implements collector.Source.
func (s *Source) Run(ctx context.Context, sink collector.Sink) error {
	var wg sync.WaitGroup
	loop := func(every time.Duration, kick <-chan struct{}, poll func(context.Context) collector.Update) {
		defer wg.Done()
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			pctx, cancel := context.WithTimeout(ctx, s.o.Timeout)
			u := poll(pctx)
			cancel()
			if ctx.Err() != nil {
				return
			}
			if u.Err != nil {
				slog.Warn("poll failed", "poller", u.Poller, "error", u.Err)
			}
			sink.Apply(u)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			case <-kick:
			}
		}
	}
	wg.Add(2)
	go loop(s.o.ActorInterval, nil, s.PollActors)
	go loop(s.o.WorkerInterval, nil, s.PollWorkers)
	if s.o.AX != nil {
		wg.Add(1)
		go loop(s.o.TaskInterval, s.kick, s.PollTasks)
	}
	wg.Wait()
	return ctx.Err()
}

// PollActors lists atespaces and the actors in each.
func (s *Source) PollActors(ctx context.Context) collector.Update {
	u := collector.Update{Poller: PollerActors}
	list, err := s.o.Substrate.ListAtespaces(ctx)
	if err != nil {
		u.Err = err
		return u
	}
	u.Atespaces = make([]model.Atespace, 0, len(list))
	names := make([]string, 0, len(list))
	for _, a := range list {
		at := substrate.ToAtespace(a)
		u.Atespaces = append(u.Atespaces, at)
		names = append(names, at.Name)
	}

	var mu sync.Mutex
	u.Actors = make(map[string][]model.Agent, len(names))
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(s.o.Parallel)
	for _, as := range names {
		g.Go(func() error {
			actors, err := s.o.Substrate.ListActors(gctx, as)
			if err != nil {
				return err
			}
			agents := make([]model.Agent, 0, len(actors))
			for _, a := range actors {
				ag := substrate.ToAgent(a)
				if ag.Atespace == "" {
					ag.Atespace = as
				}
				agents = append(agents, ag)
			}
			mu.Lock()
			u.Actors[as] = agents
			mu.Unlock()
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		u = collector.Update{Poller: PollerActors, Err: err}
		return u
	}

	// Remember the atespaces for the task poller, and ask it for a fresh
	// look when an actor changed state: ax records why (IdleSuspended,
	// ResumedByRequest) right around the transition.
	changed := false
	states := map[string]string{}
	for _, agents := range u.Actors {
		for _, a := range agents {
			states[a.Key()] = a.State
		}
	}
	s.mu.Lock()
	s.atespaces = names
	if len(s.lastStates) == 0 {
		// First look: the task poller has been waiting for atespaces.
		changed = true
	} else {
		for k, st := range states {
			if old, ok := s.lastStates[k]; !ok || old != st {
				changed = true
				break
			}
		}
	}
	s.lastStates = states
	s.mu.Unlock()
	if changed {
		select {
		case s.kick <- struct{}{}:
		default:
		}
	}
	return u
}

// PollWorkers lists workers and their actor assignments.
func (s *Source) PollWorkers(ctx context.Context) collector.Update {
	u := collector.Update{Poller: PollerWorkers}
	list, err := s.o.Substrate.ListWorkers(ctx)
	if err != nil {
		u.Err = err
		return u
	}
	workers := make([]model.Worker, len(list))
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(s.o.Parallel)
	for i, w := range list {
		g.Go(func() error {
			as, err := s.o.Substrate.ListWorkerActorAssignments(gctx, w.GetMetadata().GetName())
			if err != nil {
				return err
			}
			workers[i] = substrate.ToWorker(w, as)
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		u.Err = err
		return u
	}
	u.Workers = workers
	return u
}

// PollTasks lists ax tasks in every atespace the actor poller has seen.
func (s *Source) PollTasks(ctx context.Context) collector.Update {
	u := collector.Update{Poller: PollerTasks}
	s.mu.Lock()
	names := append([]string(nil), s.atespaces...)
	s.mu.Unlock()
	var mu sync.Mutex
	u.Tasks = make(map[string]map[string]model.Task, len(names))
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(s.o.Parallel)
	for _, as := range names {
		g.Go(func() error {
			tasks, err := s.o.AX.ListTasks(gctx, as)
			if err != nil {
				return err
			}
			mu.Lock()
			u.Tasks[as] = tasks
			mu.Unlock()
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return collector.Update{Poller: PollerTasks, Err: err}
	}
	return u
}
