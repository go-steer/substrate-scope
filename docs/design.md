# substrate-scope design

**Status:** milestone 1 implemented (2026-10-08); milestones 2 to 4 open.

substrate-scope shows every agent on [Agent Substrate](https://github.com/agent-substrate/substrate) as a live 3D scene: which agents are running, which are suspended, which just woke up or crashed, per cluster and per atespace. Where an agent is an [Agent Executor (ax)](https://github.com/google/ax) task, it adds what ax knows (phase, why it was suspended, idle time) and lets you open the agent's own session, for example a mast triage started by k8s-lookout.

The point is a picture you can read at a glance, in a demo or on a wall, that still works when a cluster runs thousands of agents.

## Decisions

| Question | Decision |
|---|---|
| Rendering | three.js in the browser, one `InstancedMesh` per agent state, custom shaders for glow and pulse. One draw call per state keeps 10–100k agents interactive. Plain ES modules, no bundler or framework (same style as mast-web). |
| Data | A Go **collector** per cluster polls Substrate's control API and ax's API, keeps the current picture in memory, and pushes changes to browsers over a WebSocket. |
| Never wake an agent | The collector only uses calls that can't wake an actor: Substrate list/get calls, ax list calls, and per-agent detail **only for actors Substrate reports as running**. Anything that would reach a suspended agent (opening its session) is an explicit user action, and the UI says it will wake the agent. |
| First milestone | The live demo on one cluster (agent-substrate): lookout incident → ax task → mast, with suspend, wake and crash animations and click-through details. Scale proof with a simulator comes second. |
| Multi-cluster | One collector per cluster. The UI connects to several collectors at once; a hub that merges them is deferred until it's needed. |
| Repo | `go-steer/substrate-scope`, Apache-2.0. Not tied to mast: any Substrate actor shows up; ax and mast add detail when present. |

## What the scene shows

- **Cluster** = an island (a ground plane with the cluster name).
- **Atespace** = a district on the island, sized by its number of agents and laid out in a squarified grid, so big atespaces get big districts.
- **Agent** = one instance in its district's grid. State drives color, height and motion:

| Substrate state | Look |
|---|---|
| RUNNING | full height, bright, slow breathing glow |
| SUSPENDED | flat, dim |
| SUSPENDING / RESUMING / … | animated between the two |
| CRASHED | red, pulsing |
| no worker / pending | outline only |

- **Events** are short animations on top: an arc from the island's "router" tower to an agent when a request wakes it, a ripple when ax suspends an idle agent, a beam when a new task appears.
- **Workers** are a row of pads along the island's edge; a running agent has a faint line to its worker, so a full pool is visible.
- **Zoomed out**, a district collapses to one tile showing counts per state, so thousands of labels never render at once. Zoomed in, agents get labels (task name, idle time).

Clicking an agent opens a side panel: Substrate state, worker, template, snapshot; ax phase, conditions and reasons (`IdleSuspended`, `ResumedByRequest`, `CompletedSuspended`), idle policy and current idle time; and, for mast and core-agent agents, its sessions with a link that opens the session in mast-web through the collector's attach proxy.

Search and filters (atespace, state, name prefix such as `lookout-`) dim everything that doesn't match.

## Collector

### Sources

| Source | Calls | Gives |
|---|---|---|
| Substrate control API (`api.ate-system.svc:443`, gRPC, TLS) | `ListAtespaces`, `ListActors` (per atespace, paginated), `ListWorkers`, `ListWorkerActorAssignments` | every actor, its state, worker, template, snapshots, crash info |
| ax API (`ax-server.ax-system.svc:8080`, gRPC) | list tasks per atespace | task phase, conditions, idle policy, which actors are ax tasks |
| ax runner status, via the atenet router with `ate-target-actor` | `GET /metadata/v1alpha1/ax/status`, **running actors only**, and only for the agents in view or selected | idle seconds, in-flight requests, busy, exit |
| Agent session API, via the router | `GET /sessions`, **running actors only**, on demand | session list (listing does not count as activity in mast) |

Substrate has no watch API, so the collector polls (default every 2s for actors, 10s for workers and tasks), diffs against the previous picture, and turns the difference into events. Per-agent detail is polled more slowly and only on demand.

### Events and API

- `GET /api/snapshot`: the whole picture (clusters, atespaces, agents, workers) with a sequence number.
- `GET /api/stream` (WebSocket): the snapshot, then events with increasing sequence numbers: `agent_added`, `agent_removed`, `agent_state` (from/to), `agent_woke` (suspended → running without an explicit resume, ax reason `ResumedByRequest`), `agent_suspended` (with reason), `agent_crashed`, `worker_assignment`, `task_updated`. A client that falls behind gets a fresh snapshot.
- `GET /api/agents/{atespace}/{name}`: details for the side panel.
- `/api/agents/{atespace}/{name}/attach/...`: optional reverse proxy to the agent's session API through the router (adds `ate-target-actor`, and the agent bearer token from a Secret). Off unless configured; requests through it can wake the agent.
- The collector serves the front end itself (`go:embed`), so one container is the whole thing.

### Identity and permissions

The collector runs as its own service account and authenticates to Substrate with a projected token for audience `api.ate-system.svc`, trusting the servicedns CA bundle (the same mechanism ax-server uses).

On Substrate v0.3.0 authorization only covers atespace calls; every other call is open to any authenticated caller. So the collector's safety comes from its code: it calls only list and get methods, and a test checks it never references a mutating RPC. Substrate's authorization model already has a global **viewer** role that would grant exactly what the collector needs; grant it once actor calls are enforced.

## Simulator

`--source=sim --agents=N` replaces the Substrate and ax pollers with a generator that creates atespaces and agents and walks them through realistic transitions (bursts of incidents, idle suspends, wakes, occasional crashes). It feeds the same diff and event pipeline, so the front end can't tell the difference. It's how milestone 2 proves 10k agents at 60fps on a laptop GPU, and it makes the UI demoable without a cluster.

## Front end

- `web/` holds plain ES modules plus a vendored three.js build (`web/vendor/three/`), embedded into the binary.
- Rendering: one `InstancedMesh` per state class (shared box geometry), per-instance color and height in instance attributes, a small shader for glow, pulse and transitions. Moving an agent between states only rewrites its instance slot. Instances are picked with three.js raycasting against the instanced meshes.
- Layout is computed client-side from the snapshot (squarified districts, then a grid inside each), and re-flowed only when atespaces grow past their district.
- Camera: orbit, pan and zoom (`OrbitControls`), with a "fly to" for search results and selection.
- Level of detail: district tiles beyond a zoom threshold, labels only for agents near the camera.
- The side panel and filters are HTML over the canvas.

## Deployment

`deploy/` has plain manifests: namespace `substrate-scope`, service account, deployment (projected Substrate token, CA bundle, ax and router addresses, optional agent-token Secret for the attach proxy), and a ClusterIP service. Access is `kubectl port-forward` for now.

## Milestones

1. **Live demo (one cluster):** Substrate + ax pollers, events over WebSocket, the scene with state colors and suspend/wake/crash animations, side panel, attach proxy into mast-web. Deployed on agent-substrate and shown with `demo-break.sh`-style incidents.
2. **Scale:** simulator, 10k agents at 60fps, district tiles, label culling, measured frame and memory budget.
3. **More clusters and history:** several collectors in one view, a short event history with a time scrubber.
4. **Integrations:** k8s-lookout incident overlay (which incident started which task), authentication in front of the UI (IAP or OIDC).

## Open questions

- How often can `ListActors` be polled on a large cluster before it bothers Substrate's API server? Paging and per-atespace polling help; a watch API upstream would be better (add to our Substrate asks if polling becomes a problem).
- The router-woke signal: ax records `ResumedByRequest` only on our fork (`task-idle-suspend`). Without it, the collector infers a wake from a state change it didn't see an explicit resume for.
