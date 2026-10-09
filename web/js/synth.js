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
/** The last worker is draining: it keeps its agents but gets no new ones. */
const DRAINING = WORKERS - 1;

/** States that hold a worker (running, and on their way in or out). */
const HOLDS_WORKER = new Set(['RUNNING', 'RESUMING', 'SUSPENDING']);

/** What one agent requests: 250m to 1 CPU and 0.5 to 2 GiB, fixed per agent. */
export function agentRequest(key) {
  let h = 7;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const cpu = [0.25, 0.5, 0.5, 1][h % 4];
  return { cpu, memory: cpu * 2 * 2 ** 30 };
}

/**
 * Workers sized for n agents: about a tenth of agents hold a worker at a
 * time; each worker gets 1.4x to 2.2x its share of actor slots, and CPU and
 * memory to match (4 GiB per core), so fills differ from worker to worker.
 */
export function syntheticWorkers(n, r, { workerCap = 0 } = {}) {
  const share = Math.max(4, (n * 0.1) / WORKERS);
  return Array.from({ length: WORKERS }, (_, i) => {
    const sized = Math.max(8, Math.round(share * (1.4 + r() * 0.8)));
    // workerCap: every worker reports this many actor slots (real Substrate
    // workers say 1000), whatever they host; CPU and memory stay sized.
    const capacityActors = workerCap > 0 ? workerCap : sized;
    const cores = Math.max(4, Math.ceil((sized * 0.5) / 4) * 4);
    return {
      name: `w-${i}`,
      pod: `wk-${String(i).padStart(2, '0')}`,
      node: `gke-pool-${i % 4}-${(0x3a1f + i * 977).toString(16)}`,
      pool: 'default',
      state: i === DRAINING ? 'DRAINING' : 'ACTIVE',
      capacityActors,
      capacityCpu: String(cores),
      capacityMemory: `${cores * 4}Gi`,
    };
  });
}

/** Picks a worker for an agent: weighted by free slots, never the draining one. */
function pickWorker(r, workers, load) {
  const free = workers.map((w, i) => (i === DRAINING ? 0 : Math.max(0.5, w.capacityActors - (load.get(w.name) || 0))));
  let x = r() * free.reduce((a, b) => a + b, 0);
  for (let i = 0; i < workers.length; i++) {
    x -= free[i];
    if (x <= 0) return workers[i].name;
  }
  return workers[0].name;
}

/**
 * Fills in each worker's allocated slots, CPU and memory from the agents it
 * holds. With resources false, CPU and memory allocation are left out, as
 * real Substrate reports them while ax tasks declare no limits.
 */
export function allocate(workers, agents, resources = true) {
  const use = new Map(workers.map((w) => [w.name, { n: 0, cpu: 0, mem: 0 }]));
  for (const a of agents) {
    const u = a.worker && use.get(a.worker);
    if (!u) continue;
    const req = agentRequest(`${a.atespace}/${a.name}`);
    u.n++;
    u.cpu += req.cpu;
    u.mem += req.memory;
  }
  for (const w of workers) {
    const u = use.get(w.name);
    w.allocatedActors = u.n;
    if (!resources) {
      delete w.allocatedCpu;
      delete w.allocatedMemory;
      continue;
    }
    w.allocatedCpu = `${Math.round(u.cpu * 1000)}m`;
    w.allocatedMemory = `${Math.round(u.mem / 2 ** 20)}Mi`;
  }
  return workers;
}

const WORDS = ['payments', 'checkout', 'search', 'ingest', 'billing', 'triage', 'research', 'support', 'fraud', 'catalog', 'ml-eval', 'ops', 'docs', 'growth', 'risk', 'infra'];

/**
 * Options from the page URL: workercap=N (every worker reports N actor
 * slots, e.g. 1000 like real Substrate) and alloc=0 (workers report no CPU
 * or memory allocation, like real Substrate today).
 */
export function syntheticOptions(params) {
  return {
    workerCap: Math.max(0, Number(params.get('workercap')) || 0),
    resources: params.get('alloc') !== '0',
  };
}

/**
 * Builds a snapshot with n agents spread over atespaces of very different
 * sizes (roughly Zipf), mostly suspended, as a large Substrate cluster is.
 */
