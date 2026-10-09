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

// Agents and the workers they run on: the "group by worker" layout, the
// highlight rules (which agents light up when a worker or agent is in focus),
// worker usage (actor slots, CPU, memory) and atespace tints. Pure functions,
// no three.js or DOM, so they run under `node --test`.

import { CELL, PAD, GAP, LABEL_STRIP, reservedCells } from './layout.js';

/** Ways to group agents into districts. */
export const GROUPS = ['atespace', 'worker'];

/** The district key for agents without a worker in worker view. */
export const PARKED = '\u0000parked';

/** Label strip of a worker platform: room for its label and its pad. */
export const WORKER_STRIP = 2.8;

/** Smallest number of cell columns on a worker platform (fits label and pad). */
export const MIN_WORKER_COLS = 6;

/** A valid group mode ('atespace' unless it is a known one). */
export function groupId(mode) {
  return GROUPS.includes(mode) ? mode : 'atespace';
}

/** The district an agent belongs to in a group mode. */
export function groupOf(agent, mode) {
  if (mode === 'worker') return agent.worker || PARKED;
  return agent.atespace;
}

/**
 * Agents per district for a group mode. Atespace mode includes empty
 * atespaces; worker mode includes every known worker (idle ones too) and the
 * parked area, plus workers that agents name but the worker list lacks.
 * @param {{agents: Map, atespaces: Map, workers: Map}} model
 * @param {string} mode
 * @returns {Map<string, number>}
 */
