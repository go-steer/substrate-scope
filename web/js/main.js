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
import { esc, duration, since, clock } from './format.js';
import { describe } from './feed.js';

const $ = (sel) => document.querySelector(sel);

const model = new Model();
const filterState = { atespace: '', classes: new Set(CLASSES), prefix: '' };
let selected = null;

const scene = new Scene($('#viewport'), {
  onPick: (key) => select(key, false),
  onHover: (key, x, y) => hover(key, x, y),
});
const panel = new Panel($('#panel'), {
  onClose: () => select(null),
  features: () => model.features,
});

// ------------------------------------------------------------------ stream

new Stream(streamURL(), {
  onStatus: (s) => {
    const el = $('#conn');
    el.className = `conn ${s}`;
    el.querySelector('.txt').textContent = s;
  },
  onSnapshot: (snap, resync) => {
    model.applySnapshot(snap);
    scene.setModel(model);
    if (resync) feed({ type: 'meta', text: 'resynced from a fresh snapshot' });
    refreshChrome();
    if (selected && !model.agents.has(selected)) select(null);
    else if (selected) panel.show(selected);
    const want = initialSelection();
    if (want && !selected && model.agents.has(want)) select(want, true);
  },
  onEvents: (events) => {
    if (!model.applyEvents(events)) return false;
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
});

function initialSelection() {
  const m = /[#&]agent=([^&]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

// --------------------------------------------------------------- selection

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
    document.body.style.cursor = '';
    return;
  }
  document.body.style.cursor = 'pointer';
  tip.style.display = 'block';
  tip.style.left = `${x + 14}px`;
  tip.style.top = `${y + 14}px`;
  const reason = a.task?.conditions?.find((c) => c.type === 'Ready')?.reason;
  tip.innerHTML = `<div class="t-name">${esc(a.atespace)}/<b>${esc(a.name)}</b></div>
    <div><span class="dot" style="background:${cssColor(a.state)}"></span>${esc(a.state.toLowerCase())} for ${duration(since(a.stateSince))}</div>
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
  if (e.key === 'Escape') select(null);
  if (e.key === '/' && !typing) {
    e.preventDefault();
    $('#prefix').focus();
  }
  if (e.key === 'f' && !typing && selected) scene.flyTo(selected);
  if (e.key === 'h' && !typing) scene.fitCamera();
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

const feedEl = $('#feed');
function feed(item) {
  const div = document.createElement('div');
  div.className = `item ${item.type}`;
  const color = item.state ? cssColor(item.state) : '#7f93bd';
  div.innerHTML = `<span class="ts">${clock()}</span><span class="dot" style="background:${color}"></span><span class="txt">${item.text}</span>`;
  if (item.key) {
    div.addEventListener('click', () => model.agents.has(item.key) && select(item.key, true));
  }
  feedEl.prepend(div);
  while (feedEl.children.length > 9) feedEl.lastChild.remove();
}

setInterval(() => {
  $('#clock').textContent = clock();
}, 1000);

// For debugging and screenshots.
window.scope = { model, scene, select, stateClass };
