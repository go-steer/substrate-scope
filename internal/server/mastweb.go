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

package server

// mast-web, scoped to one agent.
//
//	GET /mast-web/a/{atespace}/{name}/…       the vendored mast-web SPA, unchanged
//	GET /mast-web/a/{atespace}/{name}/config  its bootstrap, for this agent
//	GET /config                               the same, for the agent named by Referer
//
// mast-web bootstraps from GET /config (cmd/mast-web-server/config_endpoint.go
// upstream). In "proxy" mode with an api_prefix it registers that prefix as
// its only daemon and skips the setup modal. We answer with the agent's
// attach proxy as the prefix, so the SPA talks to exactly one agent through
// /api/agents/{atespace}/{name}/attach/…, and the collector adds the agent
// token there; the browser never holds it.
//
// mast-web asks for /config at the origin root, not relative to the page, so
// the root handler works out the agent from the Referer (the SPA's own page,
// always same-origin; we also send Referrer-Policy: same-origin with the SPA
// so the full path is there). The per-agent path is answered too, for a
// mast-web that resolves /config relative to its page.

import (
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"path"
	"strings"
)

// MastWebPrefix is where mast-web is served, one copy per agent.
const MastWebPrefix = "/mast-web/a/"

// mastWebConfig is mast-web's GET /config body (configResponse upstream).
type mastWebConfig struct {
	Mode        string            `json:"mode"`
	APIPrefix   string            `json:"api_prefix"`
	Auth        mastWebAuth       `json:"auth"`
	MultiDaemon bool              `json:"multi_daemon"`
	Backends    []mastWebBackend  `json:"backends"`
	Scope       *mastWebScopeInfo `json:"substrate_scope,omitempty"`
}

type mastWebAuth struct {
	Mode          string `json:"mode"`
	Authenticated bool   `json:"authenticated"`
}

type mastWebBackend struct {
	Alias string `json:"alias"`
}

// mastWebScopeInfo is extra, ignored by mast-web: which agent this is.
type mastWebScopeInfo struct {
	Atespace string `json:"atespace"`
	Name     string `json:"name"`
}

// agentFromMastWebPath returns the agent and the path prefix in front of
// MastWebPrefix (non-empty when the UI sits under a path) from a request
// path such as /mast-web/a/cred-test/lookout-1/solo.html.
func agentFromMastWebPath(p string) (prefix, atespace, name string, ok bool) {
	i := strings.Index(p, MastWebPrefix)
	if i < 0 {
		return "", "", "", false
	}
	parts := strings.SplitN(p[i+len(MastWebPrefix):], "/", 3)
	if len(parts) < 3 {
		return "", "", "", false
	}
	as, err1 := url.PathUnescape(parts[0])
	n, err2 := url.PathUnescape(parts[1])
	if err1 != nil || err2 != nil || as == "" || n == "" {
		return "", "", "", false
	}
	return p[:i], as, n, true
}

func attachPrefix(prefix, atespace, name string) string {
	return prefix + "/api/agents/" + url.PathEscape(atespace) + "/" + url.PathEscape(name) + "/attach"
}

// mastWebConfigHandler answers mast-web's bootstrap. Without an agent it
// answers "static", which leaves mast-web on its setup modal.
func (s *Server) mastWebConfigHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Vary", "Referer")
	var prefix, as, name string
	ok := false
	if r.PathValue("atespace") != "" {
		as, name, ok = r.PathValue("atespace"), r.PathValue("name"), true
		prefix, _, _, _ = agentFromMastWebPath(r.URL.EscapedPath())
	} else if ref, err := url.Parse(r.Referer()); err == nil && r.Referer() != "" {
		prefix, as, name, ok = agentFromMastWebPath(ref.EscapedPath())
	}
	cfg := mastWebConfig{Mode: "static", Auth: mastWebAuth{Mode: "none"}, Backends: []mastWebBackend{}}
	if ok && s.o.Attach != nil {
		if _, known := s.o.Store.Agent(as, name); known {
			cfg.Mode = "proxy"
			cfg.APIPrefix = attachPrefix(prefix, as, name)
			cfg.Scope = &mastWebScopeInfo{Atespace: as, Name: name}
		}
	}
	writeJSON(w, http.StatusOK, cfg)
}

// mastWebFile serves the vendored mast-web for one agent.
func (s *Server) mastWebFile(w http.ResponseWriter, r *http.Request) {
	if s.o.MastWeb == nil || s.o.Attach == nil {
		http.Error(w, "mast-web is not available on this collector (it needs the attach proxy)", http.StatusNotFound)
		return
	}
	as, name := r.PathValue("atespace"), r.PathValue("name")
	if _, ok := s.o.Store.Agent(as, name); !ok {
		http.Error(w, "no such agent: "+as+"/"+name, http.StatusNotFound)
		return
	}
	file := r.PathValue("file")
	if file == "" {
		file = "index.html"
	}
	file = path.Clean(file)
	if strings.HasPrefix(file, "..") || !fs.ValidPath(file) {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	// mast-web's documents carry their own CSP. Make sure the bootstrap's
	// fetch of /config names this page, so the collector knows the agent.
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Cache-Control", "no-cache")
	f, err := s.o.MastWeb.Open(file)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		http.Error(w, "unreadable file", http.StatusInternalServerError)
		return
	}
	http.ServeContent(w, r, st.Name(), st.ModTime(), rs)
}

// mastWebRedirect adds the trailing slash mast-web's relative asset paths
// need. The Location is relative, so it works behind path-rewriting proxies.
func (s *Server) mastWebRedirect(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Location", url.PathEscape(r.PathValue("name"))+"/")
	w.WriteHeader(http.StatusMovedPermanently)
}
