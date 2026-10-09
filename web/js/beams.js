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

// The two decks' connections. Beams: a thin line of light from each agent
// that holds a worker down to its worker's pad, in the agent's state color,
// with a soft pulse flowing down it; a beam drops when its agent wakes and
// retracts when it suspends. Ribbons: zoomed out, a flat band from each
// atespace tile down to each node-pool tile, as wide and bright as the
// number of running agents on that pair. Both are one instanced draw each,
// computed on the GPU from per-instance endpoints, and both fade per pixel
// with the level of detail (beams where their agent's cell is too small to
// see, ribbons where it is big enough for beams). Keyed instances with
// swap-remove, like the links. Pure three.js (no DOM), so node tests can
// build them.

import * as THREE from 'three';
import { CLASSES } from './model.js';
import { CELL } from './layout.js';
import { DirtyRanges, uploadRanges } from './dirty.js';

/** Segments along a ribbon. */
export const RIBBON_SEGMENTS = 12;

/**
 * Instances keyed by a string, packed at the front of their attributes
 * (remove moves the last instance into the hole). attrs: name -> item size.
 */
class Keyed {
  constructor(object, sizes, cap = 64) {
    this.object = object;
    this.sizes = sizes;
    this.slots = new Map();
    this.keys = [];
    this.attrs = null;
    this.capacity = 0;
    // Only the instances written since the last flush upload (a wake or a
    // suspend touches one beam, not all 10,000).
    this.ranges = new DirtyRanges();
    this.allocate(cap);
  }

  get count() {
    return this.keys.length;
  }

  allocate(cap) {
    const old = this.attrs;
    const attrs = {};
    for (const [name, size] of Object.entries(this.sizes)) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      if (old) a.array.set(old[name].array.subarray(0, this.keys.length * size));
      attrs[name] = a;
    }
    // A fresh geometry: three.js caches buffer sizes per geometry.
    const g = this.object.geometry;
    const fresh = new THREE.InstancedBufferGeometry();
    fresh.setAttribute('position', g.getAttribute('position'));
    if (g.index) fresh.setIndex(g.index);
    for (const [name, a] of Object.entries(attrs)) fresh.setAttribute(name, a);
    fresh.instanceCount = this.keys.length;
    this.object.geometry = fresh;
    g.dispose();
    this.attrs = attrs;
    this.capacity = cap;
    this.ranges.markAll();
  }

  /** The slot of key, created when missing. */
  slot(key) {
    let i = this.slots.get(key);
    if (i === undefined) {
      if (this.keys.length >= this.capacity) this.allocate(this.capacity * 2);
      i = this.keys.length;
      this.keys.push(key);
      this.slots.set(key, i);
      this.object.geometry.instanceCount = this.keys.length;
    }
    return i;
  }

  write(i, name, values) {
    this.attrs[name].array.set(values, i * this.sizes[name]);
    this.ranges.mark(i);
  }

  /** Marks instance i written (after writing its arrays directly). */
  mark(i) {
    this.ranges.mark(i);
  }

  has(key) {
    return this.slots.has(key);
  }

  remove(key) {
    const i = this.slots.get(key);
    if (i === undefined) return false;
    const last = this.keys.length - 1;
    if (i !== last) {
      const moved = this.keys[last];
      this.keys[i] = moved;
      this.slots.set(moved, i);
      for (const [name, size] of Object.entries(this.sizes)) this.attrs[name].array.copyWithin(i * size, last * size, last * size + size);
    }
    this.keys.pop();
    this.slots.delete(key);
    this.object.geometry.instanceCount = this.keys.length;
    if (i < this.keys.length) this.ranges.mark(i);
    return true;
  }

  clear() {
    this.keys.length = 0;
    this.slots.clear();
    this.object.geometry.instanceCount = 0;
  }

  flush() {
    const n = this.keys.length;
    let r = this.ranges.take(n);
    // "Everything" is the live instances, not the whole capacity.
    if (r === null) r = [{ start: 0, count: Math.max(1, n) }];
    uploadRanges(Object.values(this.attrs), r);
  }
}

