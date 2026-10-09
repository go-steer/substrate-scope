# substrate-scope design

**Status:** milestone 1 implemented (2026-10-08), with sessions opened in mast-web; milestones 2 to 4 open.

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

- **Events** are short animations on top: an arc from the island's atenet router to an agent when a request wakes it, a ripple when ax suspends an idle agent, a beam when a new task appears.
- **Router looks** (`?router=`, a picker in the header): **portal** (default), a standing ring at the island's back corner with a slow swirl inside (the Gemini Aurora on the Google themes) whose wakes leave as a stream of glowing particles; **lighthouse**, a squat tower whose beam turns slowly and snaps toward each agent it wakes; **core**, a floating crystal over the back of the island with three orbiting rings that spin faster as the wake rate rises; and **tower**, the original. Routers other than the tower grow with the island. The label keeps clear of the events panel.
- **Agent shapes** (`?agents=`, a picker in the header): **orb** (default), **spark** (a Gemini-style four-point star), **meeple**, **droid** and **box** (the original columns). Every shape is one low-poly geometry shared by the five per-state meshes, so a shape costs nothing extra in draw calls. Each state has a pose: running agents stand up (orbs lift off and bob, sparks spin, droids light their visor); suspended agents lie down flat, flatter-shaded and a little desaturated so running ones pop (meeples on their backs, sparks flat, orbs resting with a contact shadow, droids squat with the visor off); changing agents sit between and move (meeples wobble, the droid visor flickers); crashed agents tip over, show glowing cracks and flare. State colors stay the theme's validated colors.
- **Extras** for every shape, toggled with `x` or `?extras=0`: a bright cap and fresnel rim so running agents read as light sources, a soft light pool under running agents on dark themes, an idle ring at the agent's base that drains as its idle timer approaches suspend, and small rising particles over agents serving a request. They share the agents' instance buffers (one draw call each). The collector doesn't stream idle time or in-flight requests yet, so on a real cluster the rings and particles stay off; `?synthetic=N` fakes both.
- **Workers** are a row of pads along the island's edge. Every agent that holds a worker (running, resuming, suspending; suspended agents hold none) has a faint arc to its worker's pad with small dots flowing toward the worker; busier agents send more and faster dots (synthetic mode fakes "busy" until the collector streams in-flight requests). At rest the arcs stay quiet and get fainter as their number grows, so 5,000 agents don't turn into spaghetti; `x` and `prefers-reduced-motion` stop the dots and leave static arcs. Arcs and dots are computed on the GPU from per-link endpoints (one instanced draw each), so moving an agent rewrites six floats. Each pad shows its fill: a bar for its actor slots (allocated agents / capacity) and, when the worker reports them, bars for CPU and memory; a bar turns the theme's "full" color at 90%. Draining pads keep their glow color and a badge. Pad labels are quiet like agent labels: they show for the worker in focus, pads that aren't plainly active (draining), and every pad when the camera is close; they never overlap each other or other labels.
- **Which agents run where:** hovering or clicking a worker pad lights up its agents (the rest recede), brightens its arcs and fades the others, and grows the pad's label into a card: worker, node, number of agents, slots, CPU and memory allocated/capacity when known. Hovering or selecting an agent lights its worker's pad and gives its siblings on the same worker a subtle highlight; the side panel's Worker row has "show worker", which pins the worker and flies to it. Esc or a click on empty space clears it. A clicked pad stays pinned until then; hovering another pad shows that one meanwhile. The colors are theme tokens (`worker.highlight`, `links.highlight`, `links.flow`, `worker.fill`, `worker.full`, `worker.track`).
- **Group by worker** (`Group: atespace | worker` in the header, `g`, `?group=worker`, remembered): the island re-flows so each worker becomes a platform holding its agents, labeled with its name, node, agents/capacity and the atespaces it runs (biggest three). Platforms are all the same size, sized for the largest worker's actor capacity, so their fill compares at a glance; the room dots on a platform are its actor slots. Agents without a worker (suspended, pending, crashed) are parked in a "Not on a worker" area behind the platforms, in atespace order. In worker view every agent stands on a floor tile tinted by its atespace (a hue per atespace, matching the label chips), so "which team runs here" stays answerable. Agents glide between the two layouts (0.8 s, slightly staggered; instant above 20,000 agents or with reduced motion), and in worker view an agent that wakes or suspends glides to its worker or back to the parked area. Filters, selection and the focused worker carry over; the camera re-frames the island (or follows the selected agent).
- **Labels are quiet by default** ("auto"): the selected agent, agents that just changed state (for about six seconds, then they fade), and every agent near the camera only when it is zoomed in close on a district. Hovering shows a tooltip. A toggle (`l`) switches to all or off. District labels drop their state chips, then their count, when they are wider than their district on screen, and hide when they would overlap a bigger district's label.
- **Zoomed out**, a district collapses to one tile showing counts per state, so thousands of labels never render at once (milestone 2).

