# substrate-scope

A live 3D view of every agent on [Agent Substrate](https://github.com/agent-substrate/substrate): which agents are running, which are suspended, which just woke up or crashed, per cluster and per atespace. Agents that are [Agent Executor (ax)](https://github.com/google/ax) tasks show what ax knows too (phase, why they were suspended, idle time), and mast or core-agent agents can be opened in [mast-web](https://github.com/go-steer/mast-web).

Rendered with three.js and GPU instancing so a cluster with thousands of agents stays interactive. A small Go collector per cluster polls Substrate and ax, never wakes a suspended agent, and pushes changes to the browser.

**Status:** design. See [docs/design.md](docs/design.md).
