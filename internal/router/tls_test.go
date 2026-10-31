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

package router

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-steer/purser/authtest"
)

const scopeID = "spiffe://cluster.local/ns/substrate-scope/sa/substrate-scope"

// fakeIngress stands in for atenet-router's HTTPS ingress: a TLS listener
// with a servicedns-style certificate (DNS SAN only) that requires a client
// certificate from the podidentity CA and admits listed SPIFFE IDs only,
// matched exactly, as --ingress-allowed-spiffe-ids does.
type fakeIngress struct {
	srv *httptest.Server

	mu      sync.Mutex
	callers []string // SPIFFE ID of each request's client certificate
	reqs    []*http.Request
}

func newFakeIngress(t *testing.T, serverCA, clientCA *authtest.CA, serverName string, allowed ...string) *fakeIngress {
	t.Helper()
	f := &fakeIngress{}
	serverCert := serverCA.Issue(t, authtest.LeafOptions{DNSSANs: []string{serverName}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
	f.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := ""
		if len(r.TLS.PeerCertificates) > 0 && len(r.TLS.PeerCertificates[0].URIs) == 1 {
			id = r.TLS.PeerCertificates[0].URIs[0].String()
		}
		ok := false
		for _, a := range allowed {
			ok = ok || a == id
		}
		f.mu.Lock()
		f.callers = append(f.callers, id)
		f.reqs = append(f.reqs, r.Clone(context.Background()))
		f.mu.Unlock()
		if !ok {
			http.Error(w, "SPIFFE ID not allowed", http.StatusForbidden)
			return
		}
		if r.URL.Path == StatusPath {
			_ = json.NewEncoder(w).Encode(RunnerStatus{IdleSeconds: 7, InFlight: 1})
			return
		}
		_, _ = io.WriteString(w, "actor "+r.Header.Get(TargetHeader)+" "+r.URL.Path)
	}))
	f.srv.TLS = &tls.Config{
		Certificates: []tls.Certificate{serverCert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    clientCA.Pool(),
		MinVersion:   tls.VersionTLS12,
	}
	f.srv.StartTLS()
	t.Cleanup(f.srv.Close)
	return f
}

// addr is the listener's host:port (127.0.0.1:N), which is not the name on
// its certificate, as when dialing the router's .svc.cluster.local name.
func (f *fakeIngress) addr() string { return strings.TrimPrefix(f.srv.URL, "https://") }

func (f *fakeIngress) lastCaller() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.callers) == 0 {
		return ""
	}
	return f.callers[len(f.callers)-1]
}

// writeBundle writes cert as a podCertificate credential bundle: one PKCS#8
// PRIVATE KEY block, then the chain, leaf first. It replaces the file the
// way the kubelet does (write elsewhere, rename over).
func writeBundle(t *testing.T, path string, cert tls.Certificate) {
	t.Helper()
	key, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	out := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key})
	for _, der := range cert.Certificate {
		out = append(out, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})...)
	}
	writeAtomic(t, path, out)
}

func writeCA(t *testing.T, path string, cas ...*authtest.CA) {
	t.Helper()
	var out []byte
	for _, ca := range cas {
		out = append(out, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.Cert().Raw})...)
	}
	writeAtomic(t, path, out)
}

func writeAtomic(t *testing.T, path string, data []byte) {
	t.Helper()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}
}

type pki struct {
	serverCA, clientCA *authtest.CA
	certFile, caFile   string
}

func newPKI(t *testing.T) *pki {
	t.Helper()
	dir := t.TempDir()
	p := &pki{
		serverCA: authtest.NewCA(t, "servicedns"),
		clientCA: authtest.NewCA(t, "podidentity"),
		certFile: filepath.Join(dir, "credential-bundle.pem"),
		caFile:   filepath.Join(dir, "trust-bundle.pem"),
	}
	writeBundle(t, p.certFile, p.clientCA.Issue(t, authtest.LeafOptions{URISANs: []string{scopeID}}))
	writeCA(t, p.caFile, p.serverCA)
	return p
}

