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

// The "two decks" layout as pure functions: agents on a glassy top deck
// (atespace districts, every agent), workers on a separate deck below
// (node pool -> node -> worker pads), thin beams from each agent that holds
// a worker down to its pad, and, zoomed out, flow ribbons from each
// atespace tile to each node-pool tile sized by the running agents on that
// pair. No three.js or DOM, so it runs under `node --test`.

import { planPadArea, levelOf, HI, PAD_SPACING, PAD_ROW } from './workers.js';

/** Layouts: two decks (default), or the original single island. */
export const LAYOUTS = ['decks', 'combined'];
export const DEFAULT_LAYOUT = 'decks';

/** A valid layout id (the default unless it is a known one). */
export function layoutId(id) {
  return LAYOUTS.includes(id) ? id : DEFAULT_LAYOUT;
}

/** Deck views: both decks, or one with the other faded out (keys 3, 1, 2). */
export const DECK_VIEWS = ['both', 'agents', 'workers'];
export const DECK_KEYS = { 1: 'agents', 2: 'workers', 3: 'both' };

/** A valid deck view. */
export function deckViewId(v) {
  return DECK_VIEWS.includes(v) ? v : 'both';
}

/** How opaque each deck is in a view: {agents, workers}, 0..1. */
export function deckAlphas(view) {
  const v = deckViewId(view);
  return { agents: v === 'workers' ? 0 : 1, workers: v === 'agents' ? 0 : 1 };
}

/** Pad footprint (matches pads.js) and the margin of the worker deck's slab. */
const PAD_W = 3.2;
const PAD_D = 1.8;
export const DECK_MARGIN = 3.5;
/** Room at the deck's front edge for its name. */
export const DECK_FRONT = 3;

/**
 * The vertical gap between the decks: enough that the worker deck reads as
 * its own object under a camera that sees both, growing with the decks.
 * @param {{depth: number}} agentDeck
 * @param {{depth: number}} workerDeck
 */
export function deckGap(agentDeck, workerDeck) {
  return Math.min(420, Math.max(16, 0.3 * Math.max(agentDeck.depth, workerDeck.depth) + 10));
}

/**
 * Plans the worker deck under an agent deck: the pads grouped by node pool
 * (a framed block per pool when there are several, nodes in order inside),
 * shaped roughly 1.7:1 whatever the number of workers, a gap below the
 * agent deck, centered under it left to right and with the front edges
 * lined up, so a camera in front sees the worker deck below the agent
 * deck instead of hidden under its middle.
 *
 * @param {{name: string, pod?: string, pool?: string, node?: string}[]} workers
 * @param {{cx: number, cz: number, width: number, depth: number}} agentDeck
 * @returns {{items: {name: string, x: number, z: number}[], frames: object[], tiles: object[],
 *   poolOf: Map<string, string>, width: number, depth: number, cx: number, cz: number, y: number, gap: number}}
 *   items: pad centers (deck-local x/z are world x/z; y is the deck's);
 *   frames: pool frames ({kind: 'pool', name, x, z, w, d, strip, workers});
 *   tiles: the far tiles, one per pool ({name, kind: 'pool', x, z, w, d, groups: worker names});
 *   poolOf: worker -> its tile's name (the ribbons' lower end).
 */