const beamVertex = /* glsl */ `
attribute vec3 aFrom;
attribute vec3 aTo;
attribute vec4 aMeta; // class, worker index, seed, agent index
attribute vec2 aAnim; // start time, direction (1 drop, -1 retract, 0 none)
uniform float uTime;
uniform float uDrop;
uniform vec3 uColors[5];
uniform float uAlpha;
uniform float uHiAlpha;
uniform float uFocusW;
uniform float uFocusStrong;
uniform float uSelA;
uniform float uHoverA;
uniform float uScale;
uniform float uFarLo;
uniform float uFarHi;
uniform float uFade;
uniform vec2 uViewport;
uniform float uWidth;
varying float vT;
varying float vE;
varying float vA;
varying float vHi;
varying float vSeed;
varying float vLen;
varying float vAnim;
varying float vSide;
varying vec3 vCol;
void main() {
  float e = 1.0;
  if (aAnim.y > 0.5) e = clamp((uTime - aAnim.x) / uDrop, 0.0, 1.0);
  else if (aAnim.y < -0.5) e = 1.0 - clamp((uTime - aAnim.x) / uDrop, 0.0, 1.0);
  e = 1.0 - pow(1.0 - e, 3.0);
  float t = position.x * e;
  float hi = 0.0;
  if (uFocusW >= 0.0) {
    if (abs(aMeta.y - uFocusW) < 0.5) hi = uFocusStrong > 0.5 ? 2.0 : 1.0;
    else hi = uFocusStrong > 0.5 ? -1.0 : 0.0;
  }
  if (abs(aMeta.w - uSelA) < 0.5 || abs(aMeta.w - uHoverA) < 0.5) hi = 3.0;
  float a;
  if (hi > 2.5) a = 1.0;
  else if (hi > 1.5) a = uHiAlpha;
  else if (hi > 0.5) a = mix(uAlpha, uHiAlpha, 0.45);
  else if (hi < -0.5) a = uAlpha * 0.12;
  else a = uAlpha * (uFocusW >= 0.0 ? 0.7 : 1.0);
  // Beams give way to ribbons where their agent's cell gets too small on
  // screen (lit beams stay).
  vec4 mvA = viewMatrix * vec4(aFrom, 1.0);
  float px = ${CELL.toFixed(2)} * uScale / max(-mvA.z, 0.01);
  float far = 1.0 - smoothstep(uFarLo, uFarHi * 1.4, px);
  if (hi < 1.5) a *= 1.0 - far;
  vA = a * uFade;
  vT = t;
  vE = e;
  vHi = hi;
  vSeed = aMeta.z;
  vLen = distance(aFrom, aTo);
  vAnim = abs(aAnim.y) > 0.5 && e < 1.0 && e > 0.0 ? 1.0 : 0.0;
  vCol = uColors[int(aMeta.x + 0.5)];
  vSide = position.y;
  // A quad a few pixels wide along the projected segment (WebGL lines are
  // one pixel): both ends in view space, clipped to the near plane.
  vec4 va = mvA;
  vec4 vb = viewMatrix * vec4(mix(aFrom, aTo, e), 1.0);
  const float zn = -0.15;
  if ((va.z > zn && vb.z > zn) || vA < 0.004) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  if (va.z > zn) va = mix(va, vb, (va.z - zn) / (va.z - vb.z));
  if (vb.z > zn) vb = mix(vb, va, (vb.z - zn) / (vb.z - va.z));
  vec4 ca = projectionMatrix * va;
  vec4 cb = projectionMatrix * vb;
  vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * uViewport;
  float dl = length(d);
  d = dl > 1e-4 ? d / dl : vec2(1.0, 0.0);
  vec4 c = position.x < 0.5 ? ca : cb;
  float w = uWidth * (hi > 2.5 ? 2.4 : hi > 1.5 ? 1.8 : hi > 0.5 ? 1.35 : hi < -0.5 ? 0.8 : 1.0);
  c.xy += vec2(-d.y, d.x) * position.y * w / uViewport * c.w;
  gl_Position = c;
}`;

