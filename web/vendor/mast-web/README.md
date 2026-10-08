# mast-web (vendored)

[mast-web](https://github.com/go-steer/mast-web) at `v0.5.0-6-ga000c8f` (`a000c8f0cfe3fe22bceda5177c6c5c3aa1fc2b03`), Apache-2.0
(see LICENSE). Its `web/` directory as-is, minus tests. Served by the collector at
`/mast-web/a/{atespace}/{name}/`, attached to that agent; see "Sessions in mast-web"
in the repository README.

Don't edit these files. Refresh with `make vendor-mast-web MAST_WEB_REF=<ref>`.