export function planWorkerDeck(workers, agentDeck) {
  const pools = new Set(workers.map((w) => w.pool || ''));
  const multi = pools.size > 1;
  const area = Math.max(1, workers.length) * PAD_SPACING * PAD_ROW * (multi ? 1.5 : 1);
  const target = Math.max(22, Math.sqrt(area * 1.7));
  const pa = planPadArea(workers, target);
  // Bounds of the pads (with room for their compact labels) and the frames.
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const it of pa.items) {
    x0 = Math.min(x0, it.x - PAD_W / 2);
    x1 = Math.max(x1, it.x + PAD_W / 2);
    z0 = Math.min(z0, it.z - PAD_D / 2);
    z1 = Math.max(z1, it.z + PAD_D / 2 + 0.9);
  }
  for (const f of pa.frames) {
    x0 = Math.min(x0, f.x);
    x1 = Math.max(x1, f.x + f.w);
    z0 = Math.min(z0, f.z);
    z1 = Math.max(z1, f.z + f.d);
  }
  if (!Number.isFinite(x0)) {
    x0 = -8;
    x1 = 8;
    z0 = -4;
    z1 = 4;
  }
  const width = x1 - x0 + 2 * DECK_MARGIN;
  const depth = z1 - z0 + 2 * DECK_MARGIN + DECK_FRONT;
  const cx = agentDeck.cx;
  const cz = agentDeck.cz + (agentDeck.depth - depth) / 2;
  // Shift so the slab (pads, margins and the front strip) sits at (cx, cz).
  const dx = cx - (x0 + x1) / 2;
  const dz = cz - (z0 + z1 + DECK_FRONT) / 2;
  const items = pa.items.map((it) => ({ name: it.name, x: it.x + dx, z: it.z + dz }));
  const frames = pa.frames.map((f) => ({ ...f, x: f.x + dx, z: f.z + dz }));
  const poolOf = new Map();
  let tiles;
  if (multi) {
    tiles = frames.map((f) => ({ name: f.name, kind: 'pool', x: f.x, z: f.z, w: f.w, d: f.d, groups: f.workers }));
    for (const f of frames) for (const w of f.workers) poolOf.set(w, f.name);
  } else {
    const name = [...pools][0] || 'workers';
    tiles = [{ name, kind: 'pool', x: x0 + dx, z: z0 + dz, w: x1 - x0, d: z1 - z0, groups: items.map((it) => it.name) }];
    for (const it of items) poolOf.set(it.name, name);
  }
  const deck = { items, frames, tiles, poolOf, width, depth, cx, cz };
  deck.gap = deckGap(agentDeck, deck);
  deck.y = -deck.gap;
  return deck;
}

// ------------------------------------------------------------------ flows

const SEP = '\u0000';

/** The key of an atespace -> pool pair. */
export function pairKey(atespace, pool) {
  return `${atespace}${SEP}${pool}`;
}

/**
 * Agents holding a worker, per (atespace, node pool) pair: what the flow
 * ribbons draw. Kept incrementally as agents get or lose a worker; pairs
 * that drop to zero stay (count 0, drawn as nothing) until clear(), so
 * churn doesn't reshuffle the ribbons. dirty collects the pairs changed
 * since the last take().
 */
export class FlowCounts {
  constructor() {
    /** @type {Map<string, {key: string, atespace: string, pool: string, count: number}>} */
    this.pairs = new Map();
    this.dirty = new Set();
    this.total = 0;
  }

  add(atespace, pool, n = 1) {
    if (pool === undefined || pool === null) return;
    const key = pairKey(atespace, pool);
    let p = this.pairs.get(key);
    if (!p) {
      p = { key, atespace, pool, count: 0 };
      this.pairs.set(key, p);
    }
    p.count = Math.max(0, p.count + n);
    this.total = Math.max(0, this.total + n);
    this.dirty.add(key);
  }

  get(atespace, pool) {
    return this.pairs.get(pairKey(atespace, pool))?.count || 0;
  }

  /** The biggest pair (ribbon widths scale against it). */
  max() {
    let m = 0;
    for (const p of this.pairs.values()) m = Math.max(m, p.count);
    return m;
  }

  /** Pairs with agents (count > 0). */
  live() {
    return [...this.pairs.values()].filter((p) => p.count > 0);
  }

  /** The dirty pair keys, cleared. */
  take() {
    const out = [...this.dirty];
    this.dirty.clear();
    return out;
  }

  clear() {
    this.pairs.clear();
    this.dirty.clear();
    this.total = 0;
  }
}

