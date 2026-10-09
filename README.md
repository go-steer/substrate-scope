# substrate-scope

A live 3D view of every agent on [Agent Substrate](https://github.com/agent-substrate/substrate): which agents are running, which are suspended, which just woke up or crashed, per cluster and per atespace. Agents that are [Agent Executor (ax)](https://github.com/google/ax) tasks show what ax knows too (phase, why they were suspended, idle time), and agents that serve a session API (mast, core-agent) can be opened right from the view.

Rendered with three.js and GPU instancing so a cluster with thousands of agents stays interactive. A small Go collector per cluster polls Substrate and ax, never wakes a suspended agent, and pushes changes to the browser.

![Overview of a cluster](docs/images/overview.png)

**Status:** milestone 1 (live view of one cluster). See [docs/design.md](docs/design.md) for the design and what comes next.

## What you see

- The **island** is the cluster. Each **district** is an atespace, sized by how many agents it holds.
- Each **agent** is a column. Running agents stand tall and glow teal, suspended ones lie flat and dim, agents changing state are amber, crashed ones pulse red, and agents with no state yet are drawn as outlines.
- **Events** play as short animations: an arc from the router tower when a request wakes an agent, a ripple when an agent is suspended, a red shockwave when one crashes, a beam of light when a new task appears.
- **Worker pads** line the front of the island; a faint line connects each running agent to the worker that hosts it.
- Click an agent for the **side panel**: Substrate state, worker, template, snapshot; ax phase, conditions and reasons (`IdleSuspended`, `ResumedByRequest`, ...), the idle policy and, for running ax tasks, the live idle time. With the attach proxy configured you can list the agent's sessions and tail a session's events.
- **Filters** (atespace, state chips, name prefix) dim everything that doesn't match. `/` focuses the search, Enter flies to the first match, `h` shows the whole island, Esc closes the panel.

| A request wakes a suspended agent | The side panel: ax reasons and live idle time | A mast triage session, tailed through the attach proxy |
|---|---|---|
| ![Wake arc](docs/images/wake.png) | ![Side panel](docs/images/selected-agent.png) | ![Session tail](docs/images/session-tail.png) |

## Quickstart (in a cluster)

The collector runs as its own service account in namespace `substrate-scope`. It authenticates to Substrate's control API with a projected token for audience `api.ate-system.svc` and trusts the servicedns CA bundle, the same way ax-server does.

```sh
kubectl apply -f deploy/substrate-scope.yaml
kubectl -n substrate-scope port-forward svc/substrate-scope 8080:80
# open http://localhost:8080
```

Optional: let the UI open agents' sessions. Create a Secret with the bearer token the agents expect on their session API; the collector adds it, plus the router's `ate-target-actor` header, to requests through `/api/agents/{atespace}/{name}/attach/...`.

```sh
kubectl -n substrate-scope create secret generic substrate-scope-attach --from-file=token=PATH_TO_TOKEN
kubectl -n substrate-scope rollout restart deploy/substrate-scope
```

Flags (see `substrate-scope -h`): `--cluster` (name on the island), `--substrate-*` (endpoint, authority, token and CA files), `--ax-endpoint` (empty disables ax), `--router` (empty disables runner status and attach), `--attach-token-file`, and the poll intervals (`--actor-interval=2s`, `--worker-interval=10s`, `--task-interval=10s`).

## Never waking an agent

Looking must not change what you look at, so the collector:

- calls only Substrate's list and get RPCs and ax's `ListTasks`, which are answered from those services' own stores and never reach an actor. A test (`internal/substrate/nevermutate_test.go`) fails if any code refers to a mutating Substrate or ax RPC;
- reads an ax runner's status (`/metadata/v1alpha1/ax/status`, through the router) only for the agent selected in the UI, only if Substrate reports it `RUNNING`, and re-checks that with `GetActor` right before, because the router resumes a suspended actor to deliver any request;
- refuses attach requests to an agent that isn't running unless the request says it may wake it (`scope_wake=1`). The UI asks first and says so.

Requests through ax's pass-through (listing sessions, an open event tail) count as activity for ax's idle timer, so opening a running agent's sessions postpones its idle suspension.

## Development

```sh
make test          # Go and JS unit tests
make ci            # gofmt/goimports, vet, tests, JS syntax check + ESLint (npm ci first)
make run-local     # run the collector on your machine against $CONTEXT, serving web/ from disk
make push deploy   # build, push to IMAGE, pin the digest in deploy/, apply
```

`dev/run-local` port-forwards Substrate's API server, ax-server and the router, mints a short-lived token for the `substrate-scope` service account and fetches the CA bundle into `.dev/` (git-ignored).

The front end is plain ES modules in `web/` with a vendored three.js build (`web/vendor/three/`, see its README); there is no bundler. `node hack/screens.mjs --url ... --out DIR` takes screenshots with headless Chromium (WebGL on SwiftShader).

The ax API stubs in `internal/axapi` are generated from a pinned copy of ax.proto from the fork that adds idle suspension and task conditions; `make generate` regenerates them.

## Layout

| Path | What |
|---|---|
| `cmd/substrate-scope` | the collector binary |
| `internal/collector` | the store: merges poller updates, diffs, sequences events, fans out to subscribers; the `Source` interface (live cluster now, simulator in milestone 2) |
| `internal/cluster` | the live source: Substrate and ax pollers |
| `internal/model` | the picture (agents, workers, atespaces, tasks), events, and the diff |
| `internal/substrate`, `internal/ax` | read-only clients |
| `internal/router` | runner status and the attach reverse proxy, through the atenet router |
| `internal/server` | HTTP API and the embedded front end |
| `web/` | the front end |
| `deploy/` | Kubernetes manifests |

## License

Apache 2.0. three.js is MIT licensed (`web/vendor/three/LICENSE`).