Clicking an agent opens a side panel: Substrate state, worker, template, snapshot; ax phase, conditions and reasons (`IdleSuspended`, `ResumedByRequest`, `CompletedSuspended`), idle policy and current idle time; and, for mast and core-agent agents, its sessions and an "Open in mast-web" button.

The live event feed is a collapsible panel on the left, newest on top, one color and icon per kind of event; clicking an event selects the agent and flies to it.

### Sessions in mast-web

The panel doesn't render transcripts itself; [mast-web](https://github.com/go-steer/mast-web) does. The collector serves a vendored, unmodified mast-web build per agent at `/mast-web/a/{atespace}/{name}/` and answers mast-web's bootstrap (`GET /config`) in proxy mode with `api_prefix=/api/agents/{atespace}/{name}/attach`. mast-web fetches `/config` from the origin root, so the root handler reads the agent from the `Referer` (same-origin, `Referrer-Policy: same-origin` on the mast-web pages); the per-agent `…/config` path answers too. mast-web then registers that one backend, skips its setup modal, and every request (list, events SSE, messages, interrupt, approvals) goes through the attach proxy, which adds `ate-target-actor` and the agent token.

- **Running agent:** "Open in mast-web" opens it in a new tab (a tab works through the Cloud Workstations port proxy and gives mast-web the whole window).
- **Not running:** "Wake agent…" asks for confirmation, then sends one `GET /sessions?scope_wake=1` through the proxy. "Open in mast-web" turns on once Substrate reports the agent RUNNING. mast lists only in-memory sessions, so the list after a wake is usually empty; the panel says why.
- **Identity:** there is no per-user identity behind the proxy. Everyone acts as the agent's operator with its shared token, and the panel says so. Per-user identity needs authentication in front of the UI (milestone 4) and mast-side ACLs keyed on it.
- **Idle:** an open mast-web session holds an SSE request open through ax's pass-through, so ax won't idle-suspend the agent while it is open.
- **Never wake:** the proxy forwards what the user does in mast-web; it is the explicit attach path, not a collector call. Without the wake consent it refuses (409) when Substrate doesn't report the agent RUNNING, re-checked with `GetActor` per request, so a stale mast-web tab can't wake an agent.

Search and filters (atespace, state, name prefix such as `lookout-`) dim everything that doesn't match.

## Collector

### Sources

| Source | Calls | Gives |
|---|---|---|
| Substrate control API (`api.ate-system.svc:443`, gRPC, TLS) | `ListAtespaces`, `ListActors` (per atespace, paginated), `ListWorkers`, `ListWorkerActorAssignments` | every actor, its state, worker, template, snapshots, crash info; every worker, its node, actor slots and CPU/memory capacity and allocation |
| ax API (`ax-server.ax-system.svc:8080`, gRPC) | list tasks per atespace | task phase, conditions, idle policy, which actors are ax tasks |
| ax runner status, via the atenet router with `ate-target-actor` | `GET /metadata/v1alpha1/ax/status`, **running actors only**, and only for the agents in view or selected | idle seconds, in-flight requests, busy, exit |
| Agent session API, via the router | `GET /sessions`, **running actors only**, on demand | session list (listing does not count as activity in mast) |

