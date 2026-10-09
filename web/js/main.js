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

// Wires the stream, the model, the scene, the filters, the event feed and
// the side panel together.

import { Model, CLASSES, CLASS_LABEL, makeFilter, stateClass } from './model.js';
import { Stream, streamURL } from './stream.js';
import { Scene, cssColor } from './scene.js';
import { Panel } from './panel.js';
import { esc, duration, since, clock, workerLabel } from './format.js';
import { describe } from './feed.js';
import { SyntheticStream, syntheticDetail } from './synth.js';
import { ThemePicker } from './theming.js';
import { LookPicker, initialLooks, rememberGroup } from './looks.js';
import { inkOn } from './themes.js';

const $ = (sel) => document.querySelector(sel);

const model = new Model();
const filterState = { atespace: '', classes: new Set(CLASSES), prefix: '' };
let selected = null;
/** Events seen per type (for tests and screenshot tooling). */
const eventCounts = {};

const looks0 = initialLooks();
const scene = new Scene(
  $('#viewport'),
  {
    onPick: (key, worker) => pick(key, worker),
    onHover: (key, x, y) => hover(key, x, y),
    onHoverWorker: (name) => {
      hoverWorker = name;
      document.body.style.cursor = name ? 'pointer' : '';
    },
  },
  { shape: looks0.agents, router: looks0.router, extras: looks0.extras, group: looks0.group },
);
let hoverWorker = null;
// ?synthetic=N replaces the collector with N generated agents (scale checks
// and design work without a cluster).
const synthetic = Number(new URLSearchParams(window.location.search).get('synthetic')) || 0;
scene.setFakeActivity(synthetic > 0);

// Router look and agent shape: switch live, remembered.
const looks = new LookPicker(
  { router: $('#router-pick'), agents: $('#agents-pick') },
  {
    onRouter: (id) => scene.setRouter(id),
    onAgents: (id) => scene.setAgentShape(id),
    onExtras: (on) => scene.setExtras(on),
  },
);

const panel = new Panel($('#panel'), {
  onClose: () => select(null),
  onShowWorker: (name) => {
    scene.pinWorker(name);
    scene.flyToWorker(name);
  },
  features: () => model.features,
  detail: synthetic > 0 ? (key) => syntheticDetail(model.agents.get(key)) : undefined,
});

// Themes: switching re-colors the page (CSS variables), the scene, the open
// panel and the state-colored feed icons.
const themes = new ThemePicker($('#themes'), (t) => {
  scene.setTheme(t);
  if (selected) panel.show(selected);
  document.querySelectorAll('#feed .item[data-state] .icon').forEach((el) => {
    const c = cssColor(el.closest('.item').dataset.state);
    el.style.setProperty('--c', c);
    el.style.setProperty('--ci', inkOn(c));
  });
}, { onTourStep: () => looks.tourStep() });

// ------------------------------------------------------------------ stream

const streamHandlers = {
  onStatus: (s) => {
    const el = $('#conn');
    el.className = `conn ${s}`;
    el.querySelector('.txt').textContent = s;
  },
  onSnapshot: (snap, resync) => {
    model.applySnapshot(snap);
    scene.setModel(model);
    if (resync) feed({ type: 'meta', text: 'resynced from a fresh snapshot' });
    else {
      const c = model.counts();
      feed({ type: 'meta', text: `connected to <b>${esc(model.cluster)}</b>: ${model.agents.size} agents, ${c.running} running, ${c.suspended} suspended` });
    }
    refreshChrome();
    if (selected && !model.agents.has(selected)) select(null);
    else if (selected) panel.show(selected);
    const want = initialSelection();
    if (want && !selected && model.agents.has(want)) select(want, true);
  },
  onEvents: (events) => {
    if (!model.applyEvents(events)) return false;
    for (const e of events) eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
    scene.applyEvents(events);
    describe(events).forEach(feed);
    refreshChrome();
    if (selected) {
      const a = model.agents.get(selected);
      if (!a) select(null);
      else if (events.some((e) => e.key === selected)) panel.agentChanged(a);
    }
    return true;
  },
};
const stream = synthetic > 0 ? new SyntheticStream(synthetic, streamHandlers) : new Stream(streamURL(), streamHandlers);

function initialSelection() {
  const m = /[#&]agent=([^&]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

// --------------------------------------------------------------- selection

/** A click in the scene: an agent selects it, a worker pad pins (or unpins) it, empty space clears both. */
function pick(key, worker) {
  if (key) {
    scene.pinWorker(null);
    select(key, false);
  } else if (worker) {
    scene.pinWorker(scene.pinnedWorker === worker ? null : worker);
  } else {
    scene.pinWorker(null);
    select(null);
  }
}

// Group by atespace or by worker (header toggle, g, ?group=; remembered).
function setGroup(mode, remember = true) {
  scene.setGroup(mode);
  document.querySelectorAll('#group button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.group === scene.group)));
  if (remember) rememberGroup(scene.group);
}
$('#group').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-group]');
  if (b) setGroup(b.dataset.group);
});
setGroup(looks0.group, false);

