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
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-steer/purser/authn/mtls"
	"github.com/go-steer/purser/client"
)

// Defaults for reaching the router over its HTTPS ingress (Substrate v0.6
// and later serve no plain HTTP).
const (
	// DefaultAddr is the router's HTTPS ingress. Requests on it route on
	// TargetHeader to the actor's port 80.
	DefaultAddr = "atenet-router.ate-system.svc.cluster.local:443"
	// DefaultServerName is the only name on the router's certificate, which
	// Substrate's servicedns signer issues for the Service.
	DefaultServerName = "atenet-router.ate-system.svc"
	// DefaultCertFile is the credential bundle of a podCertificate
	// projection from the podidentity signer: a PKCS#8 key, then the chain.
	DefaultCertFile = "/run/podidentity/credential-bundle.pem"
	// DefaultCAFile is the servicedns ClusterTrustBundle projection, which
	// the Substrate API client also trusts.
	DefaultCAFile = "/run/servicedns-ca/trust-bundle.pem"
)

// TLSOptions configures the router's mTLS client side.
type TLSOptions struct {
	// CertFile is the client credential bundle (PKCS#8 key, then the chain,
	// leaf first). Its leaf carries the collector's SPIFFE ID, which the
	// router must allow. The kubelet rotates it in place; it is re-read
	// every ReloadInterval and offered fresh on every handshake.
	CertFile string
	// CAFile is the PEM bundle the router's certificate must chain to, also
	// re-read every ReloadInterval.
	CAFile string
	// ServerName is verified against the router's certificate and sent as
	// SNI. It must not be empty: the servicedns CA issues certificates to
	// every Service in the cluster, so the name is what pins the router.
	ServerName string
	// ReloadInterval is how often the files are re-read; zero means 30s.
	ReloadInterval time.Duration
}

// NewTLSTransport returns an HTTP transport that dials the router with
// mutual TLS, and a function that stops re-reading the files.
func NewTLSTransport(o TLSOptions) (*http.Transport, func(), error) {
	switch {
	case o.CertFile == "":
		return nil, nil, errors.New("router mTLS: no client credential bundle (--router-cert-file)")
	case o.CAFile == "":
		return nil, nil, errors.New("router mTLS: no CA bundle (--router-ca-file)")
	case o.ServerName == "":
		return nil, nil, errors.New("router mTLS: no server name (--router-server-name)")
	}
	cert, err := mtls.NewCertificateFileSource(mtls.CertificateFileOptions{
		CredentialBundlePath: o.CertFile,
		ReloadInterval:       o.ReloadInterval,
		OnError: func(err error) {
			slog.Warn("router client certificate reload failed; keeping the previous one", "file", o.CertFile, "error", err)
		},
	})
	if err != nil {
		return nil, nil, fmt.Errorf("router mTLS: client certificate: %w", err)
	}
	roots, err := mtls.NewCertPoolFileSource(mtls.CertPoolFileOptions{
		Path:           o.CAFile,
		ReloadInterval: o.ReloadInterval,
		OnError: func(err error) {
			slog.Warn("router CA bundle reload failed; keeping the previous one", "file", o.CAFile, "error", err)
		},
	})
	if err != nil {
		_ = cert.Close()
		return nil, nil, fmt.Errorf("router mTLS: CA bundle: %w", err)
	}
	stop := func() {
		_ = cert.Close()
		_ = roots.Close()
	}
	cfg, err := client.NewPKI(client.PKIOptions{
		GetClientCertificate: cert.GetClientCertificate,
		RootCAsSource:        roots,
		ServerName:           o.ServerName,
	})
	if err != nil {
		stop()
		return nil, nil, fmt.Errorf("router mTLS: %w", err)
	}
	return client.Transport(cfg), stop, nil
}