const beamFragment = /* glsl */ `
uniform float uTime;
uniform float uFlow;
uniform vec3 uHiColor;
uniform float uAdditive;
varying float vT;
varying float vE;
varying float vA;
varying float vHi;
varying float vSeed;
varying float vLen;
varying float vAnim;
varying float vSide;
varying vec3 vCol;
void main() {
  // A soft pulse every few units, flowing down toward the worker.
  float flow = uFlow > 0.5 ? pow(0.5 + 0.5 * sin(vT * vLen * 0.45 - uTime * 2.4 + vSeed * 6.2831), 8.0) : 0.0;
  // The falling tip glows while a beam drops or retracts.
  float tip = vAnim * smoothstep(vE - 0.12, vE, vT);
  vec3 col = mix(vCol, uHiColor, vHi > 1.5 ? 0.3 : 0.0);
  col *= 0.75 + 0.8 * flow * mix(0.6, 1.0, uAdditive) + 1.2 * tip;
  // Brightest leaving the agent, fading a little toward the worker.
  float a = vA * (0.7 + 0.3 * (1.0 - vT)) * (0.65 + 0.35 * flow) + tip * 0.6;
  // Soft across its width: a bright core.
  a *= 1.0 - smoothstep(0.25, 1.0, abs(vSide));
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, min(a, 1.0));
}`;

/** Beams keyed by agent: one instanced draw of screen-space quads. */
export class BeamSet {
  /**
   * @param {THREE.Object3D} parent
   * @param {{value: number}} timeUniform
   * @param {object} look shared level-of-detail uniforms (uScale, uFarLo, uFarHi)
   * @param {{value: number}} fade the deck fade (0 hides every beam)
   */
  constructor(parent, timeUniform, look, fade) {
    this.parent = parent;
    this.uniforms = {
      uTime: timeUniform,
      uDrop: { value: 0.7 },
      uColors: { value: CLASSES.map(() => new THREE.Color(0xffffff)) },
      uAlpha: { value: 0.2 },
      uHiAlpha: { value: 0.85 },
      uFocusW: { value: -1 },
      uFocusStrong: { value: 0 },
      uSelA: { value: -10 },
      uHoverA: { value: -10 },
      uFlow: { value: 1 },
      uHiColor: { value: new THREE.Color(0xffffff) },
      uAdditive: look.uAdditive || { value: 1 },
      uScale: look.uScale || { value: 600 },
      uFarLo: look.uFarLo || { value: 2.5 },
      uFarHi: look.uFarHi || { value: 5 },
      uFade: fade || { value: 1 },
      uViewport: { value: new THREE.Vector2(1280, 720) },
      uWidth: { value: 2 },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: beamVertex,
      fragmentShader: beamFragment,
      transparent: true,
      depthWrite: false,
      uniforms: this.uniforms,
    });
    // One quad per beam: (t, side) corners.
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    this.lines = new THREE.Mesh(g, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;
    parent.add(this.lines);
    this.set_ = new Keyed(this.lines, { aFrom: 3, aTo: 3, aMeta: 4, aAnim: 2 });
    /** key -> time the retracting beam goes away */
    this.retracting = new Map();
  }

  get count() {
    return this.set_.count;
  }

  get keys() {
    return this.set_.keys;
  }

  has(key) {
    return this.set_.has(key);
  }

  /**
   * Adds or moves a beam.
   * @param {string} key the agent
   * @param {{x, y, z}} from the agent end
   * @param {{x, y, z}} to the worker pad (world)
   * @param {number} cls class index (the color)
   * @param {number} worker worker index (focus test)
   * @param {number} seed 0..1
   * @param {number} idx the agent's point index (selection test)
   * @param {number} [drop] start time of a drop animation (undefined: none)
   */
  set(key, from, to, cls, worker, seed, idx, drop) {
    const s = this.set_;
    const fresh = !s.has(key);
    const i = s.slot(key);
    s.write(i, 'aFrom', [from.x, from.y, from.z]);
    s.write(i, 'aTo', [to.x, to.y, to.z]);
    s.write(i, 'aMeta', [cls, worker, seed, idx]);
    if (drop !== undefined) s.write(i, 'aAnim', [drop, 1]);
    else if (fresh || this.retracting.has(key)) s.write(i, 'aAnim', [0, 0]);
    this.retracting.delete(key);
  }

  /** A beam's class changed (its color). */
  setClass(key, cls) {
    const i = this.set_.slots.get(key);
    if (i === undefined) return;
    this.set_.attrs.aMeta.array[i * 4] = cls;
    this.set_.mark(i);
  }

  /** Moves a beam's agent end. */
  setFrom(key, x, y, z) {
    const i = this.set_.slots.get(key);
    if (i === undefined) return;
    this.set_.write(i, 'aFrom', [x, y, z]);
  }

  /** Starts retracting a beam at time t; it goes away dur seconds later. */
  retract(key, t, dur) {
    const i = this.set_.slots.get(key);
    if (i === undefined) return false;
    this.set_.write(i, 'aAnim', [t, -1]);
    this.retracting.set(key, t + dur);
    return true;
  }

