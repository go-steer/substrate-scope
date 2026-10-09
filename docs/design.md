# substrate-scope design

**Status:** milestone 1 implemented (2026-10-08), with sessions opened in mast-web; milestone 2's rendering half (100,000 agents and 2,000 workers in the browser, synthetic data) implemented 2026-10-09; the data path (simulator, binary protocol, watch API) and milestones 3 and 4 open.

substrate-scope shows every agent on [Agent Substrate](https://github.com/agent-substrate/substrate) as a live 3D scene: which agents are running, which are suspended, which just woke up or crashed, per cluster and per atespace. Where an agent is an [Agent Executor (ax)](https://github.com/google/ax) task, it adds what ax knows (phase, why it was suspended, idle time) and lets you open the agent's own session, for example a mast triage started by k8s-lookout.

The point is a picture you can read at a glance, in a demo or on a wall, that still works when a cluster runs thousands of agents.

## Decisions

| Question | Decision |
|---|---|
| Rendering | three.js in the browser with semantic zoom: far, one aggregate tile per district; mid, one point sprite per agent (one draw call for all); close, full shapes (one `InstancedMesh` per agent state) for the agents nearest the camera, up to a budget of 5,000. Custom shaders for glow, pulse and the crossfades. Plain ES modules, no bundler or framework (same style as mast-web). |
| Data | A Go **collector** per cluster polls Substrate's control API and ax's API, keeps the current picture in memory, and pushes changes to browsers over a WebSocket. |
| Never wake an agent | The collector only uses calls that can't wake an actor: Substrate list/get calls, ax list calls, and per-agent detail **only for actors Substrate reports as running**. Anything that would reach a suspended agent (opening its session) is an explicit user action, and the UI says it will wake the agent. |
| First milestone | The live demo on one cluster (agent-substrate): lookout incident → ax task → mast, with suspend, wake and crash animations and click-through details. Scale proof with a simulator comes second. |
| Multi-cluster | One collector per cluster. One cluster per panel: several clusters show as a panel per cluster, side by side, each its own scene and level of detail, not one merged scene (a merged island of several 100k-agent clusters would neither read nor render well). The UI connects to several collectors at once; a hub that merges them is deferred until it's needed. |
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
- **Workers** are a row of pads along the island's edge. Every agent that holds a worker (running, resuming, suspending; suspended agents hold none) has a faint arc to its worker's pad with small dots flowing toward the worker (in big clusters only the agents drawn as full shapes, the worker in focus and the selected or hovered agent have one: 10,000 arcs would be noise); busier agents send more and faster dots (synthetic mode fakes "busy" until the collector streams in-flight requests). At rest the arcs stay quiet and get fainter as their number grows, so 5,000 agents don't turn into spaghetti; `x` and `prefers-reduced-motion` stop the dots and leave static arcs. Arcs and dots are computed on the GPU from per-link endpoints (one instanced draw each), so moving an agent rewrites six floats. Each pad shows its fill: a bar for its actor slots (allocated agents / capacity) and, when the worker reports them, bars for CPU and memory; a bar turns the theme's "full" color at 90%. Draining pads keep their glow color and a badge. Pad labels are quiet like agent labels: they show for the worker in focus, pads that aren't plainly active (draining), and every pad when the camera is close; they never overlap each other or other labels.
- **Which agents run where:** hovering or clicking a worker pad lights up its agents (the rest recede), brightens its arcs and fades the others, and grows the pad's label into a card: worker, node, number of agents, slots, CPU and memory allocated/capacity when known. A resource the worker reports no allocation for (real Substrate today, because ax tasks declare no resource limits) reads "not reported" instead of an empty bar. Hovering or selecting an agent lights its worker's pad and gives its siblings on the same worker a subtle highlight; the side panel's Worker row has "show worker", which pins the worker and flies to it. Esc or a click on empty space clears it. A clicked pad stays pinned until then; hovering another pad shows that one meanwhile. The colors are theme tokens (`worker.highlight`, `links.highlight`, `links.flow`, `worker.fill`, `worker.full`, `worker.track`).
- **Group by worker** (`Group: atespace | worker` in the header, `g`, `?group=worker`, remembered): the island re-flows so each worker becomes a platform holding its agents, labeled with its name, node, agents/capacity and the atespaces it runs (biggest three). Platforms share one width and base depth, sized for the agents the 90th-percentile worker actually hosts (with a minimum and some headroom; a busier worker's platform gets extra rows), never for the workers' reported actor capacity: real Substrate workers report 1000 slots each, and sizing from that made huge platforms with the one agent a dot. Capacity shows as the label's agents/capacity and the pad's slots bar. The parked area is shaped to hold its agents comfortably (about 1.6:1, a spare row), never a thin strip. `?synthetic=25&workercap=1000&alloc=0` reproduces the real-cluster case. Platforms are grouped by node pool (a framed block with the pool's name, workers and agents) and, inside a pool, by node (a frame around the node's workers, when nodes hold several). Agents without a worker (suspended, pending, crashed) are parked in a "Not on a worker" area behind the platforms, in atespace order. In worker view every agent stands on a floor tile tinted by its atespace (a hue per atespace, matching the label chips), so "which team runs here" stays answerable. Agents glide between the two layouts (0.8 s, slightly staggered; instant above 20,000 agents or with reduced motion), and in worker view an agent that wakes or suspends glides to its worker or back to the parked area. Filters, selection and the focused worker carry over; the camera re-frames the island (or follows the selected agent).
- **Labels are quiet by default** ("auto"): the selected agent, agents that just changed state (for about six seconds, then they fade), and every agent near the camera only when it is zoomed in close on a district. Hovering shows a tooltip. A toggle (`l`) switches to all or off. District labels drop their state chips, then their count, when they are wider than their district on screen, and hide when they would overlap a bigger district's label.
- **Zoomed out**, a district collapses to one tile showing its agents' mix of states as a heat map (see Scale), and agent labels give way to district labels, so thousands of labels never render at once.

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
- Rendering: one `InstancedMesh` per state class (one shared geometry per agent shape, `web/js/shapes.js`), per-instance pose and color in instance attributes, one shader (`web/js/agents.js`) for glow, pulse, rim, the shape's motion (bob, spin, wobble, visor) and cracks. Switching shapes disposes the old layers and builds new ones; routers live in `web/js/routers.js`. Moving an agent between states only rewrites its instance slot, and only the written ranges upload (`web/js/dirty.js`). Picking walks the pointer's ray across the agent grid (`pickRay` in `web/js/lod.js`): a rectangle index finds the district under each step, the slot table maps the cell to its agent, and the candidates' bodies are tested against the ray. No per-instance raycasting, whatever the number of agents; worker pads are picked by ground point the same way.
- Layout is computed client-side from the snapshot (squarified districts, then a grid inside each). Adds, removes and state changes are slot operations (a min-heap of free slots per district); the island re-flows only when a district overflows or an atespace or worker comes or goes, and those re-plans are coalesced (at most one a second). The worker view's plan is in `web/js/workers.js` (with the highlight rules and usage math, all pure and unit tested); the ground for either plan is built by `web/js/island.js`, the pads by `web/js/pads.js` and the flowing links by `web/js/links.js`. Switching the grouping reuses the agent layers and link buffers and disposes the old ground.
- Camera: orbit, pan and zoom (`OrbitControls`), with a "fly to" for search results and selection.
- Level of detail: see Scale. Agent labels as described above, placed greedily in screen space so they never overlap (sizes estimated from the text, so label passes never force a layout).
- `?synthetic=N` swaps the collector stream for N generated agents in the browser, until the collector's simulator exists. It needs no collector at all: the panel's agent details are generated too, so any static file server can serve `web/` for design work.
- `?theme=<id>` picks a theme (`web/js/themes.js`: one data object per theme for the scene, lights, bloom and the page's CSS variables); `?tour=1` cycles through them, `?tour=shapes` also steps the agent shape and router look. `?router=` and `?agents=` pick the router look and agent shape; all three are remembered in localStorage and switch live.
- The side panel and filters are HTML over the canvas.

## Scale

Targets: one cluster per panel with **100,000 agents and 2,000 workers**, interactive at **60 fps on a MacBook Pro M3 Pro** and **at least 30 fps on an HP Dragonfly Chromebook** (Intel integrated GPU, ChromeOS Chrome, WebGL2). This is the browser half; the data path (simulator, binary protocol, Substrate watch API) is separate work.

**Levels of detail** (`web/js/lod.js`), chosen per pixel in the shaders from how big an agent cell is on screen, so the near side of a tilted island can be mid while the far side is far:

| Level | When | What is drawn |
|---|---|---|
| far | a cell under 2.5 px (crossfades up to 5 px) | one aggregate tile per atespace district (worker view: per node pool, and the parked area): a grid of cells colored in the district's mix of states, running cells breathing and crashed ones pulsing (`web/js/tiles.js`, one instanced draw). No agent objects; district labels only. |
| mid | otherwise | every agent is one point sprite (`web/js/points.js`, one draw call for all): sized to its cell, state color, glow, breath, crash pulse, a flash on every change; the sprite's outline hints at the agent shape (circle, star, meeple, droid, square); worker view tints its square by atespace. |
| close | cells over 11 px, nearest first | full shapes and extras (`web/js/agents.js`) for at most 5,000 agents (`?budget=`), picked a few times a second while the camera moves (linear-time nearest selection in the frustum), growing in as their points fade out. Agent labels only here (plus the selected agent and recent changes in view). |

Clusters with no more agents than the budget draw every agent as a shape, as before. Worker pads, their bars and glow are instanced (five draw calls for 2,000 pads), the ground is instanced (district tiles, outlines and room dots in a few draws, room dots fading where tiles take over), and big worker views lend a pool of 24 labels to the platforms in view instead of one per platform.

**CPU side:** per-district counts are kept incrementally (`Aggregates`), so district labels and far tiles never rescan agents; worker pads update one at a time; instance buffers upload only the ranges written (`DirtyRanges`, falling back to a full upload when that is cheaper); the event feed shows at most a few events per 0.4 s with a summary line, and the header refreshes four times a second; effects (ripples, wake arcs, shockwaves) play only in view and at most ten a second in big clusters, while every change still flashes its agent. `?quality=auto` (default) lowers the pixel ratio, then bloom, then the shape budget while frames take over 26 ms, and steps back up with headroom; `high` never lowers, `low` starts at pixel ratio 1 without bloom.

**Synthetic scale presets:** `?synthetic=10000|50000|100000&workers=200|1000|2000` generates node pools of 20 to 100 workers with 2 to 8 workers per node, about a tenth of agents running, and churn of 1% of agents per second (1,000 state changes a second at 100k; `&churn=N` sets it) whose running share stays steady.

**Measuring:** `?perf=1` (or `p`) shows FPS, frame ms (avg, p95), CPU ms, draw calls, triangles and points, geometries and textures, JS heap, instances per layer, the level of detail and the quality setting. Its Benchmark button (or `?bench=1`) flies a fixed 20 s path (6 s far orbit, 7 s mid pan, 7 s close circle, `web/js/bench.js`), then prints a per-phase summary with the GPU, browser and canvas size and copies it to the clipboard. `node hack/scale.mjs --url ...` drives the same path in headless Chromium against any build (it loads `bench.js` into the page), which is how the numbers below compare old and new code.

**Before and after** (2026-10-09; headless Chromium on SwiftShader, a CPU rasterizer, so only compare these numbers with each other: absolute frame rates on a real GPU are far higher). Same harness, same synthetic data (`?synthetic=N&workers=W` with the new generator in both builds), same 20 s path, browser warmed up first; "before" is `main` plus the worker-sizing fix, "after" this branch with `quality=high` (same pixel ratio, bloom and shape budget as before). fps per phase, then over the whole run.

1280x720:

| Agents / workers | Build | Load | fps far / mid / close (all) | p95 ms (all) | Draw calls (avg) | Triangles (avg) | JS heap |
|---|---|---|---|---|---|---|---|
| 5,000 / 12 | before | 0.7 s | 3.56 / 0.78 / 1.36 (1.99) | 1700 | 148 | 926k | 14 MB |
| 5,000 / 12 | after | 0.8 s | 4.44 / 0.66 / 1.34 (2.09) | 2000 | 50 | 927k | 15 MB |
| 10,000 / 2,000 | before | 11.0 s | 0.74 / 1.84 / 1.83 (1.40) | 3350 | 1,370 | 1.9M | 105 MB |
| 10,000 / 2,000 | after | 1.0 s | 5.00 / 0.79 / 2.07 (2.49) | 1483 | 42 | 218k | 24 MB |
| 50,000 / 2,000 | before | 21.4 s | 0.11 / 0.15 / 0.60 (0.27) | 8916 | 3,260 | 9.3M | 180 MB |
| 50,000 / 2,000 | after | 2.6 s | 1.22 / 1.52 / 1.97 (1.58) | 1750 | 50 | 381k | 56 MB |
| 100,000 / 2,000 | before | 35.2 s | 0.10 / 0.00 / 0.05 (0.08) | 19816 | 8,868 | 18.8M | 217 MB |
| 100,000 / 2,000 | after | 3.0 s | 1.12 / 1.61 / 1.15 (1.30) | 1817 | 53 | 421k | 91 MB |

320x180 (takes most of SwiftShader's fill and post-processing cost out, so what is left is geometry and the main thread):

| Agents / workers | Build | Load | fps far / mid / close (all) | p95 ms (all) | Draw calls (avg) | Triangles (avg) | JS heap |
|---|---|---|---|---|---|---|---|
| 5,000 / 12 | before | 0.7 s | 5.07 / 2.97 / 2.91 (3.60) | 683 | 122 | 926k | 18 MB |
| 5,000 / 12 | after | 0.8 s | 5.40 / 2.83 / 3.30 (3.81) | 867 | 52 | 927k | 16 MB |
| 10,000 / 2,000 | before | 8.3 s | 1.74 / 1.34 / 2.45 (1.84) | 1650 | 2,216 | 1.9M | 167 MB |
| 10,000 / 2,000 | after | 0.9 s | 6.48 / 3.52 / 3.09 (4.23) | 550 | 35 | 177k | 21 MB |
| 50,000 / 2,000 | before | 22.3 s | 0.32 / 0.12 / 0.93 (0.43) | 8316 | 4,428 | 9.3M | 173 MB |
| 50,000 / 2,000 | after | 2.2 s | 2.97 / 3.02 / 3.24 (3.09) | 583 | 41 | 185k | 59 MB |
| 100,000 / 2,000 | before | 26.5 s | 0.16 / 0.17 / 0.17 (0.17) | 6166 | 4,109 | 18.7M | 193 MB |
| 100,000 / 2,000 | after | 2.7 s | 2.09 / 3.50 / 2.73 (2.79) | 1067 | 37 | 177k | 90 MB |

At 100,000 agents a frame went from 18.8M triangles and about 8,900 draw calls to about 0.4M triangles and 50 draw calls, load from 35 s to 3 s, and the JS heap from 217 to 91 MB. Small clusters (5,000 agents, every agent a shape) are unchanged. On SwiftShader the after numbers sit near a floor set by fill and bloom (they barely move with the agent count), which is why the 320x180 run shows the difference better. The targets (60 fps on the M3 Pro, 30 fps on the Chromebook) can only be checked on those machines: run the benchmark there and compare.

Main-thread cost at 100,000 agents with 1,000 state changes a second (orbiting at mid distance): about 35 ms of scene work per second in total (applying events about 10 ms, re-selecting the close-up shapes 4 ms per pass, label passes 1 to 3 ms each), well under a millisecond per frame.

**Limits for now:**

- The frame-rate targets are unverified until the benchmark runs on the M3 Pro and the Chromebook; SwiftShader only shows relative gains.
- A re-plan (a district overflowing its reserved room, an atespace or worker coming or going, switching the grouping) re-places every agent: about 300 ms at 100,000 agents on this machine, at most once a second. Growing districts in place would remove it.
- The atespace view's pad area groups 2,000 pads by node pool but has no aggregate tile when far; the pads stay instanced pads (cheap, but small).
- In big clusters effects are budgeted: not every wake gets an arc, and only the newest ten state changes in close-up range get a label (every change still flashes its agent).
- The data path is unchanged: the snapshot and events are JSON over a WebSocket, and the collector polls Substrate. At 100,000 agents a snapshot is tens of megabytes; that is the next half of milestone 2.

## Deployment

`deploy/` has plain manifests: namespace `substrate-scope`, service account, deployment (projected Substrate token, CA bundle, ax and router addresses, optional agent-token Secret for the attach proxy), and a ClusterIP service. Access is `kubectl port-forward` for now.

## Milestones

1. **Live demo (one cluster):** Substrate + ax pollers, events over WebSocket, the scene with state colors and suspend/wake/crash animations, side panel, attach proxy into mast-web. Deployed on agent-substrate and shown with `demo-break.sh`-style incidents.
2. **Scale:** rendering done (100,000 agents and 2,000 workers, see Scale); still open: the collector's simulator, a binary protocol, and a Substrate watch API instead of polling.
3. **More clusters and history:** several collectors in one view, a short event history with a time scrubber.
4. **Integrations:** k8s-lookout incident overlay (which incident started which task), authentication in front of the UI (IAP or OIDC).

## Open questions

- How often can `ListActors` be polled on a large cluster before it bothers Substrate's API server? Paging and per-atespace polling help; a watch API upstream would be better (add to our Substrate asks if polling becomes a problem).
- The router-woke signal: ax records `ResumedByRequest` only on our fork (`task-idle-suspend`). Without it, the collector infers a wake from a state change it didn't see an explicit resume for.
