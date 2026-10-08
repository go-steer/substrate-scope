#!/usr/bin/env bash
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Refreshes web/vendor/mast-web/ from go-steer/mast-web at a pinned ref.
#
#   hack/vendor-mast-web.sh [REF]          # default: the ref in web/vendor/mast-web/VERSION
#   MAST_WEB_REPO=/path/to/clone hack/vendor-mast-web.sh main
#
# Copies mast-web's web/ directory as-is (no build step: it is plain JS),
# minus its tests, plus its LICENSE, and records the commit in VERSION.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
dest="$root/web/vendor/mast-web"
repo=${MAST_WEB_REPO:-https://github.com/go-steer/mast-web.git}
ref=${1:-}
if [ -z "$ref" ] && [ -f "$dest/VERSION" ]; then
  ref=$(sed -n 's/^commit: //p' "$dest/VERSION")
fi
ref=${ref:-main}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git clone --quiet "$repo" "$tmp/mast-web"
git -C "$tmp/mast-web" checkout --quiet "$ref"
commit=$(git -C "$tmp/mast-web" rev-parse HEAD)
describe=$(git -C "$tmp/mast-web" describe --tags --always)

rm -rf "$dest"
mkdir -p "$dest"
cp -R "$tmp/mast-web/web/." "$dest/"
find "$dest" -name '*.test.js' -delete
rm -rf "$dest/attach-core/conformance"
cp "$tmp/mast-web/LICENSE" "$dest/LICENSE"
cat >"$dest/VERSION" <<EOF
repo: https://github.com/go-steer/mast-web
commit: $commit
describe: $describe
EOF
cat >"$dest/README.md" <<README
# mast-web (vendored)

[mast-web](https://github.com/go-steer/mast-web) at \`$describe\` (\`$commit\`), Apache-2.0
(see LICENSE). Its \`web/\` directory as-is, minus tests. Served by the collector at
\`/mast-web/a/{atespace}/{name}/\`, attached to that agent; see "Sessions in mast-web"
in the repository README.

Don't edit these files. Refresh with \`make vendor-mast-web MAST_WEB_REF=<ref>\`.
README
echo "vendored mast-web $describe ($commit) into web/vendor/mast-web"