  /** Drops the beams whose retraction ended by time t. */
  expire(t) {
    for (const [key, until] of this.retracting) {
      if (until > t) continue;
      this.retracting.delete(key);
      this.set_.remove(key);
    }
  }

  remove(key) {
    this.retracting.delete(key);
    return this.set_.remove(key);
  }

  clear() {
    this.retracting.clear();
    this.set_.clear();
  }

  /** Colors (per class), the highlight color, blending, and the rest alpha. */
  setLook(colors, highlight, blending, alpha, hiAlpha) {
    CLASSES.forEach((c, i) => this.uniforms.uColors.value[i].set(colors[c]));
    this.uniforms.uHiColor.value.set(highlight);
    this.uniforms.uAlpha.value = alpha;
    this.uniforms.uHiAlpha.value = hiAlpha;
    if (this.material.blending !== blending) {
      this.material.blending = blending;
      this.material.needsUpdate = true;
    }
  }

  /** The worker in focus (index, -1 none), whether strong, and the selected and hovered agents' point indices (-10 none). */
  setFocus(worker, strong, sel, hover) {
    this.uniforms.uFocusW.value = worker;
    this.uniforms.uFocusStrong.value = strong ? 1 : 0;
    this.uniforms.uSelA.value = sel;
    this.uniforms.uHoverA.value = hover;
  }

  setFlow(on) {
    this.uniforms.uFlow.value = on ? 1 : 0;
  }

  /** The drawing buffer's size and the beams' width, in device pixels. */
  setViewport(w, h, widthPx) {
    this.uniforms.uViewport.value.set(w, h);
    this.uniforms.uWidth.value = widthPx;
  }

  flush() {
    this.set_.flush();
  }

  dispose() {
    this.parent.remove(this.lines);
    this.lines.geometry.dispose();
    this.material.dispose();
    this.retracting.clear();
  }
}

const ribbonVertex = /* glsl */ `
attribute vec3 aFrom;
attribute vec3 aTo;
attribute vec4 aInfo; // width, strength (0..1), level, seed
uniform float uScale;
uniform float uFarLo;
uniform float uFarHi;
uniform float uFade;
uniform float uMin;
varying float vT;
varying float vSide;
varying float vA;
varying float vHi;
varying float vSeed;
void main() {
  float t = position.x;
  float side = position.y;
  // Leaves the atespace straight down, eases across, lands straight on the
  // pool: x and z follow smoothstep(t), y follows t (tangent in closed form).
  float s = t * t * (3.0 - 2.0 * t);
  float ds = 6.0 * t * (1.0 - t);
  vec3 dv = aTo - aFrom;
  vec3 p = vec3(aFrom.x + dv.x * s, aFrom.y + dv.y * t, aFrom.z + dv.z * s);
  vec3 tangent = vec3(dv.x * ds, dv.y, dv.z * ds);
  vec3 across = cross(tangent, cameraPosition - p);
  float len = length(across);
  across = len > 1e-5 ? across / len : vec3(1.0, 0.0, 0.0);
  // A little narrower in the middle, so bundles read as flowing.
  float w = aInfo.x * (1.0 - 0.3 * sin(t * 3.14159));
  p += across * side * w * 0.5;
  // Ribbons show where the atespace end is far (its agents too small to
  // draw beams for), or always at uMin when beams are trimmed.
  vec4 mvA = viewMatrix * vec4(aFrom, 1.0);
  float px = ${CELL.toFixed(2)} * uScale / max(-mvA.z, 0.01);
  float far = 1.0 - smoothstep(uFarLo, uFarHi * 1.4, px);
  float show = max(far, uMin);
  float lv = aInfo.z;
  float a = aInfo.y * (lv > 1.5 ? 1.6 : lv > 0.5 ? 1.25 : lv < -0.5 ? 0.18 : 1.0);
  if (lv > 1.5) show = max(show, 0.6);
  // Emerges from under the agent deck, settles onto the pool.
  vA = a * show * uFade * smoothstep(0.0, 0.12, t);
  vT = t;
  vSide = side;
  vHi = lv;
  vSeed = aInfo.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  if (vA < 0.004 || aInfo.x <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const ribbonFragment = /* glsl */ `