function select(key, fly = true) {
  selected = key;
  scene.select(key);
  if (key) {
    panel.show(key);
    if (fly) scene.flyTo(key);
    history.replaceState(null, '', `#agent=${encodeURIComponent(key)}`);
  } else {
    panel.hide();
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  document.body.classList.toggle('panel-open', !!key);
}

const tip = $('#tooltip');
function hover(key, x, y) {
  const a = key && model.agents.get(key);
  if (!a) {
    tip.style.display = 'none';
    document.body.style.cursor = hoverWorker ? 'pointer' : '';
    return;
  }
  document.body.style.cursor = 'pointer';
  tip.style.display = 'block';
  tip.style.left = `${x + 14}px`;
  tip.style.top = `${y + 14}px`;
  const reason = a.task?.conditions?.find((c) => c.type === 'Ready')?.reason;
  const wk = a.worker && model.workers.get(a.worker);
  tip.innerHTML = `<div class="t-name">${esc(a.atespace)}/<b>${esc(a.name)}</b></div>
    <div><span class="dot" style="background:${cssColor(a.state)}"></span>${esc(a.state.toLowerCase())} for ${duration(since(a.stateSince))}</div>
    ${a.worker ? `<div class="muted">on ${esc(wk ? workerLabel(wk) : a.worker)}</div>` : ''}
    ${a.task ? `<div class="muted">ax ${esc(a.task.phase || '')}${reason ? ' · ' + esc(reason) : ''}</div>` : ''}`;
}

// ----------------------------------------------------------------- filters

function applyFilters() {
  const all = filterState.classes.size === CLASSES.length;
  scene.setFilter(makeFilter({ atespace: filterState.atespace, classes: all ? null : filterState.classes, prefix: filterState.prefix }));
  document.querySelectorAll('#legend .chip').forEach((el) => {
    el.classList.toggle('off', !filterState.classes.has(el.dataset.cls));
  });
}

$('#atespace').addEventListener('change', (e) => {
  filterState.atespace = e.target.value;
  applyFilters();
});
$('#prefix').addEventListener('input', (e) => {
  filterState.prefix = e.target.value;
  applyFilters();
});
$('#prefix').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  // Enter flies to the first match.
  const f = makeFilter({ atespace: filterState.atespace, prefix: filterState.prefix });
  const hit = [...model.agents.entries()].find(([, a]) => f(a));
  if (hit) select(hit[0], true);
});
$('#legend').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const cls = chip.dataset.cls;
  const s = filterState.classes;
  if (e.shiftKey || e.metaKey) {
    // Shift-click: only this class (or back to all).
    if (s.size === 1 && s.has(cls)) CLASSES.forEach((c) => s.add(c));
    else {
      s.clear();
      s.add(cls);
    }
  } else if (s.has(cls)) s.delete(cls);
  else s.add(cls);
  if (!s.size) CLASSES.forEach((c) => s.add(c));
  applyFilters();
});
document.addEventListener('keydown', (e) => {
  const typing = document.activeElement?.tagName === 'INPUT';
  if (e.key === 'Escape') {
    scene.pinWorker(null);
    select(null);
  }
  if (e.key === 'g' && !typing) setGroup(scene.group === 'worker' ? 'atespace' : 'worker');
  if (e.key === '/' && !typing) {
    e.preventDefault();
    $('#prefix').focus();
  }
  if (e.key === 'f' && !typing && selected) scene.flyTo(selected);
  if (e.key === 'h' && !typing) scene.fitCamera();
  if (e.key === 'l' && !typing) cycleLabels();
  if (e.key === 'e' && !typing) setFeedCollapsed(!feedCollapsed());
  if (e.key === 'x' && !typing) looks.toggleExtras();
});
$('#home').addEventListener('click', () => scene.fitCamera());

// ------------------------------------------------------------------ chrome

