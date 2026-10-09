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

// The two-decks layout: the worker deck's geometry, beam and ribbon
// counts, the highlight rules, the beam budget, the beam and ribbon
// layers, and switching layouts disposing what the other layout built.

import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../hack/three-hooks.mjs', import.meta.url);
const THREE = await import('three');
const D = await import('./decks.js');
const W = await import('./workers.js');
const S = await import('./synth.js');
const { Model } = await import('./model.js');
const { BeamSet, RibbonSet } = await import('./beams.js');
const { buildWorkerDeck } = await import('./island.js');
const { THEMES } = await import('./themes.js');
const { compact } = await import('./format.js');
const { Scene } = await import('./scene.js');

const PAD_W = 3.2;
const PAD_D = 1.8;

function resources(obj) {
  const out = new Set();
  obj.traverse((o) => {
    if (o.geometry) out.add(o.geometry);
    for (const m of [o.material].flat()) if (m) out.add(m);
  });
  return out;
}

function watch(things) {
  const disposed = new Set();
  for (const t of things) t.addEventListener('dispose', () => disposed.add(t));
  return disposed;
}

function fakeLabel(cls) {
  const o = new THREE.Object3D();
  const classes = new Set([cls]);
  o.element = {
    innerHTML: '',
    removed: false,
    classList: { add: (...c) => c.forEach((x) => classes.add(x)), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    remove() {
      this.removed = true;
    },
  };
  o.center = new THREE.Vector2();
  o.isCSS2DObject = true;
  return o;
}

function fakeText() {
  return new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshBasicMaterial({ transparent: true }));
}

const agentDeck = { cx: -1.2, cz: 0.4, width: 300, depth: 190 };

// ----------------------------------------------------------- geometry

test('worker deck: every pad on the slab, none overlapping, pools framed, a gap below the agent deck', () => {
  for (const [n, count] of [
    [12, 12],
    [5000, 2000],
  ]) {
    const workers = S.syntheticWorkers(n * 10, S.rng(3), { workers: count });
    const deck = D.planWorkerDeck(workers, agentDeck);
    assert.equal(deck.items.length, count);
    // Below the agent deck by the gap, centered left to right, front edges lined up.
    assert.ok(deck.y < 0 && Math.abs(deck.y + deck.gap) < 1e-9);
    assert.ok(deck.gap >= 16);
    assert.ok(Math.abs(deck.cx - agentDeck.cx) < 1e-9);
    assert.ok(Math.abs(deck.cz + deck.depth / 2 - (agentDeck.cz + agentDeck.depth / 2)) < 1e-9, 'front edges line up');
    const x0 = deck.cx - deck.width / 2;
    const z0 = deck.cz - deck.depth / 2;
    for (const it of deck.items) {
      assert.ok(it.x - PAD_W / 2 >= x0 && it.x + PAD_W / 2 <= x0 + deck.width, `${it.name} inside in x`);
      assert.ok(it.z - PAD_D / 2 >= z0 && it.z + PAD_D / 2 <= z0 + deck.depth, `${it.name} inside in z`);
    }
    // Pads never overlap (grid hash on pad cells).
    const seen = new Map();
    for (const it of deck.items) {
      const k = `${Math.round(it.x * 10)},${Math.round(it.z * 10)}`;
      assert.ok(!seen.has(k), `${it.name} and ${seen.get(k)} share a spot`);
      seen.set(k, it.name);
    }
    const sorted = [...deck.items].sort((a, b) => a.z - b.z || a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      if (Math.abs(a.z - b.z) < PAD_D) assert.ok(Math.abs(a.x - b.x) >= PAD_W, `${a.name} / ${b.name}`);
    }
    // Roughly landscape, whatever the count.
    assert.ok(deck.width / deck.depth > 0.9 && deck.width / deck.depth < 3.5, `${deck.width}x${deck.depth}`);
    // One far tile per pool, holding exactly its workers; every worker maps to its tile.
    const pools = new Set(workers.map((w) => w.pool));
    assert.equal(deck.tiles.length, pools.size);
    assert.equal(deck.frames.length, pools.size > 1 ? pools.size : 0);
    const inTiles = deck.tiles.flatMap((t) => t.groups);
    assert.equal(new Set(inTiles).size, count);
    for (const w of workers) assert.ok(deck.tiles.find((t) => t.name === deck.poolOf.get(w.name))?.groups.includes(w.name));
    // Each pad sits inside its pool's tile.
    const at = new Map(deck.items.map((it) => [it.name, it]));
    for (const t of deck.tiles) {
      for (const name of t.groups) {
        const it = at.get(name);
        assert.ok(it.x >= t.x && it.x <= t.x + t.w && it.z >= t.z && it.z <= t.z + t.d, `${name} in ${t.name}`);
      }
    }
  }
});