uniform float uTime;
uniform float uFlow;
uniform float uAlpha;
uniform vec3 uColor;
uniform vec3 uLow;
uniform vec3 uHiColor;
varying float vT;
varying float vSide;
varying float vA;
varying float vHi;
varying float vSeed;
void main() {
  float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
  float flow = uFlow > 0.5 ? pow(0.5 + 0.5 * sin(vT * 18.0 - uTime * 1.8 + vSeed * 6.2831), 6.0) : 0.0;
  vec3 col = mix(uColor, uLow, smoothstep(0.2, 1.0, vT));
  col = mix(col, uHiColor, vHi > 1.5 ? 0.45 : 0.0);
  col *= 0.85 + 0.6 * flow;
  float a = uAlpha * vA * edge * (0.75 + 0.25 * flow);
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, min(a, 1.0));
}`;

/** One instanced quad strip (RIBBON_SEGMENTS segments, two triangles each). */
function ribbonGeometry() {
  const n = RIBBON_SEGMENTS;
  const pos = new Float32Array((n + 1) * 2 * 3);
  for (let i = 0; i <= n; i++) {
    pos.set([i / n, -1, 0, i / n, 1, 0], i * 6);
  }
  const index = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

/** Ribbons keyed by atespace -> pool pair: one instanced draw. */
export class RibbonSet {
  /**
   * @param {THREE.Object3D} parent
   * @param {{value: number}} timeUniform
   * @param {object} look shared level-of-detail uniforms (uScale, uFarLo, uFarHi)
   * @param {{value: number}} fade the deck fade
   */
  constructor(parent, timeUniform, look, fade) {
    this.parent = parent;
    this.uniforms = {
      uTime: timeUniform,
      uFlow: { value: 1 },
      uAlpha: { value: 0.5 },
      uMin: { value: 0 },
      uColor: { value: new THREE.Color(0xffffff) },
      uLow: { value: new THREE.Color(0xffffff) },
      uHiColor: { value: new THREE.Color(0xffffff) },
      uScale: look.uScale || { value: 600 },
      uFarLo: look.uFarLo || { value: 2.5 },
      uFarHi: look.uFarHi || { value: 5 },
      uFade: fade || { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: ribbonVertex,
      fragmentShader: ribbonFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: this.uniforms,
    });
    this.mesh = new THREE.Mesh(ribbonGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    parent.add(this.mesh);
    this.set_ = new Keyed(this.mesh, { aFrom: 3, aTo: 3, aInfo: 4 }, 16);
  }

  get count() {
    return this.set_.count;
  }

  get keys() {
    return this.set_.keys;
  }

  has(key) {
    return this.set_.has(key);
  }

  /** Adds or updates a ribbon (width 0 hides it). */
  set(key, from, to, width, strength, level, seed) {
    const s = this.set_;
    const i = s.slot(key);
    s.write(i, 'aFrom', [from.x, from.y, from.z]);
    s.write(i, 'aTo', [to.x, to.y, to.z]);
    s.write(i, 'aInfo', [width, strength, level, seed]);
  }

  /** The ribbons drawn now (width > 0). */
  get visibleCount() {
    let n = 0;
    const a = this.set_.attrs.aInfo.array;
    for (let i = 0; i < this.set_.count; i++) if (a[i * 4] > 0) n++;
    return n;
  }

  setLevel(key, level) {
    const i = this.set_.slots.get(key);
    if (i === undefined) return;
    this.set_.attrs.aInfo.array[i * 4 + 2] = level;
    this.set_.mark(i);
  }

  remove(key) {
    return this.set_.remove(key);
  }

  clear() {
    this.set_.clear();
  }

  /** Top and bottom colors, the highlight, blending and overall alpha. */
  setLook(top, bottom, highlight, blending, alpha) {
    this.uniforms.uColor.value.set(top);
    this.uniforms.uLow.value.set(bottom);
    this.uniforms.uHiColor.value.set(highlight);
    this.uniforms.uAlpha.value = alpha;
    if (this.material.blending !== blending) {
      this.material.blending = blending;
      this.material.needsUpdate = true;
    }
  }

  /** Minimum visibility (beams trimmed by the budget: ribbons carry the rest). */
  setMin(v) {
    this.uniforms.uMin.value = v;
  }

  setFlow(on) {
    this.uniforms.uFlow.value = on ? 1 : 0;
  }

  flush() {
    this.set_.flush();
  }

  dispose() {
    this.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
