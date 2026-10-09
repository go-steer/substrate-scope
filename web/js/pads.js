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

// Worker pads: one small platform per worker with a fill bar for its actor
// slots (and CPU and memory when the worker reports them), a glow while it
// hosts agents, and a label that grows into a card when the worker is in
// focus. Geometries are shared by every pad; each pad owns three materials,
// disposed with it. Labels come from a factory (CSS2DObject in the browser),
// so node tests can build and dispose pads without a DOM.

import * as THREE from 'three';
import { esc, workerLabel } from './format.js';
import { formatCPU, formatBytes } from './workers.js';

/** Pad size in world units. */
export const PAD_W = 3.2;
export const PAD_D = 1.8;
const PAD_H = 0.3;
const BAR_W = PAD_W - 0.5;
/** Fill at or above which a bar shows as full. */
export const FULL = 0.9;

function pct(f) {
  return `${Math.round(Math.min(f, 9.99) * 100)}%`;
}

/** The label's HTML: compact (name, agents) or a card (in focus). */
export function padLabelHTML(worker, usage, card) {
  const name = esc(workerLabel(worker));
  const n = usage.actors.used;
  const state = worker.state && worker.state !== 'ACTIVE' ? `<span class="badge">${esc(worker.state.toLowerCase())}</span>` : '';
  const agents = `${n} agent${n === 1 ? '' : 's'}`;
  if (!card) return `<div class="name">${name}${state}</div><div class="meta">${agents}${usage.actors.cap ? ` / ${usage.actors.cap}` : ''}</div>`;
  const bar = (label, u, text) =>
    `<div class="use"><span class="k">${label}</span><span class="bar${u.frac >= FULL ? ' full' : ''}"><i style="width:${Math.min(100, u.frac * 100).toFixed(0)}%"></i></span><span class="v">${text}</span></div>`;
  // A resource the worker doesn't report allocation for says so instead of
  // drawing an empty bar (ax tasks declare no limits, so real workers
  // allocate nothing even while they host agents).
  const missing = (label, u, fmt) =>
    `<div class="use unreported"><span class="k">${label}</span><span class="na">not reported</span><span class="v">${Number.isFinite(u?.cap) ? `capacity ${fmt(u.cap)}` : ''}</span></div>`;
  const rows = [];
  if (usage.actors.cap) rows.push(bar('Slots', usage.actors, `${n} / ${usage.actors.cap}`));
  if (usage.cpu?.reported) rows.push(bar('CPU', usage.cpu, `${formatCPU(usage.cpu.used)} / ${formatCPU(usage.cpu.cap)} · ${pct(usage.cpu.frac)}`));
  else rows.push(missing('CPU', usage.cpu, formatCPU));
  if (usage.memory?.reported) rows.push(bar('Memory', usage.memory, `${formatBytes(usage.memory.used)} / ${formatBytes(usage.memory.cap)}`));
  else rows.push(missing('Memory', usage.memory, formatBytes));
  const node = worker.node ? `<div class="node">on ${esc(worker.node)}</div>` : '';
  return `<div class="name">${name}${state}</div>${node}<div class="meta">${agents}${usage.actors.cap ? '' : ' · capacity unknown'}</div>${rows.join('')}`;
}