export function syntheticSnapshot(n, seed = 7, opts = {}) {
  const r = rng(seed);
  const spaces = Math.max(3, Math.min(WORDS.length, Math.round(Math.sqrt(n) / 5)));
  const weights = Array.from({ length: spaces }, (_, i) => 1 / (i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const now = Date.now();
  const agents = [];
  const atespaces = [];
  const workers = syntheticWorkers(n, rng(seed + 1), opts);
  const load = new Map();
  let made = 0;
  for (let i = 0; i < spaces; i++) {
    const name = WORDS[i];
    atespaces.push({ name });
    const count = i === spaces - 1 ? n - made : Math.round((weights[i] / total) * n);
    for (let j = 0; j < count; j++) {
      const x = r();
      const state = x < 0.08 ? 'RUNNING' : x < 0.09 ? 'CRASHED' : x < 0.1 ? 'RESUMING' : 'SUSPENDED';
      let worker;
      if (HOLDS_WORKER.has(state)) {
        // The draining worker still holds some agents from before it drained.
        worker = r() < 0.04 ? workers[DRAINING].name : pickWorker(r, workers, load);
        load.set(worker, (load.get(worker) || 0) + 1);
      }
      agents.push({
        atespace: name,
        name: `${name.slice(0, 4)}-agent-${String(j).padStart(4, '0')}`,
        state,
        stateSince: new Date(now - r() * 3600e3).toISOString(),
        createTime: new Date(now - 86400e3 - r() * 30 * 86400e3).toISOString(),
        template: `${name}-runner`,
        worker,
        task: syntheticTask(state, now - r() * 3600e3),
      });
    }
    made += count;
  }
  allocate(workers, agents, opts.resources !== false);
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
  const i = a.worker ? Number(a.worker.slice(2)) : -1;
  const worker = a.worker ? { name: a.worker, pod: `wk-${String(i).padStart(2, '0')}` } : null;
  const agent = {
    ...a,
    workerPod: worker?.pod,
    workerNode: worker && `gke-pool-${i % 4}-${(0x3a1f + i * 977).toString(16)}`,
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
  constructor(n, handlers, { every = 1500, ...opts } = {}) {
    this.h = handlers;
    this.opts = opts;
    this.snap = syntheticSnapshot(n, 7, opts);
    this.seq = this.snap.seq;
    this.r = rng(99);
    this.agents = new Map(this.snap.agents.map((a) => [`${a.atespace}/${a.name}`, a]));
    this.keys = [...this.agents.keys()];
    this.workers = this.snap.workers.map((w) => ({ ...w }));
    setTimeout(() => {
      this.h.onStatus('live');
      this.h.onSnapshot(this.snap, false);
    }, 0);
    this.timer = setInterval(() => this.churn(), every);
  }

  churn() {
    const events = [];
    const now = new Date().toISOString();
    const load = new Map();
    for (const a of this.agents.values()) if (a.worker) load.set(a.worker, (load.get(a.worker) || 0) + 1);
    const touched = new Set();
    for (let i = 0; i < 3; i++) {
      const key = this.keys[Math.floor(this.r() * this.keys.length)];
      const prev = this.agents.get(key);
      let to = prev.state === 'RUNNING' ? 'SUSPENDED' : 'RUNNING';
      if (this.r() < 0.05) to = 'CRASHED';
      const worker = to === 'RUNNING' ? pickWorker(this.r, this.workers, load) : undefined;
      if (prev.worker) touched.add(prev.worker);
      if (worker) {
        touched.add(worker);
        load.set(worker, (load.get(worker) || 0) + 1);
      }
      const agent = { ...prev, state: to, stateSince: now, task: syntheticTask(to, Date.now()), worker };
      this.agents.set(key, agent);
      const base = { key, agent, seq: ++this.seq };
      if (to === 'RUNNING') events.push({ ...base, type: 'agent_woke', reason: 'ResumedByRequest' });
      else if (to === 'SUSPENDED') events.push({ ...base, type: 'agent_suspended', reason: 'IdleSuspended' });
      else events.push({ ...base, type: 'agent_crashed', message: 'synthetic crash' });
    }
    // Workers report their new allocations.
    allocate(this.workers, this.agents.values(), this.opts.resources !== false);
    for (const w of this.workers) {
      if (touched.has(w.name)) events.push({ type: 'worker_updated', key: w.name, worker: { ...w }, seq: ++this.seq });
    }
    this.h.onEvents(events);
  }

  close() {
    clearInterval(this.timer);
  }
}
