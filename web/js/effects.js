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

// Short-lived event animations: the wake arc from the router tower, the
// suspend ripple, the crash shockwave and the new-task beam. Each is a small
// additive mesh that removes itself when done.

import * as THREE from 'three';

const ringGeo = new THREE.RingGeometry(0.62, 0.72, 64);
ringGeo.rotateX(-Math.PI / 2);
const beamGeo = new THREE.CylinderGeometry(0.3, 0.3, 1, 24, 1, true);
beamGeo.translate(0, 0.5, 0);

const arcVertex = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const arcFragment = `
uniform float uProg; uniform vec3 uColor; uniform float uFade;
varying vec2 vUv;
void main(){
  float u = vUv.x;
  float head = smoothstep(uProg - 0.22, uProg, u) * (1.0 - smoothstep(uProg, uProg + 0.015, u));
  float trail = step(u, uProg) * 0.18;
  float a = (head * 1.0 + trail) * uFade;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * (0.5 + 1.6 * head), a);
}`;

const beamFragment = `
uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv;
void main(){
  float a = uAlpha * pow(1.0 - vUv.y, 1.6);
  gl_FragColor = vec4(uColor * 1.1, a);
}`;

export class Effects {
  constructor(parent, timeUniform) {
    this.parent = parent;
    this.time = timeUniform;
    this.items = [];
  }

  add(obj, update) {
    this.parent.add(obj);
    this.items.push({ obj, update, t0: this.time.value });
  }

  /** Expanding ring on the ground at (x, z). */
  ripple(x, z, color, scale = 1, delay = 0) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const m = new THREE.Mesh(ringGeo, mat);
    m.position.set(x, 0.2, z);
    const dur = 1.6 * scale;
    this.add(m, (age) => {
      const k = (age - delay) / dur;
      if (k < 0) return true;
      if (k >= 1) return false;
      const s = 1 + k * 3.2 * scale;
      m.scale.set(s, 1, s);
      mat.opacity = (1 - k) * (1 - k) * 0.9;
      return true;
    });
  }

  /** Crash: three fast red rings and a short flash column. */
  shock(x, z, color) {
    for (let i = 0; i < 3; i++) this.ripple(x, z, color, 1.1, i * 0.28);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(color) }, uAlpha: { value: 0 } },
      vertexShader: arcVertex,
      fragmentShader: beamFragment,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(beamGeo, mat);
    m.position.set(x, 0.1, z);
    m.scale.set(0.9, 7, 0.9);
    this.add(m, (age) => {
      const k = age / 1.2;
      if (k >= 1) return false;
      mat.uniforms.uAlpha.value = Math.sin(Math.PI * Math.min(k * 2, 1)) * (1 - k);
      return true;
    });
  }

  /** New task: a beam of light coming down onto the agent. */
  beam(x, z, color) {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(color) }, uAlpha: { value: 0 } },
      vertexShader: arcVertex,
      fragmentShader: beamFragment,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(beamGeo, mat);
    m.position.set(x, 0.1, z);
    this.add(m, (age) => {
      const k = age / 2.4;
      if (k >= 1) return false;
      const drop = Math.min(k * 3, 1);
      m.scale.set(0.8, 30 * drop, 0.8);
      m.position.y = 0.1 + 30 * (1 - drop);
      mat.uniforms.uAlpha.value = (k < 0.3 ? k / 0.3 : 1 - (k - 0.3) / 0.7) * 0.45;
      return true;
    });
    this.ripple(x, z, color, 1.2, 0.6);
  }

  /** Wake: a comet along an arc from the router tower to the agent. */
  arc(from, to, color, onArrive) {
    const mid = from.clone().lerp(to, 0.5);
    mid.y += 4 + from.distanceTo(to) * 0.35;
    const curve = new THREE.QuadraticBezierCurve3(from.clone(), mid, to.clone());
    const geo = new THREE.TubeGeometry(curve, 96, 0.09, 8, false);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uProg: { value: 0 }, uColor: { value: new THREE.Color(color) }, uFade: { value: 1 } },
      vertexShader: arcVertex,
      fragmentShader: arcFragment,
    });
    const m = new THREE.Mesh(geo, mat);
    let arrived = false;
    const travel = 1.3;
    this.add(m, (age) => {
      const k = age / travel;
      mat.uniforms.uProg.value = Math.min(k, 1.0) * 1.02;
      if (k >= 1 && !arrived) {
        arrived = true;
        onArrive?.();
      }
      if (k > 1) mat.uniforms.uFade.value = Math.max(0, 1 - (k - 1) * 1.5);
      if (k > 1.7) {
        geo.dispose();
        return false;
      }
      return true;
    });
  }

  update(t) {
    this.items = this.items.filter((it) => {
      if (it.update(t - it.t0)) return true;
      this.parent.remove(it.obj);
      it.obj.material?.dispose();
      return false;
    });
  }
}