function refreshChrome() {
  $('#cluster').textContent = model.cluster || '';
  const counts = model.counts();
  $('#legend').innerHTML = CLASSES.map(
    (c) => `<button class="chip ${c}${filterState.classes.has(c) ? '' : ' off'}" data-cls="${c}" title="Click to toggle, shift-click to show only this">
      <span class="sw"></span>${CLASS_LABEL[c]}<b>${counts[c]}</b></button>`,
  ).join('');
  $('#total').textContent = `${model.agents.size} agents · ${model.atespaces.size} atespaces · ${model.workers.size} workers`;
  const sel = $('#atespace');
  const names = [...model.atespaces.keys()].sort();
  const want = ['', ...names].join('|');
  if (sel.dataset.names !== want) {
    sel.dataset.names = want;
    sel.innerHTML = `<option value="">All atespaces</option>${names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}`;
    sel.value = filterState.atespace;
  }
  const bad = (model.sources || []).filter((s) => !s.ok);
  $('#health').innerHTML = bad.length
    ? `<span class="warn" title="${esc(bad.map((s) => `${s.name}: ${s.error}`).join('\n'))}">⚠ ${bad.map((s) => esc(s.name)).join(', ')}</span>`
    : '';
  $('#seq').textContent = `seq ${model.seq}`;
}

// -------------------------------------------------------------------- feed

// The live event feed: a collapsible panel on the left, newest on top.
const FEED_MAX = 200;
const FEED_ICON = { added: '+', woke: '↑', suspended: '↓', crashed: '✕', task: '◆', removed: '−', state: '→', worker: '▣', meta: '•' };
const feedEl = $('#feed');
let feedTotal = 0;
let feedUnread = 0;

function feedCollapsed() {
  return document.body.classList.contains('feed-collapsed');
}

function setFeedCollapsed(on) {
  document.body.classList.toggle('feed-collapsed', on);
  try {
    localStorage.setItem('substrate-scope:feed-collapsed', on ? '1' : '0');
  } catch {
    /* storage blocked: still works for this page */
  }
  if (!on) feedUnread = 0;
  updateFeedCounts();
  scene.setLeftInset(feedInset());
}

/** Width the open events panel covers, for framing the island beside it. */
function feedInset() {
  if (feedCollapsed()) return 0;
  const r = $('#feedpanel').getBoundingClientRect();
  return r.right + 12;
}

function updateFeedCounts() {
  $('#feedcount').textContent = feedTotal ? `${feedTotal}` : '';
  $('#feed-unread').textContent = feedUnread ? String(feedUnread > 99 ? '99+' : feedUnread) : '';
}

function feed(item) {
  const div = document.createElement('div');
  const type = FEED_ICON[item.type] ? item.type : 'meta';
  div.className = `item ${type}`;
  const now = new Date();
  const color = type === 'state' && item.state ? cssColor(item.state) : '';
  if (color) div.dataset.state = item.state;
  div.innerHTML = `<span class="icon"${color ? ` style="--c:${color};--ci:${inkOn(color)}"` : ''}>${FEED_ICON[type]}</span>
    <span class="body"><span class="txt">${item.text}</span><span class="ts" title="${esc(now.toLocaleString())}">${clock(now.toISOString())}</span></span>`;
  if (item.key) {
    div.classList.add('link');
    div.title = 'Select and fly to this agent';
    div.addEventListener('click', () => model.agents.has(item.key) && select(item.key, true));
  }
  // Newest on top. If the user has scrolled down to read older events,
  // keep what they are reading where it is.
  const keep = feedEl.scrollTop > 0;
  feedEl.prepend(div);
  if (keep) feedEl.scrollTop += div.offsetHeight;
  while (feedEl.children.length > FEED_MAX) feedEl.lastChild.remove();
  feedTotal++;
  if (feedCollapsed() && type !== 'meta') feedUnread++;
  updateFeedCounts();
}

scene.setLeftInset(feedInset());
$('#feed-collapse').addEventListener('click', () => setFeedCollapsed(true));
$('#feed-tab').addEventListener('click', () => setFeedCollapsed(false));
try {
  if (localStorage.getItem('substrate-scope:feed-collapsed') === '1') setFeedCollapsed(true);
} catch {
  /* storage blocked */
}

// Agent labels: auto, all or off (remembered).
const LABEL_MODES = ['auto', 'all', 'off'];
function setLabelMode(mode) {
  if (!LABEL_MODES.includes(mode)) mode = 'auto';
  scene.setLabelMode(mode);
  $('#labels').textContent = `Labels: ${mode}`;
  $('#labels').dataset.mode = mode;
  try {
    localStorage.setItem('substrate-scope:labels', mode);
  } catch {
    /* storage blocked */
  }
}
function cycleLabels() {
  const cur = $('#labels').dataset.mode || 'auto';
  setLabelMode(LABEL_MODES[(LABEL_MODES.indexOf(cur) + 1) % LABEL_MODES.length]);
}
$('#labels').addEventListener('click', cycleLabels);
try {
  setLabelMode(localStorage.getItem('substrate-scope:labels') || 'auto');
} catch {
  setLabelMode('auto');
}

setInterval(() => {
  $('#clock').textContent = clock();
}, 1000);

// For debugging and screenshots.
window.scope = { model, scene, panel, select, stateClass, eventCounts, themes, looks, stream };
