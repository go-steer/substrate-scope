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

// The island's ground for a plan: the slab, its rim, the cluster's name and
// one tile per district (an atespace, or in worker view a worker platform
// and the parked area), with dots for the room left in each. Rebuilt when
// the plan, the theme or the grouping changes; clearGroup disposes the old
// one completely. Labels and text come from factories (CSS2D and canvas in
// the browser), so node tests can build ground without a DOM.

import * as THREE from 'three';
import { slotPosition } from './layout.js';

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export function roundedRect(w, d, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Removes and disposes everything under group (geometries, materials, textures, labels). */
export function clearGroup(group) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse?.((o) => {
      o.geometry?.dispose();
      for (const m of [o.material].flat()) {
        m?.map?.dispose();
        m?.dispose();
      }
      if (o.isCSS2DObject) o.element.remove();
    });
  }
}

/**
 * Room dots: world-sized points that fade out where agent cells get too
 * small on screen (the far tiles take over there), instead of turning
 * into moire. look: the scene's level-of-detail uniforms (uScale, uFarLo,
 * uFarHi); without them the dots always show.
 */
function dotMaterial(color, size, look = {}) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uSize: { value: size },
      uScale: look.uScale || { value: 600 },
      uFarLo: look.uFarLo || { value: 0 },
      uFarHi: look.uFarHi || { value: 0.001 },
    },
    vertexShader: `uniform float uSize; uniform float uScale; uniform float uFarLo; uniform float uFarHi; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = max(-mv.z, 0.01);
        float px = 1.5 * uScale / d;
        vA = smoothstep(uFarLo, uFarHi * 1.6, px) * 0.8;
        // uScale is pixels per unit at depth 1 for the vertical fov; three's
        // PointsMaterial (which these replace) used half the canvas height.
        gl_PointSize = max(uSize * uScale * 0.384 / d, 1.0);
        gl_Position = projectionMatrix * mv;
        if (vA < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: `uniform vec3 uColor; varying float vA;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        if (dot(c, c) > 1.0) discard;
        gl_FragColor = vec4(uColor, vA);
      }`,
  });
}

/** Above this many worker platforms, platforms get labels from the scene's pool instead of one each. */
export const MAX_PLATFORM_LABELS = 64;

/**
 * Builds the ground for a plan into group (cleared first). Every district
 * tile is one instance of a single InstancedMesh, every outline is in one
 * LineSegments and every room dot in one Points (two: worker platforms get
 * bigger dots), so the ground costs a handful of draw calls whether it has
 * 16 districts or 2,000 worker platforms. Pool and node frames (worker
 * view, and the pad area's pools in atespace view) are tiles too.
 * @param {THREE.Group} group
 * @param {{width: number, depth: number, districts: Map, frames?: object[], padFrames?: object[], padDepth?: number}} plan
 * @param {object} theme
 * @param {{cluster: string, blending: number, makeLabel: (cls: string) => THREE.Object3D, makeText: (text: string, opts: object) => THREE.Mesh, look?: object}} opts
 * @returns {{width: number, depth: number, cx: number, cz: number, rowZ: number, outline: THREE.Shape}}
 *   the island (center and size) and the z of the worker pad row (atespace view)
 */
export function buildGround(group, plan, theme, opts) {
  clearGroup(group);
  const { width, depth, districts } = plan;
  // Room at the front for the worker pad area and the cluster's name; in
  // worker view the pads sit on their platforms, so only the name needs it.
  const ds = [...districts.values()];
  const padRow = !ds.some((d) => d.kind === 'worker');
  const padDepth = plan.padDepth ?? 3;
  const extra = padRow ? 8 + padDepth : 6.5;
  const islandW = width + 9;
  const islandD = depth + extra;
  const island = { width: islandW, depth: islandD, cx: -1.2, cz: padRow ? (extra - 5.8) / 2 : 0.35, rowZ: depth / 2 + 3.2 };

  // The slab.
  const shape = roundedRect(islandW, islandD, Math.min(3.5 + Math.max(islandW, islandD) * 0.004, 8));
  island.outline = shape;
  const slabGeo = new THREE.ExtrudeGeometry(shape, { depth: 1.4, bevelEnabled: true, bevelThickness: 0.35, bevelSize: 0.35, bevelSegments: 3, curveSegments: 12 });
  slabGeo.rotateX(Math.PI / 2);
  const light = !theme.glow.additive;
  const blend = opts.blending;
  const slab = new THREE.Mesh(slabGeo, [
    new THREE.MeshStandardMaterial({ color: theme.island.fill, roughness: light ? 0.9 : 0.8, metalness: light ? 0 : 0.2 }),
    new THREE.MeshStandardMaterial({ color: theme.island.side, roughness: light ? 0.9 : 0.8, metalness: light ? 0 : 0.2 }),
  ]);
  slab.position.set(island.cx, -0.4, island.cz);
  slab.receiveShadow = true;
  group.add(slab);

  // Glowing rim around the top edge.
  const rimPts = shape.getPoints(96).map((p) => new THREE.Vector3(p.x + island.cx, 0.0, p.y + island.cz));
  rimPts.push(rimPts[0].clone());
  group.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(rimPts),
      new THREE.LineBasicMaterial({ color: theme.island.edge, transparent: true, opacity: theme.island.edgeAlpha, blending: blend }),
    ),
  );

  // Cluster name along the front edge, larger on big islands.
  const nameSize = Math.min(1.5 * Math.max(1, islandW / 160), 8);
  const name = opts.makeText(opts.cluster || 'cluster', { size: nameSize, color: theme.island.label });
  name.material.opacity = 0.75;
  const nameW = name.geometry.parameters?.width ?? 0;
  name.position.set(island.cx - islandW / 2 + 2.4 + nameW / 2, 0.03, island.cz + islandD / 2 - 1.3 - (nameSize - 1.5) / 2);
  group.add(name);

  // Frames first (under the platforms), then districts.
  const frames = [...(plan.frames || []), ...(plan.padFrames || [])];
  const tiles = [];
  for (const f of frames) {
    const pool = f.kind === 'pool';
    tiles.push({ x: f.x, z: f.z, w: f.w, d: f.d, y: pool ? 0.02 : 0.04, h: pool ? 0.04 : 0.04, color: new THREE.Color(theme.district.fill).offsetHSL(0, 0, pool ? -0.02 : 0.015), edge: theme.district.edge, edgeA: theme.district.edgeAlpha * (pool ? 0.7 : 0.4) });
  }
  for (const d of ds) {
    // A small per-district hue shift so neighbours read apart; the parked
    // area is plainer, a holding yard rather than a place.
    const parked = d.kind === 'parked';
    const jitter = parked ? 0 : (hashString(d.name) - 0.5) * theme.district.fillJitter;
    const color = new THREE.Color(parked ? theme.worker.parked : theme.district.fill).offsetHSL(jitter, 0, 0);
    const edgeColor = new THREE.Color(d.kind === 'worker' ? theme.worker.padEdge : theme.district.edge).offsetHSL(jitter, 0, 0);
    tiles.push({ x: d.x, z: d.z, w: d.w, d: d.d, y: 0.06, h: 0.12, color, edge: edgeColor, edgeA: theme.district.edgeAlpha * (parked ? 0.5 : 1) });
  }
  const tileMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ roughness: light ? 0.9 : 0.7, metalness: light ? 0 : 0.2 }),
    Math.max(1, tiles.length),
  );
  tileMesh.count = tiles.length;
  tileMesh.receiveShadow = true;
  tileMesh.frustumCulled = false;
  const m4 = new THREE.Matrix4();
  // Outlines: the top rectangle of every tile, one vertex color (with alpha) each.
  const lp = new Float32Array(tiles.length * 8 * 3);
  const lc = new Float32Array(tiles.length * 8 * 4);
  const ec = new THREE.Color();
  tiles.forEach((t, i) => {
    m4.makeScale(t.w, t.h, t.d).setPosition(t.x + t.w / 2, t.y, t.z + t.d / 2);
    tileMesh.setMatrixAt(i, m4);
    tileMesh.setColorAt(i, t.color);
    const y = t.y + t.h / 2 + 0.01;
    const x0 = t.x - 0.02;
    const x1 = t.x + t.w + 0.02;
    const z0 = t.z - 0.02;
    const z1 = t.z + t.d + 0.02;
    const segs = [x0, z0, x1, z0, x1, z0, x1, z1, x1, z1, x0, z1, x0, z1, x0, z0];
    ec.set(t.edge);
    for (let k = 0; k < 8; k++) {
      lp.set([segs[k * 2], y, segs[k * 2 + 1]], (i * 8 + k) * 3);
      lc.set([ec.r, ec.g, ec.b, t.edgeA], (i * 8 + k) * 4);
    }
  });
  group.add(tileMesh);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(lp, 3));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(lc, 4));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: blend }));
  lines.frustumCulled = false;
  group.add(lines);

  // Cell dots so empty capacity reads as "room" (on a worker platform:
  // its slots). One Points for districts, one for worker platforms.
  for (const workerDots of [false, true]) {
    const set = ds.filter((d) => (d.kind === 'worker') === workerDots);
    const n = set.reduce((a, d) => a + (d.shown ?? d.capacity), 0);
    if (!n) continue;
    const dots = new Float32Array(n * 3);
    let o = 0;
    for (const d of set) {
      const k = d.shown ?? d.capacity;
      for (let s = 0; s < k; s++) {
        const p = slotPosition(d, s);
        dots[o++] = p.x;
        dots[o++] = 0.125;
        dots[o++] = p.z;
      }
    }
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute('position', new THREE.BufferAttribute(dots, 3));
    const pts = new THREE.Points(dotGeo, dotMaterial(theme.district.dots, workerDots ? 0.16 : 0.12, opts.look));
    pts.frustumCulled = false;
    group.add(pts);
  }

  // Labels: one per atespace district and the parked area; one per worker
  // platform while there are few (the scene lends pooled labels to the
  // platforms in view beyond that); one per pool frame.
  const platforms = ds.filter((d) => d.kind === 'worker').length;
  for (const d of ds) {
    d.label = null;
    if (d.kind === 'worker' && platforms > MAX_PLATFORM_LABELS) continue;
    const label = opts.makeLabel('district-label');
    label.element.classList?.add(d.kind);
    label.position.set(d.x + 0.4, 0.2, d.z + (d.strip ?? 2) / 2);
    label.center?.set(0, 0.5);
    group.add(label);
    d.label = label.element;
  }
  for (const f of frames) {
    f.label = null;
    if (f.kind !== 'pool') continue;
    const label = opts.makeLabel('district-label');
    label.element.classList?.add('pool');
    label.position.set(f.x + 0.5, 0.2, f.z + (f.strip ?? 2) / 2);
    label.center?.set(0, 0.5);
    group.add(label);
    f.label = label.element;
  }
  return island;
}