test('worker deck: no workers still plans a small deck; the gap grows with the decks', () => {
  const deck = D.planWorkerDeck([], agentDeck);
  assert.equal(deck.items.length, 0);
  assert.ok(deck.width > 0 && deck.depth > 0);
  const small = D.deckGap({ depth: 20 }, { depth: 10 });
  const big = D.deckGap({ depth: 500 }, { depth: 200 });
  assert.ok(small >= 16 && big > small && big <= 420);
});

test('layouts and deck views: ids, keys and fades', () => {
  assert.equal(D.layoutId('combined'), 'combined');
  assert.equal(D.layoutId('nope'), 'decks');
  assert.equal(D.layoutId(undefined), D.DEFAULT_LAYOUT);
  assert.deepEqual(D.deckAlphas('both'), { agents: 1, workers: 1 });
  assert.deepEqual(D.deckAlphas(D.DECK_KEYS[1]), { agents: 1, workers: 0 });
  assert.deepEqual(D.deckAlphas(D.DECK_KEYS[2]), { agents: 0, workers: 1 });
  assert.deepEqual(D.deckAlphas(D.DECK_KEYS[3]), { agents: 1, workers: 1 });
  assert.equal(D.deckViewId('sideways'), 'both');
});

// ----------------------------------------------------------- flows

test('flows: agents holding a worker per atespace -> pool pair, kept incrementally', () => {
  const m = new Model();
  m.applySnapshot(S.syntheticSnapshot(20000, 7, { workers: 300 }));
  const deck = D.planWorkerDeck([...m.workers.values()], agentDeck);
  const flows = new D.FlowCounts();
  let holders = 0;
  for (const a of m.agents.values()) {
    if (!a.worker) continue;
    holders++;
    flows.add(a.atespace, deck.poolOf.get(a.worker), 1);
  }
  assert.equal(flows.total, holders);
  assert.equal(flows.live().reduce((s, p) => s + p.count, 0), holders, 'every holder in exactly one ribbon');
  // Brute force: the same counts.
  const brute = new Map();
  for (const a of m.agents.values()) {
    if (!a.worker) continue;
    const k = D.pairKey(a.atespace, deck.poolOf.get(a.worker));
    brute.set(k, (brute.get(k) || 0) + 1);
  }
  for (const [k, n] of brute) assert.equal(flows.pairs.get(k).count, n);
  assert.ok(flows.pairs.size <= m.atespaces.size * deck.tiles.length);
  // A suspend takes one away, a wake on another pool adds one; both pairs are dirty.
  flows.take();
  const a = [...m.agents.values()].find((x) => x.worker);
  const pool = deck.poolOf.get(a.worker);
  const other = deck.tiles.find((t) => t.name !== pool).name;
  const before = flows.get(a.atespace, pool);
  flows.add(a.atespace, pool, -1);
  flows.add(a.atespace, other, 1);
  assert.equal(flows.get(a.atespace, pool), before - 1);
  assert.deepEqual(flows.take().sort(), [D.pairKey(a.atespace, pool), D.pairKey(a.atespace, other)].sort());
  assert.deepEqual(flows.take(), []);
  // An unknown worker (no pool) never counts; zero pairs stay, drawn as nothing.
  flows.add('x', undefined, 1);
  assert.equal(flows.get('x', undefined), 0);
  flows.add('lone', other, 1);
  flows.add('lone', other, -1);
  assert.ok(flows.pairs.has(D.pairKey('lone', other)));
  assert.ok(!flows.live().some((p) => p.atespace === 'lone'));
  flows.clear();
  assert.equal(flows.pairs.size, 0);
  assert.equal(flows.total, 0);
});