func (p *pki) client(t *testing.T, addr string, reload time.Duration) *Client {
	t.Helper()
	tr, stop, err := NewTLSTransport(TLSOptions{CertFile: p.certFile, CAFile: p.caFile, ServerName: DefaultServerName, ReloadInterval: reload})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(stop)
	return &Client{Addr: addr, Transport: tr}
}

func TestRunnerStatusOverMTLS(t *testing.T) {
	p := newPKI(t)
	ing := newFakeIngress(t, p.serverCA, p.clientCA, DefaultServerName, scopeID)
	c := p.client(t, ing.addr(), 0)
	if got := c.BaseURL(); got != "https://"+ing.addr() {
		t.Fatalf("BaseURL = %q, want https", got)
	}
	st, err := c.RunnerStatus(context.Background(), "cred-test", "run")
	if err != nil {
		t.Fatal(err)
	}
	if st.IdleSeconds != 7 || st.InFlight != 1 {
		t.Fatalf("status = %+v", st)
	}
	if got := ing.lastCaller(); got != scopeID {
		t.Fatalf("router saw client %q, want %q", got, scopeID)
	}
	if got := ing.reqs[0].Header.Get(TargetHeader); got != "cred-test/run" {
		t.Fatalf("%s = %q", TargetHeader, got)
	}
}

func TestAttachProxyOverMTLS(t *testing.T) {
	p := newPKI(t)
	ing := newFakeIngress(t, p.serverCA, p.clientCA, DefaultServerName, scopeID)
	c := p.client(t, ing.addr(), 0)
	h := c.AttachProxy(StaticToken("agent-token"), func(*http.Request) (string, string) { return "cred-test/run", "/sessions" })
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/agents/cred-test/run/attach/sessions", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "actor cred-test/run /sessions" {
		t.Fatalf("attach = %d %q", rec.Code, rec.Body.String())
	}
	if got := ing.reqs[0].Header.Get("Authorization"); got != "Bearer agent-token" {
		t.Fatalf("Authorization = %q", got)
	}
	if ing.reqs[0].Host != ing.addr() {
		t.Fatalf("Host = %q", ing.reqs[0].Host)
	}
}

// A certificate that chains to the trusted CA but carries another
// Service's name is not the router: the servicedns CA signs one for every
// Service in the cluster.
func TestRejectsOtherServiceName(t *testing.T) {
	p := newPKI(t)
	ing := newFakeIngress(t, p.serverCA, p.clientCA, "evil.default.svc", scopeID)
	c := p.client(t, ing.addr(), 0)
	_, err := c.RunnerStatus(context.Background(), "a", "b")
	if err == nil || !strings.Contains(err.Error(), DefaultServerName) {
		t.Fatalf("err = %v, want a name mismatch for %s", err, DefaultServerName)
	}
	if got := ing.lastCaller(); got != "" {
		t.Fatalf("request reached the impostor as %q", got)
	}
}

func TestRejectsUntrustedServer(t *testing.T) {
	p := newPKI(t)
	other := authtest.NewCA(t, "other")
	ing := newFakeIngress(t, other, p.clientCA, DefaultServerName, scopeID)
	c := p.client(t, ing.addr(), 0)
	var uerr x509.UnknownAuthorityError
	if _, err := c.RunnerStatus(context.Background(), "a", "b"); !errors.As(err, &uerr) && (err == nil || !strings.Contains(err.Error(), "unknown authority")) {
		t.Fatalf("err = %v, want unknown authority", err)
	}
}

// The router refuses a client whose SPIFFE ID is not in its allowlist; the
// caller sees the router's 403, not a TLS failure.
func TestNotAllowlisted(t *testing.T) {
	p := newPKI(t)
	ing := newFakeIngress(t, p.serverCA, p.clientCA, DefaultServerName, "spiffe://cluster.local/ns/ax-system/sa/ax-server")
	c := p.client(t, ing.addr(), 0)
	_, err := c.RunnerStatus(context.Background(), "a", "b")
	if err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("err = %v, want 403", err)
	}
	if got := ing.lastCaller(); got != scopeID {
		t.Fatalf("router saw %q", got)
	}
}

