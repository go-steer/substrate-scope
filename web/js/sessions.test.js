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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiBase, mastWebURL, sessionLine, emptySessionsNote, attachError } from './sessions.js';

test('paths are relative and escaped', () => {
  assert.equal(apiBase('cred-test/lookout-1'), 'api/agents/cred-test/lookout-1');
  assert.equal(mastWebURL('cred-test/a b'), 'mast-web/a/cred-test/a%20b/');
});

test('sessionLine shows title and last activity', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const l = sessionLine({ sessionID: 'incident-1', title: 'checkout crash', status: 'idle', last_touched_at: '2026-10-08T11:57:00Z' }, now);
  assert.deepEqual(l, { id: 'incident-1', title: 'checkout crash', status: 'idle', when: 'last activity 3m 00s ago' });
  assert.equal(sessionLine({ id: 'x', title: 'x' }, now).title, '');
});

test('empty list after a wake explains in-memory listing', () => {
  assert.match(emptySessionsNote(true), /in memory/);
  assert.match(emptySessionsNote(true), /woken/);
  assert.doesNotMatch(emptySessionsNote(false), /woken/);
});

test('attachError recognises the wake refusal', () => {
  const e = attachError(409, JSON.stringify({ error: 'agent is SUSPENDED', state: 'SUSPENDED', wakes: true }));
  assert.equal(e.suspended, true);
  assert.match(e.text, /suspended now/);
  assert.deepEqual(attachError(502, 'attach proxy: boom'), { suspended: false, text: '502: attach proxy: boom' });
});