test('ribbon sizes: area-true, never thinner than a hairline, nothing for empty pairs', () => {
  assert.deepEqual(D.ribbonSize(0, 10, 8), { width: 0, strength: 0 });
  const full = D.ribbonSize(100, 100, 8);
  const quarter = D.ribbonSize(25, 100, 8);
  const tiny = D.ribbonSize(1, 1e6, 8);
  assert.equal(full.width, 8);
  assert.ok(Math.abs(quarter.width - 4) < 1e-9, 'a quarter of the agents: half the width');
  assert.ok(tiny.width >= 8 * 0.08 && tiny.width < 1);
  assert.ok(full.strength === 1 && quarter.strength < 1 && tiny.strength >= 0.25);
});

// ----------------------------------------------------------- highlight

test('highlight: beams light for the agent, its worker and that worker\'s agents; ribbons for the hovered tile', () => {
  const { HI } = W;
  const none = { worker: null, strong: false };
  const pinned = { worker: 'w-1', strong: true };
  const soft = { worker: 'w-1', strong: false };
  // Beams.
  assert.equal(D.beamLevel(none, 'w-1', false), HI.NONE);
  assert.equal(D.beamLevel(none, 'w-1', true), 3, 'the selected or hovered agent: brightest');
  assert.equal(D.beamLevel(pinned, 'w-1', false), HI.LIT, 'a pinned worker lights its agents');
  assert.equal(D.beamLevel(pinned, 'w-2', false), HI.DIM, '...and dims the rest');
  assert.equal(D.beamLevel(soft, 'w-1', false), HI.SIBLING, 'an agent in focus lifts its siblings');
  assert.equal(D.beamLevel(soft, 'w-2', false), HI.NONE, '...and dims nothing');
  // Ribbons.
  const p = { atespace: 'payments', pool: 'general-a', count: 5 };
  assert.equal(D.ribbonLevel(p, null), HI.NONE);
  assert.equal(D.ribbonLevel(p, { kind: 'atespace', name: 'payments' }), HI.LIT);
  assert.equal(D.ribbonLevel(p, { kind: 'atespace', name: 'search' }), HI.DIM);
  assert.equal(D.ribbonLevel(p, { kind: 'pool', name: 'general-a' }), HI.LIT);
  assert.equal(D.ribbonLevel(p, { kind: 'pool', name: 'spot-b' }), HI.DIM);
  assert.equal(D.ribbonLevel(p, null, 'general-a', true), HI.SIBLING, 'a pinned worker lifts its pool\'s ribbons');
  assert.equal(D.ribbonLevel(p, null, 'general-a', false), HI.NONE);
  // Lit tiles: the hovered one and the other ends of its ribbons that carry agents.
  const flows = new D.FlowCounts();
  flows.add('payments', 'general-a', 3);
  flows.add('payments', 'spot-b', 1);
  flows.add('search', 'general-a', 2);
  flows.add('docs', 'spot-b', 1);
  flows.add('docs', 'spot-b', -1);
  const a = D.litTiles(flows, { kind: 'atespace', name: 'payments' });
  assert.deepEqual([...a.atespaces], ['payments']);
  assert.deepEqual([...a.pools].sort(), ['general-a', 'spot-b']);
  const b = D.litTiles(flows, { kind: 'pool', name: 'spot-b' });
  assert.deepEqual([...b.atespaces], ['payments'], 'docs carries no agents to spot-b any more');
  assert.deepEqual([...b.pools], ['spot-b']);
  assert.equal(D.litTiles(flows, null).atespaces.size, 0);
  assert.ok(D.sameTile(null, null) && D.sameTile({ kind: 'pool', name: 'x' }, { kind: 'pool', name: 'x' }));
  assert.ok(!D.sameTile({ kind: 'pool', name: 'x' }, { kind: 'atespace', name: 'x' }) && !D.sameTile(null, { kind: 'pool', name: 'x' }));
});