// The kubelet rotates the pod certificate in place, and the servicedns CA
// rotates by publishing a new bundle. New connections pick both up without
// a restart.
func TestRotation(t *testing.T) {
	p := newPKI(t)
	newServerCA := authtest.NewCA(t, "servicedns-2")
	ing := newFakeIngress(t, p.serverCA, p.clientCA, DefaultServerName, scopeID, "spiffe://cluster.local/ns/substrate-scope/sa/rotated")
	c := p.client(t, ing.addr(), 20*time.Millisecond)
	if _, err := c.RunnerStatus(context.Background(), "a", "b"); err != nil {
		t.Fatal(err)
	}

	// Rotate the client certificate (same CA, new leaf, so it is visible
	// which one was presented).
	writeBundle(t, p.certFile, p.clientCA.Issue(t, authtest.LeafOptions{URISANs: []string{"spiffe://cluster.local/ns/substrate-scope/sa/rotated"}}))
	waitFor(t, func() bool {
		c.Transport.(*http.Transport).CloseIdleConnections()
		_, err := c.RunnerStatus(context.Background(), "a", "b")
		return err == nil && ing.lastCaller() == "spiffe://cluster.local/ns/substrate-scope/sa/rotated"
	})

	// Rotate the server's CA: a router serving a certificate from the new
	// CA is refused until the trust bundle carries it, then accepted.
	ing2 := newFakeIngress(t, newServerCA, p.clientCA, DefaultServerName, "spiffe://cluster.local/ns/substrate-scope/sa/rotated")
	c2 := &Client{Addr: ing2.addr(), Transport: c.Transport}
	if _, err := c2.RunnerStatus(context.Background(), "a", "b"); err == nil {
		t.Fatal("server from a CA not yet in the bundle was accepted")
	}
	writeCA(t, p.caFile, p.serverCA, newServerCA)
	waitFor(t, func() bool {
		_, err := c2.RunnerStatus(context.Background(), "a", "b")
		return err == nil
	})
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met within 5s")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// An explicit http:// URL dials plain HTTP, for a stand-in in development.
func TestPlainHTTPForDev(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(RunnerStatus{IdleSeconds: 3})
	}))
	t.Cleanup(srv.Close)
	c := &Client{Addr: srv.URL}
	if !c.Plaintext() || c.BaseURL() != srv.URL {
		t.Fatalf("plaintext %v, base %q", c.Plaintext(), c.BaseURL())
	}
	st, err := c.RunnerStatus(context.Background(), "a", "b")
	if err != nil || st.IdleSeconds != 3 {
		t.Fatalf("status %+v, err %v", st, err)
	}
	if (&Client{Addr: DefaultAddr}).Plaintext() || (&Client{Addr: "https://x:443"}).Plaintext() {
		t.Fatal("host:port and https:// must not be plaintext")
	}
}

func TestNewTLSTransportErrors(t *testing.T) {
	p := newPKI(t)
	for name, o := range map[string]TLSOptions{
		"no cert":        {CAFile: p.caFile, ServerName: DefaultServerName},
		"no CA":          {CertFile: p.certFile, ServerName: DefaultServerName},
		"no server name": {CertFile: p.certFile, CAFile: p.caFile},
		"missing cert":   {CertFile: p.certFile + ".missing", CAFile: p.caFile, ServerName: DefaultServerName},
		"missing CA":     {CertFile: p.certFile, CAFile: p.caFile + ".missing", ServerName: DefaultServerName},
		"cert as CA":     {CertFile: p.caFile, CAFile: p.caFile, ServerName: DefaultServerName},
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := NewTLSTransport(o); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}
