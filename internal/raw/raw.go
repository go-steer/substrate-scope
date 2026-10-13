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

// Package raw turns API objects into the plain JSON the panel shows as YAML,
// with sensitive values masked. The UI can be public and has no login, so
// nothing secret may leave the collector: masking happens here, never in the
// browser.
package raw

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// Mask replaces a masked value.
const Mask = "<redacted>"

// Proto converts m to JSON (protojson field names, as the APIs document them)
// and redacts it.
func Proto(m proto.Message) (any, error) {
	b, err := protojson.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("encoding %s: %w", m.ProtoReflect().Descriptor().FullName(), err)
	}
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, err
	}
	return Redact(v), nil
}

// secretKey matches field names whose string values are masked wherever they
// appear. Numbers and objects under them are kept: usage counts are named
// promptTokens, and a secretKey is a reference ({name, key}), not a secret.
var secretKey = regexp.MustCompile(`(?i)(token|secret|password|passwd|credential|api_?key|private_?key|authorization|cookie)`)

// userinfo matches credentials embedded in a URL (https://user:pass@host).
var userinfo = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s]+@`)

// Redact masks sensitive values in a decoded JSON value, in place, and
// returns it:
//   - string values under secret-looking keys (secretKey);
//   - env[].value (environment variables carry API keys; names are kept);
//   - files[].content (workspace files), replaced with their size;
//   - args anywhere under an "mcp" key (MCP server flags carry tokens);
//   - credentials embedded in URLs.
func Redact(v any) any {
	return redact(v, "", false)
}

func redact(v any, key string, mcp bool) any {
	switch t := v.(type) {
	case map[string]any:
		for k, c := range t {
			t[k] = redact(c, k, mcp || k == "mcp")
		}
		return t
	case []any:
		for i, c := range t {
			switch {
			case key == "env":
				if e, ok := c.(map[string]any); ok {
					if _, has := e["value"]; has {
						e["value"] = Mask
					}
				}
			case key == "files":
				if f, ok := c.(map[string]any); ok {
					if s, ok := f["content"].(string); ok {
						f["content"] = fmt.Sprintf("%s (%d bytes)", Mask, len(s))
					}
				}
			case key == "args" && mcp:
				if _, ok := c.(string); ok {
					t[i] = Mask
					continue
				}
			}
			t[i] = redact(t[i], key, mcp)
		}
		return t
	case string:
		if key != "" && secretKey.MatchString(key) {
			return Mask
		}
		if strings.Contains(t, "@") {
			return userinfo.ReplaceAllString(t, "${1}"+Mask+"@")
		}
		return t
	default:
		return v
	}
}