test('beam budget: every holder while they fit, else the nearest plus the ones that must show', () => {
  const holders = new Set(Array.from({ length: 50 }, (_, i) => `a${i}`));
  const all = D.beamSet(holders, 100, () => assert.fail('no nearest pass under the budget'));
  assert.equal(all.keys.size, 50);
  assert.equal(all.trimmed, false);
  const near = () => Array.from({ length: 50 }, (_, i) => `a${i}`);
  const cut = D.beamSet(holders, 10, near, ['a49', 'not-a-holder']);
  assert.equal(cut.trimmed, true);
  assert.equal(cut.keys.size, 10);
  assert.ok(cut.keys.has('a49'), 'the selected agent keeps its beam');
  assert.ok(!cut.keys.has('not-a-holder'));
  assert.ok(cut.keys.has('a0') && !cut.keys.has('a20'), 'nearest first');
});

// ----------------------------------------------------------- layers

test('beams: drop, retract and expire; swap-remove; growth; dispose', () => {
  const parent = new THREE.Group();
  const time = { value: 0 };
  const beams = new BeamSet(parent, time, {}, { value: 1 });
  const at = (i) => ({ x: i, y: 0.1, z: 0 });
  const pad = { x: 0, y: -20, z: 5 };
  for (let i = 0; i < 300; i++) beams.set(`a${i}`, at(i), pad, 0, 1, 0.5, i);
  assert.equal(beams.count, 300);
  assert.equal(beams.lines.geometry.instanceCount, 300);
  // A wake: the beam's animation starts dropping now.
  time.value = 5;
  beams.set('a7', at(7), pad, 0, 1, 0.5, 7, 5);
  const anim = (k) => {
    const i = beams.set_.slots.get(k);
    return [...beams.set_.attrs.aAnim.array.slice(i * 2, i * 2 + 2)];
  };
  assert.deepEqual(anim('a7'), [5, 1]);
  // A suspend: retracts, then goes away when the animation ends.
  assert.ok(beams.retract('a3', 6, 0.7));
  assert.deepEqual(anim('a3'), [6, -1]);
  beams.expire(6.5);
  assert.ok(beams.has('a3'));
  beams.expire(6.8);
  assert.ok(!beams.has('a3'));
  assert.equal(beams.count, 299);
  // Woken again while retracting: the beam stays (no expiry).
  beams.retract('a4', 7, 0.7);
  beams.set('a4', at(4), pad, 0, 1, 0.5, 4, 7.2);
  beams.expire(9);
  assert.ok(beams.has('a4'));
  // The last beam moved into the hole kept its endpoints.
  const i = beams.set_.slots.get('a299');
  assert.equal(beams.set_.attrs.aFrom.array[i * 3], 299);
  // Class changes rewrite one float.
  beams.setClass('a5', 2);
  assert.equal(beams.set_.attrs.aMeta.array[beams.set_.slots.get('a5') * 4], 2);
  const all = resources(parent);
  const disposed = watch(all);
  beams.dispose();
  assert.equal(disposed.size, all.size);
  assert.equal(parent.children.length, 0);
});

