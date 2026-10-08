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

IMAGE ?= us-central1-docker.pkg.dev/gke-demos-345619/ax/substrate-scope
CONTEXT ?= agent-substrate

.PHONY: build test lint fmt fmt-check vet ci image push deploy run-local screens generate

build:
	go build -o bin/substrate-scope ./cmd/substrate-scope

test:
	go test ./...
	node --test web/js/*.test.js

vet:
	go vet ./...

fmt:
	gofmt -w $$(git ls-files '*.go')
	go run golang.org/x/tools/cmd/goimports@latest -w -local github.com/go-steer/substrate-scope $$(git ls-files '*.go')

# Fails if any Go file needs gofmt or goimports.
fmt-check:
	@out=$$(gofmt -l $$(git ls-files '*.go')); if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi
	@out=$$(go run golang.org/x/tools/cmd/goimports@latest -l -local github.com/go-steer/substrate-scope $$(git ls-files '*.go')); if [ -n "$$out" ]; then echo "goimports needed:"; echo "$$out"; exit 1; fi

# JS: ESLint (npm ci first) and a syntax check that needs only node.
lint:
	for f in web/js/*.js; do node --check "$$f" || exit 1; done
	npx eslint web hack

ci: fmt-check vet test lint

# Regenerate the ax API stubs (needs buf, protoc-gen-go, protoc-gen-go-grpc, goimports).
generate:
	go generate ./internal/axapi

image:
	docker build -t $(IMAGE):dev .

# Push and pin the pushed digest in deploy/substrate-scope.yaml.
push: image
	docker push $(IMAGE):dev
	@digest=$$(docker inspect --format='{{index .RepoDigests 0}}' $(IMAGE):dev | sed 's/.*@//'); \
	  sed -i "s#substrate-scope@sha256:[0-9a-f]*#substrate-scope@$$digest#" deploy/substrate-scope.yaml; \
	  echo "pinned $$digest"

deploy:
	kubectl --context $(CONTEXT) apply -f deploy/substrate-scope.yaml
	kubectl --context $(CONTEXT) -n substrate-scope rollout status deploy/substrate-scope

# Run the collector locally against CONTEXT (see dev/run-local).
run-local:
	CONTEXT=$(CONTEXT) dev/run-local

# Screenshot a running UI (default: a port-forward on :8080).
screens:
	node hack/screens.mjs --url http://localhost:8080/ --out docs/images --name overview