export class WorkerPads {
  /**
   * @param {THREE.Object3D} parent
   * @param {(className: string) => THREE.Object3D & {element: HTMLElement}} makeLabel
   */
  constructor(parent, makeLabel) {
    this.parent = parent;
    this.makeLabel = makeLabel;
    /** @type {Map<string, object>} */
    this.pads = new Map();
    this.geo = {
      pad: new THREE.BoxGeometry(PAD_W, PAD_H, PAD_D),
      edges: new THREE.EdgesGeometry(new THREE.BoxGeometry(PAD_W + 0.04, PAD_H + 0.02, PAD_D + 0.04)),
      glow: new THREE.PlaneGeometry(PAD_W - 0.4, PAD_D - 0.4).rotateX(-Math.PI / 2),
      // A unit bar anchored at its left end, so scale.x is the fill.
      bar: new THREE.BoxGeometry(1, 0.05, 0.16).translate(0.5, 0, 0),
    };
    this.mat = {
      track: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 }),
      fill: new THREE.MeshBasicMaterial(),
      full: new THREE.MeshBasicMaterial(),
    };
    this.focus = { worker: null, strong: false };
  }

  /**
   * Creates, moves and updates pads; removes pads of workers not in items.
   * @param {{worker: object, x: number, z: number, usage: object}[]} items
   */
  sync(items, theme, blending, { cardAbove = false } = {}) {
    this.theme = theme;
    this.blending = blending;
    this.cardAbove = cardAbove;
    this.mat.track.color.set(theme.worker.track);
    this.mat.fill.color.set(theme.worker.fill);
    this.mat.full.color.set(theme.worker.full);
    const want = new Set(items.map((it) => it.worker.name));
    for (const name of [...this.pads.keys()]) if (!want.has(name)) this.removePad(name);
    for (const it of items) {
      let p = this.pads.get(it.worker.name);
      if (!p) p = this.addPad(it.worker.name);
      p.worker = it.worker;
      p.usage = it.usage;
      p.group.position.set(it.x, 0, it.z);
      p.pos = new THREE.Vector3(it.x, PAD_H + 0.02, it.z);
      this.layoutBars(p);
      this.style(p);
    }
  }

  addPad(name) {
    const group = new THREE.Group();
    const pad = new THREE.Mesh(this.geo.pad, new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.5 }));
    pad.position.y = PAD_H / 2;
    pad.castShadow = true;
    pad.receiveShadow = true;
    pad.userData.worker = name;
    const edges = new THREE.LineSegments(this.geo.edges, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 }));
    edges.position.y = PAD_H / 2;
    const glow = new THREE.Mesh(this.geo.glow, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    glow.position.y = PAD_H + 0.01;
    group.add(pad, edges, glow);
    // Up to three bars (slots, CPU, memory) along the pad's front edge.
    const bars = [];
    for (let i = 0; i < 3; i++) {
      const track = new THREE.Mesh(this.geo.bar, this.mat.track);
      const fill = new THREE.Mesh(this.geo.bar, this.mat.fill);
      track.visible = fill.visible = false;
      group.add(track, fill);
      bars.push({ track, fill });
    }
    const label = this.makeLabel('worker-label');
    group.add(label);
    this.parent.add(group);
    const p = { name, group, pad, edges, glow, bars, label };
    this.pads.set(name, p);
    return p;
  }

  removePad(name) {
    const p = this.pads.get(name);
    if (!p) return;
    this.parent.remove(p.group);
    for (const m of [p.pad.material, p.edges.material, p.glow.material]) m.dispose();
    p.label.element?.remove?.();
    p.group.remove(p.label);
    this.pads.delete(name);
  }

  /** Bars for the usage the worker reports: slots, then CPU and memory. */
  layoutBars(p) {
    const fill = (u) => (u?.reported ? u.frac : null);
    const fills = [p.usage.actors.cap ? p.usage.actors.frac : null, fill(p.usage.cpu), fill(p.usage.memory)].filter((f) => f !== null);
    p.bars.forEach((b, i) => {
      const f = fills[i];
      const on = f !== undefined;
      b.track.visible = b.fill.visible = on;
      if (!on) return;
      const z = PAD_D / 2 - 0.2 - i * 0.24;
      b.track.position.set(-BAR_W / 2, PAD_H + 0.03, z);
      b.track.scale.set(BAR_W, 1, 1);
      b.fill.position.set(-BAR_W / 2, PAD_H + 0.045, z);
      b.fill.scale.set(Math.max(0.001, Math.min(1, f)) * BAR_W, 1.2, 0.8);
      b.fill.material = f >= FULL ? this.mat.full : this.mat.fill;
    });
  }

  /** Pad colors from the theme, its state, what it hosts and the focus. */
  style(p) {
    const t = this.theme;
    const light = !t.glow.additive;
    const hosted = p.usage.actors.used;
    const focused = this.focus.worker === p.name;
    const strong = focused && this.focus.strong;
    p.pad.material.color.set(hosted ? t.worker.pad : t.worker.idle);
    p.pad.material.roughness = light ? 0.85 : 0.45;
    p.pad.material.metalness = light ? 0 : 0.5;
    p.edges.material.color.set(focused ? t.worker.highlight : t.worker.padEdge);
    p.edges.material.opacity = focused ? 1 : 0.55;
    p.edges.material.blending = this.blending;
    p.glow.material.blending = this.blending;
    const draining = p.worker.state === 'DRAINING';
    let a = hosted ? (0.06 + Math.min(hosted, 8) * 0.02) * (light ? 2.5 : 1) : 0;
    if (focused) a = strong ? (light ? 0.55 : 0.6) : light ? 0.35 : 0.4;
    p.glow.material.opacity = a;
    p.glow.material.color.set(focused ? t.worker.highlight : draining ? t.worker.draining : t.worker.active);
    p.group.scale.setScalar(strong ? 1.08 : 1);
    // A compact label sits in front of the pad; a card hangs below it, or
    // rises above it where agents stand in front of the pad (worker view).
    if (!strong) {
      p.label.position.set(0, 0.2, PAD_D / 2 + 0.75);
      p.label.center?.set(0.5, 0.5);
    } else if (this.cardAbove) {
      p.label.position.set(0, 0.5, -PAD_D / 2);
      p.label.center?.set(0.5, 1);
    } else {
      p.label.position.set(0, 0.2, PAD_D / 2 + 0.25);
      p.label.center?.set(0.5, 0);
    }
    const el = p.label.element;
    if (el) {
      const html = padLabelHTML(p.worker, p.usage, strong);
      if (el.innerHTML !== html) el.innerHTML = html;
      el.classList?.toggle('card', strong);
      el.classList?.toggle('focused', focused);
      el.classList?.toggle('draining', draining);
    }
  }

  /** Sets the worker in focus and restyles the pads it changes. */
  setFocus(focus) {
    const before = this.focus.worker;
    this.focus = { ...focus };
    if (!this.theme) return;
    for (const name of new Set([before, focus.worker])) {
      const p = name && this.pads.get(name);
      if (p) this.style(p);
    }
  }

  get(name) {
    return this.pads.get(name);
  }

  /** The pad meshes, for raycasting. */
  pickable() {
    return [...this.pads.values()].map((p) => p.pad);
  }

  dispose() {
    for (const name of [...this.pads.keys()]) this.removePad(name);
    for (const g of Object.values(this.geo)) g.dispose();
    for (const m of Object.values(this.mat)) m.dispose();
  }
}