test('ribbons: one instance per pair, zero width hides, levels rewrite, dispose', () => {
  const parent = new THREE.Group();
  const ribbons = new RibbonSet(parent, { value: 0 }, {}, { value: 1 });
  for (let i = 0; i < 40; i++) ribbons.set(`p${i}`, { x: i, y: -2, z: 0 }, { x: 0, y: -30, z: 4 }, i % 5 === 0 ? 0 : 1 + i * 0.1, 0.5, 0, 0.3);
  assert.equal(ribbons.count, 40);
  assert.equal(ribbons.visibleCount, 32);
  ribbons.setLevel('p3', 2);
  assert.equal(ribbons.set_.attrs.aInfo.array[ribbons.set_.slots.get('p3') * 4 + 2], 2);
  ribbons.remove('p3');
  assert.equal(ribbons.count, 39);
  const all = resources(parent);
  const disposed = watch(all);
  ribbons.dispose();
  assert.equal(disposed.size, all.size);
  assert.equal(parent.children.length, 0);
});

test('switching layouts disposes the decks\' layers and the worker deck, every time', () => {
  // The scene's own create/dispose methods, on a stand-in for the scene
  // (the real one needs a WebGL canvas).
  const world = new THREE.Group();
  const workerDeck = new THREE.Group();
  const fake = {
    world,
    workerDeck,
    time: { value: 0 },
    look: {},
    fade: { agents: { value: 1 }, workers: { value: 1 }, beams: { value: 1 } },
    beams: null,
    applyFlow() {},
    styleDecks() {},
  };
  const ensure = Scene.prototype.ensureDeckLayers;
  const dispose = Scene.prototype.disposeDeckLayers;
  const ground = new THREE.Group();
  const workers = S.syntheticWorkers(50000, S.rng(1), { workers: 500 });
  const deck = D.planWorkerDeck(workers, agentDeck);
  let counts = null;
  for (let i = 0; i < 4; i++) {
    ensure.call(fake);
    ensure.call(fake);
    assert.ok(fake.beams && fake.ribbons && fake.workerTiles);
    assert.ok(fake.needCompile, 'new layers ask for a shader warm-up');
    const theme = THEMES[i % THEMES.length];
    buildWorkerDeck(ground, deck, theme, { blending: THREE.NormalBlending, makeLabel: fakeLabel, makeText: fakeText });
    const now = { world: world.children.length, deck: workerDeck.children.length, ground: ground.children.length };
    if (counts) assert.deepEqual(now, counts, 'no growth from switch to switch');
    counts = now;
    assert.equal(ground.children.filter((c) => c.isCSS2DObject).length, deck.frames.length, 'one label per pool frame');
    // Back to 'combined': everything the decks built goes.
    const all = new Set([...resources(world), ...resources(workerDeck), ...resources(ground)]);
    const labels = ground.children.filter((c) => c.isCSS2DObject).map((c) => c.element);
    const disposed = watch(all);
    dispose.call(fake);
    dispose.call(fake);
    buildWorkerDeck(ground, deck, theme, { blending: THREE.NormalBlending, makeLabel: fakeLabel, makeText: fakeText });
    const kept = resources(ground);
    for (const r of kept) all.delete(r);
    ground.clear();
    assert.equal(fake.beams, null);
    assert.equal(world.children.length, 0, 'beams and ribbons removed');
    assert.equal(workerDeck.children.length, 0, 'pool tiles removed');
    assert.ok([...all].every((r) => disposed.has(r)), 'every geometry and material disposed');
    assert.ok(labels.every((l) => l.removed), 'pool labels removed');
  }
});

test('header counts stay short at scale', () => {
  assert.equal(compact(0), '0');
  assert.equal(compact(9876), '9,876');
  assert.equal(compact(10234), '10.2k');
  assert.equal(compact(89512), '89.5k');
  assert.equal(compact(99960), '100k');
  assert.equal(compact(100000), '100k');
  assert.equal(compact(1250000), '1.3M');
});