Substrate has no watch API, so the collector polls (default every 2s for actors, 10s for workers and tasks), diffs against the previous picture, and turns the difference into events. Per-agent detail is polled more slowly and only on demand.

### Events and API

- `GET /api/snapshot`: the whole picture (clusters, atespaces, agents, workers) with a sequence number.
- `GET /api/stream` (WebSocket): the snapshot, then events with increasing sequence numbers: `agent_added`, `agent_removed`, `agent_state` (from/to), `agent_woke` (suspended → running without an explicit resume, ax reason `ResumedByRequest`), `agent_suspended` (with reason), `agent_crashed`, `worker_assignment`, `task_updated`. A client that falls behind gets a fresh snapshot.
- `GET /api/agents/{atespace}/{name}`: details for the side panel.
- `/api/agents/{atespace}/{name}/attach/...`: optional reverse proxy to the agent's session API through the router (adds `ate-target-actor`, and the agent bearer token from a Secret). Off unless configured; requests through it can wake the agent, so it refuses unless the agent is running or the request carries `scope_wake=1`.
- `/mast-web/a/{atespace}/{name}/...` and `GET /config`: mast-web attached to one agent (see Sessions in mast-web).
- The collector serves the front end itself (`go:embed`), so one container is the whole thing.

### Identity and permissions

The collector runs as its own service account and authenticates to Substrate with a projected token for audience `api.ate-system.svc`, trusting the servicedns CA bundle (the same mechanism ax-server uses).

On Substrate v0.3.0 authorization only covers atespace calls; every other call is open to any authenticated caller. So the collector's safety comes from its code: it calls only list and get methods, and a test checks it never references a mutating RPC. Substrate's authorization model already has a global **viewer** role that would grant exactly what the collector needs; grant it once actor calls are enforced.

## Simulator

`--source=sim --agents=N` replaces the Substrate and ax pollers with a generator that creates atespaces and agents and walks them through realistic transitions (bursts of incidents, idle suspends, wakes, occasional crashes). It feeds the same diff and event pipeline, so the front end can't tell the difference. It's how milestone 2 proves 10k agents at 60fps on a laptop GPU, and it makes the UI demoable without a cluster.

## Front end

- `web/` holds plain ES modules plus a vendored three.js build (`web/vendor/three/`), embedded into the binary.
- Rendering: one `InstancedMesh` per state class (one shared geometry per agent shape, `web/js/shapes.js`), per-instance pose and color in instance attributes, one shader (`web/js/agents.js`) for glow, pulse, rim, the shape's motion (bob, spin, wobble, visor) and cracks. Switching shapes disposes the old layers and builds new ones; routers live in `web/js/routers.js`. Moving an agent between states only rewrites its instance slot. Instances are picked with three.js raycasting against the instanced meshes.
- Layout is computed client-side from the snapshot (squarified districts, then a grid inside each), and re-flowed only when atespaces grow past their district. The worker view's plan is in `web/js/workers.js` (with the highlight rules and usage math, all pure and unit tested); the ground for either plan is built by `web/js/island.js`, the pads by `web/js/pads.js` and the flowing links by `web/js/links.js`. Switching the grouping reuses the agent layers and link buffers and disposes the old ground.
- Camera: orbit, pan and zoom (`OrbitControls`), with a "fly to" for search results and selection.
- Level of detail: district tiles beyond a zoom threshold (milestone 2); agent labels as described above, placed greedily in screen space so they never overlap.
- `?synthetic=N` swaps the collector stream for N generated agents in the browser, until the collector's simulator exists. It needs no collector at all: the panel's agent details are generated too, so any static file server can serve `web/` for design work.
- `?theme=<id>` picks a theme (`web/js/themes.js`: one data object per theme for the scene, lights, bloom and the page's CSS variables); `?tour=1` cycles through them, `?tour=shapes` also steps the agent shape and router look. `?router=` and `?agents=` pick the router look and agent shape; all three are remembered in localStorage and switch live.
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