/**
 * Ribbon width (world units) and strength (0..1, drives alpha) for a pair
 * of count agents when the biggest pair has max: area-true (square root),
 * never thinner than a hairline. widthMax: the widest ribbon.
 */
export function ribbonSize(count, max, widthMax) {
  if (count <= 0 || max <= 0) return { width: 0, strength: 0 };
  const s = Math.sqrt(count / max);
  return { width: Math.max(widthMax * 0.08, widthMax * s), strength: 0.25 + 0.75 * s };
}

// -------------------------------------------------------------- highlight

/**
 * A beam's highlight level (workers.js HI, plus 3 for the agent itself):
 * the selected or hovered agent's own beam is brightest; a hovered or
 * pinned worker lights its agents' beams and dims the rest; an agent in
 * focus gives its siblings on the same worker a subtle lift.
 */
export function beamLevel(focus, agentWorker, own) {
  if (own) return 3;
  return levelOf(focus, agentWorker);
}

/**
 * A ribbon's highlight level for a hovered tile ({kind: 'atespace'|'pool',
 * name}) and the worker in focus's pool: a ribbon touching the hovered tile
 * is lit and the others dim; without a hovered tile, a strongly focused
 * worker's pool lights its ribbons softly.
 */
export function ribbonLevel(pair, tile, focusPool = null, strong = false) {
  if (tile) {
    const hit = tile.kind === 'atespace' ? pair.atespace === tile.name : pair.pool === tile.name;
    return hit ? HI.LIT : HI.DIM;
  }
  if (focusPool && strong) return pair.pool === focusPool ? HI.SIBLING : HI.NONE;
  return HI.NONE;
}

/**
 * The tiles a hovered tile lights: itself and every tile at the other end
 * of one of its ribbons that carries agents.
 * @returns {{atespaces: Set<string>, pools: Set<string>}}
 */
export function litTiles(flows, tile) {
  const out = { atespaces: new Set(), pools: new Set() };
  if (!tile) return out;
  (tile.kind === 'atespace' ? out.atespaces : out.pools).add(tile.name);
  for (const p of flows.pairs.values()) {
    if (p.count <= 0) continue;
    if (tile.kind === 'atespace' && p.atespace === tile.name) out.pools.add(p.pool);
    if (tile.kind === 'pool' && p.pool === tile.name) out.atespaces.add(p.atespace);
  }
  return out;
}

/** True when two hovered tiles are the same (or both none). */
export function sameTile(a, b) {
  return (!a && !b) || (!!a && !!b && a.kind === b.kind && a.name === b.name);
}

// ------------------------------------------------------------------ beams

/**
 * Most individual beams drawn at once; beyond it the nearest in view are
 * kept and the ribbons carry the rest. A 100,000-agent cluster has about
 * 10,000 agents holding a worker: more beams than read as beams.
 */
export const BEAM_BUDGET = 4000;
/** Seconds a beam takes to drop (wake) or retract (suspend). */
export const BEAM_DROP = 0.7;

/**
 * Which agents get a beam: every agent holding a worker while they fit the
 * budget; else the nearest ones (nearest: keys in nearest-first order, from
 * the level-of-detail pass), plus the ones that must show (focus, selection).
 * @param {Set<string>|string[]} holders agents holding a worker
 * @param {number} budget
 * @param {() => string[]} nearest
 * @param {Iterable<string>} must
 * @returns {{keys: Set<string>, trimmed: boolean}}
 */
export function beamSet(holders, budget, nearest, must = []) {
  const all = holders instanceof Set ? holders : new Set(holders);
  if (all.size <= budget) return { keys: new Set(all), trimmed: false };
  const keys = new Set();
  for (const k of must) if (all.has(k)) keys.add(k);
  for (const k of nearest()) {
    if (keys.size >= budget) break;
    if (all.has(k)) keys.add(k);
  }
  return { keys, trimmed: true };
}
