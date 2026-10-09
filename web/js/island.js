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
 * Builds the ground for a plan into group (cleared first).
 * @param {THREE.Group} group
 * @param {{width: number, depth: number, districts: Map}} plan
 * @param {object} theme
 * @param {{cluster: string, blending: number, makeLabel: (cls: string) => THREE.Object3D, makeText: (text: string, opts: object) => THREE.Mesh}} opts
 * @returns {{width: number, depth: number, cx: number, cz: number, rowZ: number, outline: THREE.Shape}}
 *   the island (center and size) and the z of the worker pad row (atespace view)
 */
export function buildGround(group, plan, theme, opts) {
  clearGroup(group);
  const { width, depth, districts } = plan;
  // Room at the front for the worker pad row and the cluster's name; in
  // worker view the pads sit on their platforms, so only the name needs it.
  const padRow = ![...districts.values()].some((d) => d.kind === 'worker');
  const islandW = width + 9;
  const islandD = depth + (padRow ? 11 : 6.5);
  const island = { width: islandW, depth: islandD, cx: -1.2, cz: padRow ? 2.6 : 0.35, rowZ: depth / 2 + 3.2 };

  // The slab.
  const shape = roundedRect(islandW, islandD, 3.5);
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

  // Cluster name along the front edge.
  const name = opts.makeText(opts.cluster || 'cluster', { size: 1.5, color: theme.island.label });
  name.material.opacity = 0.75;
  const nameW = name.geometry.parameters?.width ?? 0;
  name.position.set(island.cx - islandW / 2 + 2.4 + nameW / 2, 0.03, island.cz + islandD / 2 - 1.3);
  group.add(name);

  for (const d of districts.values()) {
    // A small per-district hue shift so neighbours read apart; the parked
    // area is plainer, a holding yard rather than a place.
    const parked = d.kind === 'parked';
    const jitter = parked ? 0 : (hashString(d.name) - 0.5) * theme.district.fillJitter;
    const tileColor = new THREE.Color(parked ? theme.worker.parked : theme.district.fill).offsetHSL(jitter, 0, 0);
    const tile = new THREE.Mesh(
      new THREE.BoxGeometry(d.w, 0.12, d.d),
      new THREE.MeshStandardMaterial({ color: tileColor, roughness: light ? 0.9 : 0.7, metalness: light ? 0 : 0.2 }),
    );
    tile.position.set(d.x + d.w / 2, 0.06, d.z + d.d / 2);
    tile.receiveShadow = true;
    group.add(tile);
    const edgeColor = d.kind === 'worker' ? theme.worker.padEdge : theme.district.edge;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(d.w + 0.04, 0.16, d.d + 0.04)),
      new THREE.LineBasicMaterial({
        color: new THREE.Color(edgeColor).offsetHSL(jitter, 0, 0),
        transparent: true,
        opacity: theme.district.edgeAlpha * (parked ? 0.5 : 1),
        blending: blend,
      }),
    );
    edges.position.copy(tile.position);
    group.add(edges);
    // Cell dots so empty capacity reads as "room" (on a worker platform:
    // its actor slots).
    const n = d.shown ?? d.capacity;
    const dots = new Float32Array(n * 3);
    for (let s = 0; s < n; s++) {
      const p = slotPosition(d, s);
      dots[s * 3] = p.x;
      dots[s * 3 + 1] = 0.125;
      dots[s * 3 + 2] = p.z;
    }
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute('position', new THREE.BufferAttribute(dots, 3));
    group.add(new THREE.Points(dotGeo, new THREE.PointsMaterial({ color: theme.district.dots, size: d.kind === 'worker' ? 0.16 : 0.12, transparent: true, opacity: 0.8 })));

    const label = opts.makeLabel('district-label');
    label.element.classList?.add(d.kind);
    label.position.set(d.x + 0.4, 0.2, d.z + (d.strip ?? 2) / 2);
    label.center?.set(0, 0.5);
    group.add(label);
    d.label = label.element;
  }
  return island;
}