export function groupCounts(model, mode) {
  const m = new Map();
  if (mode === 'worker') {
    for (const name of model.workers.keys()) m.set(name, 0);
    m.set(PARKED, 0);
  } else {
    for (const name of model.atespaces.keys()) m.set(name, 0);
  }
  for (const a of model.agents.values()) {
    const g = groupOf(a, mode);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/** Cells a worker platform needs: its actor capacity when known, else room to grow. */
export function workerCells(count, capacity) {
  return capacity > 0 ? Math.max(capacity, count) : reservedCells(count);
}

/**
 * Plans the worker view: one platform per worker in a grid at the front,
 * all the same size so their fill compares at a glance, and a parked area
 * behind them for agents without a worker (suspended, pending), wide enough
 * that the whole thing stays roughly as wide as it is deep times 1.6.
 *
 * @param {{name: string, count: number, capacity?: number}[]} workers
 * @param {number} parked agents without a worker
 * @returns {{width: number, depth: number, districts: Map<string, object>}}
 *
 * A worker district has kind 'worker', its own label strip (strip), a slot
 * grid (cols x rows, capacity) and shown: the cells to draw as room (its
 * actor capacity when known). The parked district has kind 'parked'.
 */
export function planWorkerView(workers, parked) {
  const list = [...workers].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const need = Math.max(1, ...list.map((w) => workerCells(w.count, w.capacity || 0)));
  const cols = Math.max(MIN_WORKER_COLS, Math.ceil(Math.sqrt(need * 1.4)));
  const rows = Math.max(1, Math.ceil(need / cols));
  const pw = cols * CELL + 2 * PAD;
  const pd = rows * CELL + PAD + WORKER_STRIP;

  // Parked cells: everyone without a worker plus one spare row's worth.
  const parkedCells = Math.max(6, Math.ceil(parked * 1.08) + 4);
  const parkedArea = parkedCells * CELL * CELL * 1.1;
  const zoneArea = list.length * (pw + GAP) * (pd + GAP);
  const target = Math.max(pw, Math.sqrt((zoneArea + parkedArea) * 1.6));
  const gridCols = list.length ? Math.min(list.length, Math.max(1, Math.floor((target + GAP) / (pw + GAP)))) : 0;
  const gridRows = gridCols ? Math.ceil(list.length / gridCols) : 0;
  const zoneW = gridCols ? gridCols * (pw + GAP) - GAP : 0;
  const zoneD = gridRows ? gridRows * (pd + GAP) - GAP : 0;

  const parkedW = Math.max(zoneW, Math.min(target, Math.max(12, Math.sqrt(parkedArea * 1.6))), 12);
  const parkedCols = Math.max(1, Math.floor((parkedW - 2 * PAD) / CELL));
  const parkedRows = Math.max(1, Math.ceil(parkedCells / parkedCols));
  const parkedD = parkedRows * CELL + PAD + LABEL_STRIP;

  const width = Math.max(zoneW, parkedW);
  const depth = parkedD + (zoneD ? zoneD + 2 * GAP : 0);
  const districts = new Map();
  const z0 = -depth / 2;
  districts.set(PARKED, {
    name: PARKED,
    kind: 'parked',
    x: -parkedW / 2,
    z: z0,
    w: parkedW,
    d: parkedD,
    cols: parkedCols,
    rows: parkedRows,
    capacity: parkedCols * parkedRows,
  });
  const zz = z0 + parkedD + 2 * GAP;
  list.forEach((wk, i) => {
    const row = Math.floor(i / gridCols);
    const col = i % gridCols;
    // Center a short last row.
    const inRow = Math.min(gridCols, list.length - row * gridCols);
    const rowW = inRow * (pw + GAP) - GAP;
    districts.set(wk.name, {
      name: wk.name,
      kind: 'worker',
      x: -rowW / 2 + col * (pw + GAP),
      z: zz + row * (pd + GAP),
      w: pw,
      d: pd,
      cols,
      rows,
      strip: WORKER_STRIP,
      capacity: cols * rows,
      shown: Math.min(cols * rows, wk.capacity > 0 ? wk.capacity : workerCells(wk.count, 0)),
    });
  });
  return { width, depth, districts };
}

// --------------------------------------------------------------- highlight

/**
 * The worker in focus, from what the user points at. A hovered or pinned
 * worker pad is a strong focus: its agents light up and the rest dim. A
 * hovered or selected agent on a worker is a soft focus: its worker pad
 * lights up and its siblings get a subtle highlight; nothing dims.
 *
 * @param {{hoverWorker?: string, pinnedWorker?: string, hoverAgent?: string, selectedAgent?: string}} state
 * @param {(key: string) => string|undefined} workerOf an agent's worker
 * @returns {{worker: string|null, strong: boolean}}
 */
export function focusOf(state, workerOf) {
  const strong = state.hoverWorker || state.pinnedWorker;
  if (strong) return { worker: strong, strong: true };
  for (const key of [state.hoverAgent, state.selectedAgent]) {
    const w = key ? workerOf(key) : null;
    if (w) return { worker: w, strong: false };
  }
  return { worker: null, strong: false };
}

/** Highlight levels: 2 lit, 1 sibling, 0 normal, -1 dimmed. */
export const HI = { LIT: 2, SIBLING: 1, NONE: 0, DIM: -1 };

/** An agent's (or its link's) highlight level under a focus. */
export function levelOf(focus, agentWorker) {
  if (!focus.worker) return HI.NONE;
  if (agentWorker && agentWorker === focus.worker) return focus.strong ? HI.LIT : HI.SIBLING;
  return focus.strong ? HI.DIM : HI.NONE;
}

/** True when two foci light up the same things. */
export function sameFocus(a, b) {
  return a.worker === b.worker && a.strong === b.strong;
}

// ------------------------------------------------------------------- usage

const SUFFIX = {
  n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
};

/** Parses a Kubernetes quantity ("500m", "4", "16Gi", "1.5e3") to a number; NaN if it isn't one. */
export function parseQuantity(s) {
  if (s === undefined || s === null || s === '') return NaN;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:[eE]([+-]?\d+))?([a-zA-Z]*)$/.exec(String(s).trim());
  if (!m || !(m[3] in SUFFIX)) return NaN;
  return parseFloat(m[1]) * 10 ** Number(m[2] || 0) * SUFFIX[m[3]];
}

const trim = (v) => String(Number(v.toFixed(v >= 10 ? 0 : 1)));

/** CPU cores for people: "750m", "3.5", "16". */
export function formatCPU(cores) {
  if (!Number.isFinite(cores)) return '';
  if (cores > 0 && cores < 1) return `${Math.round(cores * 1000)}m`;
  return trim(cores);
}

/** Bytes for people: "512 MiB", "12 GiB". */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${trim(v)} ${units[i]}`;
}

/**
 * A worker's usage: actor slots (used = agents the scene shows on it, cap =
 * its capacity, 0 when unknown), and CPU and memory when it reports both
 * capacity and allocation (else null). frac is used/cap (0 when unknown).
 */
export function workerUsage(worker, hosted) {
  const res = (used, cap) => {
    const u = parseQuantity(used);
    const c = parseQuantity(cap);
    if (!Number.isFinite(u) || !Number.isFinite(c) || c <= 0) return null;
    return { used: u, cap: c, frac: u / c };
  };
  const cap = worker?.capacityActors || 0;
  return {
    actors: { used: hosted, cap, frac: cap > 0 ? hosted / cap : 0 },
    cpu: res(worker?.allocatedCpu, worker?.capacityCpu),
    memory: res(worker?.allocatedMemory, worker?.capacityMemory),
  };
}

// ------------------------------------------------------------------- teams

/**
 * Hue (0..1) of each atespace's tint in worker view: spread by the golden
 * ratio over the sorted names, so neighbours in the list differ and the same
 * set of atespaces always gets the same tints.
 */
export function teamHues(names) {
  const out = new Map();
  [...names].sort().forEach((n, i) => out.set(n, (0.08 + i * 0.618034) % 1));
  return out;
}

/** CSS color of a tint (for label chips that match the floor tiles). */
export function teamCSS(hue, theme) {
  const t = theme.team;
  return `hsl(${Math.round(hue * 360)} ${Math.round(t.saturation * 100)}% ${Math.round(t.lightness * 100)}%)`;
}

/** The atespaces with the most agents on a worker: [{name, count}], biggest first. */
export function topTeams(agents, n = 3) {
  const m = new Map();
  for (const a of agents) m.set(a.atespace, (m.get(a.atespace) || 0) + 1);
  return [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
    .slice(0, n);
}
