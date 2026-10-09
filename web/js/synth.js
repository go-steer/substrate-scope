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

// A synthetic stream for looking at the scene at scale without a cluster:
// open the UI with ?synthetic=5000. It speaks the same interface as Stream
// (snapshot, then event batches), so nothing downstream can tell. This is a
// browser-only stand-in until the collector's simulator (milestone 2).

/** Small deterministic PRNG so a given N always lays out the same way. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const WORKERS = 12;
const workerOf = (r) => `w-${Math.floor(r() * WORKERS)}`;

const WORDS = ['payments', 'checkout', 'search', 'ingest', 'billing', 'triage', 'research', 'support', 'fraud', 'catalog', 'ml-eval', 'ops', 'docs', 'growth', 'risk', 'infra'];

/**
 * Builds a snapshot with n agents spread over atespaces of very different
 * sizes (roughly Zipf), mostly suspended, as a large Substrate cluster is.
 */
export function syntheticSnapshot(n, seed = 7) {
  const r = rng(seed);
  const spaces = Math.max(3, Math.min(WORDS.length, Math.round(Math.sqrt(n) / 5)));
  const weights = Array.from({ length: spaces }, (_, i) => 1 / (i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const now = Date.now();
  const agents = [];
  const atespaces = [];
  let made = 0;
  for (let i = 0; i < spaces; i++) {
    const name = WORDS[i];
    atespaces.push({ name });
    const count = i === spaces - 1 ? n - made : Math.round((weights[i] / total) * n);
    for (let j = 0; j < count; j++) {
      const x = r();
      const state = x < 0.08 ? 'RUNNING' : x < 0.09 ? 'CRASHED' : x < 0.1 ? 'RESUMING' : 'SUSPENDED';
      agents.push({
        atespace: name,
        name: `${name.slice(0, 4)}-agent-${String(j).padStart(4, '0')}`,
        state,
        stateSince: new Date(now - r() * 3600e3).toISOString(),
        createTime: new Date(now - 86400e3 - r() * 30 * 86400e3).toISOString(),
        template: `${name}-runner`,
        worker: state === 'RUNNING' ? workerOf(r) : undefined,
        task: syntheticTask(state, now - r() * 3600e3),
      });
    }
    made += count;
  }
  const workers = Array.from({ length: WORKERS }, (_, i) => ({ name: `w-${i}`, pod: `wk-${String(i).padStart(2, '0')}`, state: i === WORKERS - 1 ? 'DRAINING' : 'ACTIVE' }));
  return { cluster: `synthetic-${n}`, source: 'synthetic', seq: 1, features: { attach: true, mastWeb: true }, sources: [], atespaces, agents, workers };
}

function syntheticTask(state, at) {
  const time = new Date(at).toISOString();
  const ready = {
    RUNNING: { status: 'True', reason: 'ResumedByRequest' },
    CRASHED: { status: 'False', reason: 'Crashed', message: 'runner exited with code 137' },
    RESUMING: { status: 'False', reason: 'Resuming' },
  }[state] || { status: 'False', reason: 'IdleSuspended', message: 'idle for 10m0s' };
  return {
    phase: state === 'RUNNING' ? 'Running' : state === 'CRASHED' ? 'Failed' : 'Suspended',
    idleSuspendAfter: '10m',
    image: 'us-docker.pkg.dev/example/agents/runner@sha256:4f9c2a7d1e0b8c6a5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c',
    httpPort: 8080,
    workspaces: ['repo'],
    conditions: [
      { type: 'Ready', ...ready, lastTransitionTime: time },
      { type: 'Scheduled', status: 'True', reason: 'Placed', lastTransitionTime: time },
    ],
  };
}

/** The panel's agent detail for a synthetic agent (what the collector's API would say). */
export function syntheticDetail(a) {
  if (!a) return null;
  const r = rng([...a.name].reduce((h, c) => h * 31 + c.charCodeAt(0), 7));
  const running = a.state === 'RUNNING';
  const worker = running && a.worker ? { name: a.worker, pod: `wk-${a.worker.slice(2).padStart(2, '0')}` } : null;
  const agent = {
    ...a,
    workerPod: worker?.pod,
    workerNode: worker && `gke-pool-${Math.floor(r() * 4)}`,
    snapshotURI: running ? '' : `gs://snapshots/${a.atespace}/${a.name}/0042`,
    uid: `${Math.floor(r() * 1e8).toString(16)}-synthetic`,
    crash: a.state === 'CRASHED' ? { message: a.task?.conditions?.[0]?.message || 'synthetic crash', time: a.stateSince } : undefined,
  };
  return {
    agent,
    worker,
    runner: running ? { idleSeconds: Math.floor(r() * 420), inFlight: 0 } : null,
    runnerTime: new Date().toISOString(),
  };
}

/** Same interface as Stream, fed by syntheticSnapshot plus random churn. */
export class SyntheticStream {
  constructor(n, handlers, { every = 1500 } = {}) {
    this.h = handlers;
    this.snap = syntheticSnapshot(n);
    this.seq = this.snap.seq;
    this.r = rng(99);
    this.agents = new Map(this.snap.agents.map((a) => [`${a.atespace}/${a.name}`, a]));
    this.keys = [...this.agents.keys()];
    setTimeout(() => {
      this.h.onStatus('live');
      this.h.onSnapshot(this.snap, false);
    }, 0);
    this.timer = setInterval(() => this.churn(), every);
  }

  churn() {
    const events = [];
    const now = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      const key = this.keys[Math.floor(this.r() * this.keys.length)];
      const prev = this.agents.get(key);
      let to = prev.state === 'RUNNING' ? 'SUSPENDED' : 'RUNNING';
      if (this.r() < 0.05) to = 'CRASHED';
      const agent = { ...prev, state: to, stateSince: now, task: syntheticTask(to, Date.now()), worker: to === 'RUNNING' ? workerOf(this.r) : undefined };
      this.agents.set(key, agent);
      const base = { key, agent, seq: ++this.seq };
      if (to === 'RUNNING') events.push({ ...base, type: 'agent_woke', reason: 'ResumedByRequest' });
      else if (to === 'SUSPENDED') events.push({ ...base, type: 'agent_suspended', reason: 'IdleSuspended' });
      else events.push({ ...base, type: 'agent_crashed', message: 'synthetic crash' });
    }
    this.h.onEvents(events);
  }

  close() {
    clearInterval(this.timer);
  }
}
