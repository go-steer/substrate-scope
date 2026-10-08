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

// The side panel for the selected agent: Substrate state, ax task details,
// the runner's live idle time (running agents only) and, through the
// collector's attach proxy, the agent's sessions with a live event tail.

import { esc, duration, since, parseGoDuration, workerLabel, clock } from './format.js';
import { cssColor } from './scene.js';

const REASON_CLASS = {
  IdleSuspended: 'r-idle',
  CompletedSuspended: 'r-done',
  ResumedByRequest: 'r-woke',
  ActorSuspended: 'r-ext',
  TaskSuspended: 'r-ext',
};

function row(k, v, cls = '') {
  if (v === undefined || v === null || v === '') return '';
  return `<div class="kv ${cls}"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
}

function mono(s) {
  return `<code>${esc(s)}</code>`;
}

function apiBase(key) {
  const [as, ...rest] = key.split('/');
  return `api/agents/${encodeURIComponent(as)}/${encodeURIComponent(rest.join('/'))}`;
}

/** Summarizes one attach SSE frame into a short line. */
export function summarizeFrame(type, data) {
  try {
    const d = JSON.parse(data);
    switch (type) {
      case 'agent': {
        const ev = d.event || {};
        const parts = ev.content?.parts || [];
        const who = ev.author || ev.content?.role || 'agent';
        for (const p of parts) {
          if (p.functionCall) return { kind: 'tool', text: `${who} → ${p.functionCall.name}(${JSON.stringify(p.functionCall.args || {}).slice(0, 80)})` };
          if (p.functionResponse) return { kind: 'result', text: `${p.functionResponse.name} returned` };
          if (p.text) return { kind: who === 'user' ? 'user' : 'text', text: `${who}: ${p.text.replace(/\s+/g, ' ').slice(0, 220)}` };
        }
        return { kind: 'meta', text: `${who}: (event ${d.seq ?? ''})` };
      }
      case 'status-update':
        return { kind: 'meta', text: `status: ${d.turn_state || JSON.stringify(d).slice(0, 80)}` };
      case 'usage-update':
        return { kind: 'meta', text: `usage: ${d.tokens_in_total ?? 0} in / ${d.tokens_out_total ?? 0} out tokens, ${d.turns_total ?? 0} turns` };
      case 'capabilities':
        return { kind: 'meta', text: `connected to ${d.server || 'agent'}${d.agent?.model ? ' · ' + d.agent.model : ''}` };
      case 'tool-call':
        return { kind: 'tool', text: `tool call: ${d.name || d.tool || ''}` };
      case 'tool-result':
        return { kind: 'result', text: `tool result: ${d.name || d.tool || ''}` };
      case 'turn-complete':
        return { kind: 'meta', text: 'turn complete' };
      case 'turn-error':
        return { kind: 'error', text: `turn error: ${d.error || d.message || ''}` };
      default:
        return { kind: 'meta', text: `${type}` };
    }
  } catch {
    return { kind: 'meta', text: `${type}: ${String(data).slice(0, 120)}` };
  }
}

export class Panel {
  /**
   * @param {HTMLElement} el
   * @param {{onClose: Function, features: () => any}} opts
   */
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.key = null;
    this.detail = null;
    this.fetchedAt = 0;
    this.consent = false;
    this.sessions = null;
    this.tail = null;
    this.tailLines = [];
    this.timer = setInterval(() => this.tick(), 1000);
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('wheel', () => {
      this.followPanel = false;
    });
  }

  show(key) {
    if (key !== this.key) {
      this.stopTail();
      this.consent = false;
      this.sessions = null;
      this.sessionError = '';
      this.detail = null;
    }
    this.key = key;
    this.el.classList.add('open');
    this.load();
  }

  hide() {
    this.stopTail();
    this.key = null;
    this.el.classList.remove('open');
  }

  /** Called when the model changed for this agent. */
  agentChanged(agent) {
    if (!this.detail || !agent) return;
    const was = this.detail.agent.state;
    this.detail.agent = agent;
    if (was !== agent.state) this.load();
    else this.render();
  }

  async load() {
    const key = this.key;
    if (!key) return;
    try {
      const resp = await fetch(apiBase(key), { cache: 'no-store' });
      if (key !== this.key) return;
      if (!resp.ok) {
        this.detail = null;
        this.el.innerHTML = `<div class="panel-head"><h2>${esc(key)}</h2><button class="close" data-act="close" title="Close">×</button></div><p class="note">This agent is gone.</p>`;
        return;
      }
      this.detail = await resp.json();
      this.fetchedAt = Date.now();
      this.render();
    } catch (err) {
      console.warn('agent detail', err);
    }
  }

  tick() {
    if (!this.key || !this.detail) return;
    // Running ax agents: refresh runner status every 3s (the collector
    // confirms the actor is still running first). Others: just re-render
    // the ages.
    if (this.detail.agent.state === 'RUNNING' && this.detail.agent.task && Date.now() - this.fetchedAt > 3000) {
      this.load();
    } else {
      this.renderLive();
    }
  }

  idleNow() {
    const d = this.detail;
    if (!d?.runner || !d.runnerTime) return null;
    if (d.runner.inFlight > 0) return 0;
    return d.runner.idleSeconds + Math.max(0, (Date.now() - Date.parse(d.runnerTime)) / 1000);
  }

  renderLive() {
    const idle = this.idleNow();
    const el = this.el.querySelector('[data-live="idle"]');
    if (el && idle !== null) {
      const after = parseGoDuration(this.detail.agent.task?.idleSuspendAfter);
      el.innerHTML = this.idleHTML(idle, after);
    }
    const age = this.el.querySelector('[data-live="age"]');
    if (age) age.textContent = duration(since(this.detail.agent.stateSince));
  }

  idleHTML(idle, after) {
    const r = this.detail.runner;
    if (r.inFlight > 0) return `<span class="busy">serving ${r.inFlight} request${r.inFlight === 1 ? '' : 's'}</span>`;
    if (r.busy) return `<span class="busy">busy (reported by the agent)</span> · idle ${duration(idle)}`;
    if (!after) return `idle ${duration(idle)} <span class="muted">(no idle policy)</span>`;
    const pct = Math.min(100, (idle / after) * 100);
    const left = Math.max(0, after - idle);
    return `<div class="idlebar"><div style="width:${pct.toFixed(1)}%"></div></div>
      <div class="idletext">idle ${duration(idle)} of ${duration(after)} · ${left > 0 ? 'suspends in ~' + duration(left) : 'suspending now'}</div>`;
  }

  render() {
    const d = this.detail;
    if (!d) return;
    const a = d.agent;
    const t = a.task;
    const f = this.opts.features() || {};
    const color = cssColor(a.state);
    const parts = [];
    parts.push(`<div class="panel-head">
      <div><div class="atespace">${esc(a.atespace)}</div><h2>${esc(a.name)}</h2></div>
      <button class="close" data-act="close" title="Close">×</button></div>
      <div class="state-line"><span class="state-badge" style="--c:${color}">${esc(a.state)}</span>
      <span class="muted">for <span data-live="age">${duration(since(a.stateSince))}</span></span></div>`);

    // Substrate.
    const sub = [
      row('Worker', a.worker ? `${esc(workerLabel(d.worker) || a.workerPod || a.worker)}${a.workerNode ? `<span class="muted"> on ${esc(a.workerNode)}</span>` : ''}` : '<span class="muted">none</span>'),
      row('Template', a.template && mono(a.template)),
      row('Snapshot', a.snapshotURI ? mono(a.snapshotURI.replace(/^gs:\/\/[^/]+\//, '…/')) : '<span class="muted">none yet</span>'),
      a.snapshotInProgress ? row('Snapshot', '<span class="busy">in progress</span>') : '',
      a.crash ? row('Crash', `<span class="crash">${esc(a.crash.message || 'crashed')}</span>${a.crash.time ? `<span class="muted"> at ${esc(clock(a.crash.time))}</span>` : ''}`) : '',
      row('Created', a.createTime && `${esc(new Date(a.createTime).toLocaleString())}`),
      row('UID', a.uid && mono(a.uid)),
    ];
    parts.push(`<section><h3>Agent Substrate</h3>${sub.join('')}</section>`);

    // ax.
    if (t) {
      const ready = (t.conditions || []).find((c) => c.type === 'Ready');
      const conds = (t.conditions || [])
        .map(
          (c) => `<tr><td>${esc(c.type)}</td><td class="st-${esc(c.status)}">${esc(c.status)}</td>
          <td><span class="reason ${REASON_CLASS[c.reason] || ''}">${esc(c.reason || '')}</span>
          ${c.message ? `<div class="msg">${esc(c.message)}</div>` : ''}</td>
          <td class="muted">${c.lastTransitionTime ? duration(since(c.lastTransitionTime)) + ' ago' : ''}</td></tr>`,
        )
        .join('');
      const policy = [];
      if (t.idleSuspendAfter) policy.push(`suspend after ${esc(t.idleSuspendAfter)} idle`);
      if (t.idleBusyPath) policy.push(`busy check ${mono(t.idleBusyPath)}`);
      if (t.onCompletion) policy.push(`on completion: ${esc(t.onCompletion)}`);
      let runner = '';
      if (d.runner) {
        const idle = this.idleNow();
        runner = row('Idle', `<div data-live="idle">${this.idleHTML(idle, parseGoDuration(t.idleSuspendAfter))}</div>`, 'wide');
        if (d.runner.exited) runner += row('Command', `exited with code ${d.runner.exitCode}`);
      } else if (d.runnerNote && a.state === 'RUNNING') {
        runner = row('Idle', `<span class="muted">${esc(d.runnerNote)}</span>`);
      }
      parts.push(`<section><h3>ax task</h3>
        ${row('Phase', `<b>${esc(t.phase || '?')}</b>${ready?.reason ? ` <span class="reason ${REASON_CLASS[ready.reason] || ''}">${esc(ready.reason)}</span>` : ''}`)}
        ${runner}
        ${row('Idle policy', policy.join(' · ') || '<span class="muted">none (never suspended for idleness)</span>')}
        ${row('Image', t.image && mono(t.image.replace(/@sha256:([0-9a-f]{12})[0-9a-f]+/, '@sha256:$1…')))}
        ${row('Serves', t.httpPort ? `API on port ${t.httpPort} through the router` : '')}
        ${row('Workspaces', (t.workspaces || []).map(esc).join(', '))}
        ${conds ? `<table class="conds"><thead><tr><th>Condition</th><th></th><th>Reason</th><th></th></tr></thead><tbody>${conds}</tbody></table>` : ''}
      </section>`);
    } else {
      parts.push(`<section><h3>ax task</h3><p class="muted">Not an ax task.</p></section>`);
    }

    parts.push(this.sessionsHTML(a, t, f));
    this.el.innerHTML = parts.join('');
    this.renderTail();
  }

  sessionsHTML(a, t, f) {
    if (!f.attach) {
      return `<section><h3>Sessions</h3><p class="muted">The attach proxy is not configured on this collector.</p></section>`;
    }
    const running = a.state === 'RUNNING';
    const serves = !!t?.httpPort;
    let body = '';
    if (!serves) body += `<p class="muted">This agent doesn't declare an API through the router (no spec.http.port), so it may not answer.</p>`;
    if (!this.sessions) {
      if (running) {
        body += `<button class="btn" data-act="sessions">List sessions</button>
          <p class="hint">Requests through ax's pass-through count as activity and restart the idle timer.</p>`;
      } else {
        body += `<div class="wake-warning"><b>Opening this agent wakes it.</b> It is ${esc(a.state.toLowerCase())};
          Agent Substrate's router resumes it to deliver the request, and it will hold a worker until it is idle again.</div>
          <button class="btn warn" data-act="wake-sessions">Wake and list sessions</button>`;
      }
    } else {
      const list = this.sessions
        .map((s) => {
          const id = s.sessionID || s.id;
          const active = this.tail && this.tail.sid === id;
          return `<div class="session"><div><code>${esc(id)}</code>
            <span class="muted">${esc(s.status || '')}${s.last_touched_at ? ' · ' + duration(since(s.last_touched_at)) + ' ago' : ''}</span></div>
            ${s.has_event_log === false ? '<span class="muted">no event log</span>' : `<button class="btn small" data-act="${active ? 'untail' : 'tail'}" data-sid="${esc(id)}" data-app="${esc(s.app || '')}">${active ? 'Stop' : 'Tail events'}</button>`}</div>`;
        })
        .join('');
      body += list || '<p class="muted">No sessions.</p>';
      body += `<button class="btn small ghost" data-act="${running ? 'sessions' : 'wake-sessions'}">Refresh</button>`;
    }
    if (this.sessionError) body += `<p class="error">${esc(this.sessionError)}</p>`;
    body += `<div class="tail" data-tail></div>`;
    return `<section><h3>Sessions <span class="muted small">via attach proxy</span></h3>${body}</section>`;
  }

  async listSessions(wake) {
    if (wake) this.consent = true;
    this.sessionError = '';
    const q = this.consent ? '?scope_wake=1' : '';
    try {
      const resp = await fetch(`${apiBase(this.key)}/attach/sessions${q}`, { cache: 'no-store' });
      const text = await resp.text();
      if (!resp.ok) {
        let msg = text;
        try {
          msg = JSON.parse(text).error || text;
        } catch {
          /* plain text */
        }
        this.sessionError = `${resp.status}: ${msg.slice(0, 300)}`;
      } else {
        this.sessions = JSON.parse(text).sessions || [];
      }
    } catch (err) {
      this.sessionError = String(err);
    }
    this.render();
  }

  startTail(sid, app) {
    this.stopTail();
    const path = app ? `${encodeURIComponent(app)}/${encodeURIComponent(sid)}` : encodeURIComponent(sid);
    const q = this.consent ? '?scope_wake=1' : '';
    const es = new EventSource(`${apiBase(this.key)}/attach/sessions/${path}/events${q}`);
    this.tail = { sid, es };
    this.tailLines = [{ kind: 'meta', text: `tailing ${sid}…`, at: Date.now() }];
    const types = ['agent', 'status-update', 'usage-update', 'capabilities', 'tool-call', 'tool-result', 'turn-complete', 'turn-error', 'inbox', 'stream-chunk'];
    for (const ty of types) {
      es.addEventListener(ty, (e) => {
        if (ty === 'stream-chunk') return; // token deltas: too chatty for a tail
        this.tailLines.push({ ...summarizeFrame(ty, e.data), at: Date.now() });
        if (this.tailLines.length > 300) this.tailLines.splice(0, this.tailLines.length - 300);
        this.renderTail();
      });
    }
    this.tailLines.push({ kind: 'meta', text: 'while this tail is open the agent is serving a request, so ax will not idle-suspend it', at: Date.now() });
    es.onerror = () => {
      this.tailLines.push({ kind: 'error', text: 'stream interrupted (reconnecting)', at: Date.now() });
      this.renderTail();
    };
    this.followPanel = true;
    this.render();
  }

  stopTail() {
    if (this.tail) {
      this.tail.es.close();
      this.tail = null;
    }
  }

  renderTail() {
    const el = this.el.querySelector('[data-tail]');
    if (!el) return;
    if (!this.tail) {
      el.innerHTML = '';
      return;
    }
    const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    el.innerHTML = this.tailLines
      .map((l) => `<div class="line ${l.kind}"><span class="ts">${esc(clock(new Date(l.at).toISOString()))}</span> ${esc(l.text)}</div>`)
      .join('');
    if (stick) el.scrollTop = el.scrollHeight;
    // Keep the tail in view until the user scrolls the panel themselves.
    if (this.followPanel) this.el.scrollTop = this.el.scrollHeight;
  }

  onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'close':
        this.opts.onClose();
        break;
      case 'sessions':
        this.listSessions(false);
        break;
      case 'wake-sessions':
        this.listSessions(true);
        break;
      case 'tail':
        this.startTail(btn.dataset.sid, btn.dataset.app);
        break;
      case 'untail':
        this.stopTail();
        this.render();
        break;
      default:
        break;
    }
  }
}
