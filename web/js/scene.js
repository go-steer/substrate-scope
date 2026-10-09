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

// The 3D scene: the cluster island, atespace districts, agents (one
// InstancedMesh per visual class, in a switchable shape), worker pads, the
// router (in a switchable look), and the short animations that show events.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

import { CLASSES, stateClass } from './model.js';
import { AgentLayers } from './agents.js';
import { shapeById } from './shapes.js';
import { buildRouter, routerId } from './routers.js';
import { planIsland, slotPosition, SlotTable } from './layout.js';
import { esc, duration, since, workerLabel } from './format.js';
import { Effects } from './effects.js';
import { themeById, classColor, hex } from './themes.js';

// The active theme (see themes.js). Every state shares its class color: the
// five class colors of a theme are validated as a set.
let theme = themeById();
export function stateColor(state) {
  return hex(cssColor(state));
}
export function cssColor(state) {
  return classColor(theme, stateClass(state));
}

const TONE_MAPPING = { none: THREE.NoToneMapping, neutral: THREE.NeutralToneMapping, aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping };

/** A vertical gradient for the scene background. */
function gradientTexture(top, bottom) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(0.65, bottom);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function roundedRect(w, d, r) {
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

/** A flat text plane drawn with a canvas texture (for the island's name). */
function textPlane(text, { size = 3, color = '#7f93bd', weight = 700, letterSpacing = 0.18 } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const px = 128;
  ctx.font = `${weight} ${px}px Inter, "Segoe UI", system-ui, sans-serif`;
  const spaced = text.toUpperCase().split('').join(String.fromCharCode(8202));
  const w = Math.ceil(ctx.measureText(spaced).width + px * letterSpacing * text.length) + 40;
  canvas.width = w;
  canvas.height = px * 1.4;
  ctx.font = `${weight} ${px}px Inter, "Segoe UI", system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  let x = 20;
  for (const ch of text.toUpperCase()) {
    ctx.fillText(ch, x, canvas.height / 2);
    x += ctx.measureText(ch).width + px * letterSpacing;
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const aspect = canvas.width / canvas.height;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.9 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size * aspect, size), mat);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

// Seconds a label stays up after its agent changes state (crashes: twice).
const CHANGE_LABEL_SECONDS = 6;
// Camera-to-target distance under which 'auto' labels every nearby agent.
const CLOSE_UP_DISTANCE = 20;
// Camera-to-pad distance under which worker pads show their labels.
const WORKER_LABEL_DISTANCE = 34;

export class Scene {
  /**
   * @param {HTMLElement} container
   * @param {{onPick?: Function, onHover?: Function}} handlers
   * @param {{shape?: string, router?: string, extras?: boolean}} opts initial agent shape, router look, extras
   */
  constructor(container, handlers = {}, opts = {}) {
    this.container = container;
    this.handlers = handlers;
    this.time = { value: 0 };
    this.timer = new THREE.Timer();
    this.recs = new Map();
    this.filter = () => true;
    this.selected = null;
    this.anims = new Map();
    this.labelPinned = new Map(); // key -> until (seconds)
    // Agent labels: 'auto' (selected, recent changes, close-ups), 'all', 'off'.
    this.labelMode = 'auto';
    this.plan = null;
    this.workers = new Map();
    this.model = null;
    // ?slowmo=N plays animations N times slower (for recording demos and
    // for screenshots with a software renderer).
    const params = new URLSearchParams(window.location.search);
    this.slowmo = Math.max(1, Number(params.get('slowmo')) || 1);
    // The agents' shape and the router's look (see shapes.js, routers.js);
    // main.js sets the remembered choice before the first snapshot.
    this.shape = shapeById(opts.shape);
    this.routerKind = routerId(opts.router);
    this.router = null;
    this.extras = opts.extras !== false;
    // 1 in synthetic mode: idle rings run on fake timers and a random
    // subset of running agents "serves requests".
    this.fake = { value: 0 };

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const labels = new CSS2DRenderer();
    labels.domElement.className = 'label-layer';
    container.appendChild(labels.domElement);
    this.labelRenderer = labels;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x000000, 0.006);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000);
    camera.position.set(0, 40, 55);
    this.camera = camera;

    const controls = new OrbitControls(camera, labels.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.minDistance = 6;
    controls.maxDistance = 600;
    controls.screenSpacePanning = false;
    this.controls = controls;

    this.ambient = new THREE.AmbientLight(0xffffff, 0);
    scene.add(this.ambient);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1);
    sun.position.set(30, 60, 25);
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.radius = 6;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    // Shared agent-shader uniforms the theme sets.
    this.look = {
      uGlow: { value: 1 },
      uAmb: { value: 0.1 },
      uDiff: { value: 0.45 },
      uHemi: { value: 0.22 },
      uGloss: { value: 0 },
      uInk: { value: 0 },
      uOcc: { value: 0 },
      uAdditive: { value: 1 },
      uDimColor: { value: new THREE.Color() },
    };

    this.world = new THREE.Group();
    scene.add(this.world);
    this.islandGroup = new THREE.Group();
    this.world.add(this.islandGroup);
    this.agentGroup = new THREE.Group();
    this.world.add(this.agentGroup);

    this.buildAgents();

    this.effects = new Effects(this.world, this.time);
    this.addBackdrop();
    this.addSelectionMarker();

    // Worker lines: one LineSegments rebuilt when assignments change.
    this.workerLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    this.workerLines.frustumCulled = false;
    this.world.add(this.workerLines);

    // Post-processing: bloom on the emissive parts.
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.45, 0.8);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    this.composer = composer;
    this.setTheme(theme);

    // Agent label pool.
    this.agentLabels = [];
    for (let i = 0; i < 48; i++) {
      const div = document.createElement('div');
      div.className = 'agent-label';
      const obj = new CSS2DObject(div);
      obj.center.set(0.1, 1);
      obj.visible = false;
      this.world.add(obj);
      this.agentLabels.push(obj);
    }
    this.lastLabelUpdate = 0;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.bindPointer(labels.domElement);

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
    this.flyAnim = null;
    renderer.setAnimationLoop(() => this.frame());
  }

  addBackdrop() {
    // A faint grid "sea" that fades out with distance.
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(1600, 1600),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uGrid: { value: new THREE.Color() },
          uGridA: { value: 0.2 },
          uSea: { value: new THREE.Color() },
          uSeaA: { value: 0.9 },
        },
        vertexShader: `varying vec3 vP; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vP = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
        fragmentShader: `varying vec3 vP; uniform vec3 uGrid; uniform float uGridA; uniform vec3 uSea; uniform float uSeaA;
          void main(){
            vec2 g = abs(fract(vP.xz / 4.0 - 0.5) - 0.5) / fwidth(vP.xz / 4.0);
            float line = 1.0 - min(min(g.x, g.y), 1.0);
            float d = length(vP.xz);
            float fade = exp(-d * 0.018);
            vec3 c = mix(uSea, uGrid, line * uGridA);
            gl_FragColor = vec4(c, fade * uSeaA);
          }`,
      }),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -1.6;
    this.scene.add(sea);
    this.sea = sea;

    // Stars.
    const n = 1400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const r = 700 + Math.random() * 300;
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = r * s * Math.cos(t);
      pos[i * 3 + 1] = Math.abs(r * u) * 0.8 + 40;
      pos[i * 3 + 2] = r * s * Math.sin(t);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.55, fog: false }));
    this.scene.add(stars);
    this.stars = stars;
  }

  addSelectionMarker() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.0, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 1, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    const marker = new THREE.Group();
    marker.add(ring);
    marker.add(beam);
    marker.visible = false;
    this.world.add(marker);
    this.marker = { group: marker, ring, beam };

    const hover = new THREE.Mesh(
      new THREE.RingGeometry(0.75, 0.85, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }),
    );
    hover.rotation.x = -Math.PI / 2;
    hover.visible = false;
    this.world.add(hover);
    this.hoverRing = hover;
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- theme

  /** The blending for glowing lines and effects: additive only on dark themes. */
  get blending() {
    return theme.glow.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  }

  /** Applies a theme (see themes.js) without rebuilding the page. */
  setTheme(t) {
    theme = t;
    const sc = t.scene;
    this.scene.background?.dispose?.();
    this.scene.background = gradientTexture(sc.backgroundTop, sc.background);
    this.scene.fog.color.set(sc.fog);
    this.scene.fog.density = sc.fogDensity;
    const su = this.sea.material.uniforms;
    su.uGrid.value.set(sc.grid);
    su.uGridA.value = sc.gridAlpha;
    su.uSea.value.set(sc.sea);
    su.uSeaA.value = sc.seaAlpha;
    this.stars.visible = !!sc.stars;
    if (sc.stars) {
      this.stars.material.color.set(sc.stars);
      this.stars.material.opacity = sc.starAlpha;
    }

    const L = t.light;
    this.renderer.toneMapping = TONE_MAPPING[L.toneMapping] ?? THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = L.exposure;
    this.ambient.color.set(L.ambient);
    this.ambient.intensity = L.ambientIntensity;
    this.hemi.color.set(L.hemiSky);
    this.hemi.groundColor.set(L.hemiGround);
    this.hemi.intensity = L.hemiIntensity;
    this.sun.color.set(L.sun);
    this.sun.intensity = L.sunIntensity;
    this.sun.castShadow = L.shadow;
    this.sun.shadow.intensity = L.shadowAlpha;
    this.renderer.shadowMap.enabled = L.shadow;

    const g = t.glow;
    this.look.uGlow.value = g.emissive;
    this.look.uAmb.value = g.ambient;
    this.look.uDiff.value = g.diffuse;
    this.look.uHemi.value = g.hemi;
    this.look.uGloss.value = g.gloss;
    this.look.uInk.value = g.ink;
    this.look.uOcc.value = g.occlusion;
    this.look.uAdditive.value = g.additive ? 1 : 0;
    this.look.uDimColor.value.set(sc.background);
    // Light themes draw every class at full strength (their suspended color
    // is already pale) and blend the extras normally.
    this.agents.setTheme(t);

    this.bloom.enabled = t.bloom.strength > 0;
    this.bloom.strength = t.bloom.strength;
    this.bloom.radius = t.bloom.radius;
    this.bloom.threshold = t.bloom.threshold;

    const blend = this.blending;
    this.workerLines.material.color.set(t.links.color);
    this.workerLines.material.blending = blend;
    this.marker.ring.material.color.set(t.marker.select);
    this.marker.beam.material.color.set(t.marker.select);
    this.hoverRing.material.color.set(t.marker.hover);
    for (const m of [this.marker.ring.material, this.marker.beam.material, this.hoverRing.material]) m.blending = blend;
    this.effects.blending = blend;

    // Shadows and blending changes need recompiled materials.
    this.scene.traverse((o) => {
      for (const m of [o.material].flat()) if (m) m.needsUpdate = true;
    });
    // Rebuild the island and recolor every agent.
    if (this.model) this.replan(false);
  }

  // --------------------------------------------------------------- shapes

  /** Builds the agent layers for the current shape. */
  buildAgents() {
    this.agents = new AgentLayers(this.agentGroup, this.shape, this.time, this.look, { fake: this.fake });
    this.layers = this.agents.layers;
    this.agents.setExtras(this.extras);
  }

  /** Switches the agents' shape live: the old layers are disposed. */
  setAgentShape(id) {
    const shape = shapeById(id);
    if (shape === this.shape) return;
    this.shape = shape;
    this.agents.dispose();
    this.buildAgents();
    this.agents.setTheme(theme);
    this.anims.clear();
    for (const rec of this.recs.values()) {
      const pose = shape.pose[rec.cls];
      rec.h = pose.h;
      rec.tip = pose.tip;
      this.attach(rec);
    }
    this.rebuildWorkerLines();
    this.updateMarker();
  }

  /** Switches the router's look live. */
  setRouter(id) {
    const kind = routerId(id);
    if (kind === this.routerKind && this.router) return;
    this.routerKind = kind;
    if (this.island) this.buildRouter();
  }

  /** Turns the agents' extras (idle rings, light pools, particles) on or off. */
  setExtras(on) {
    this.extras = on;
    this.agents.setExtras(on);
  }

  /** Synthetic mode: fake idle timers and request serving. */
  setFakeActivity(on) {
    this.fake.value = on ? 1 : 0;
  }

  buildRouter() {
    this.router?.dispose();
    this.router = buildRouter(this.routerKind, {
      theme,
      blending: this.blending,
      island: this.island,
      time: this.time,
      makeLabel: (text) => {
        const div = document.createElement('div');
        div.className = 'tower-label';
        div.textContent = text;
        return new CSS2DObject(div);
      },
    });
    this.islandGroup.add(this.router.group);
  }

  /** World height of an agent's top (labels, arcs, the marker). */
  topOf(rec) {
    return this.shape.top(rec.h, rec.tip);
  }

  // ---------------------------------------------------------------- data

  /** Rebuilds everything from the model (after a snapshot or a re-plan). */
  setModel(model) {
    this.model = model;
    for (const cls of CLASSES) this.layers[cls].clear();
    this.recs.clear();
    this.anims.clear();
    this.replan(true);
  }

  /** Lays out the island again and places every agent. */
  replan(fit = false) {
    const model = this.model;
    const counts = model.atespaceCounts();
    const atespaces = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => (a.name < b.name ? -1 : 1));
    const firstPlan = !this.plan;
    this.plan = planIsland(atespaces.length ? atespaces : [{ name: '(none)', count: 0 }]);
    this.slots = new Map();
    for (const d of this.plan.districts.values()) this.slots.set(d.name, new SlotTable(d.capacity));
    this.buildIsland(model.cluster);

    const keys = [...model.agents.keys()].sort();
    const existing = new Map(this.recs);
    for (const cls of CLASSES) this.layers[cls].clear();
    this.recs.clear();
    for (const key of keys) {
      const a = model.agents.get(key);
      const old = existing.get(key);
      this.place(key, a, old);
    }
    this.applyFilter();
    this.rebuildWorkers();
    this.updateDistrictLabels();
    if (fit || firstPlan) this.fitCamera();
  }

  /** Places an agent; from: an earlier pose to keep (else its class's pose). */
  place(key, a, from) {
    const table = this.slots.get(a.atespace);
    if (!table) return false;
    const slot = table.assign(key);
    if (slot < 0) return false;
    const district = this.plan.districts.get(a.atespace);
    const p = slotPosition(district, slot);
    const cls = stateClass(a.state);
    const pose = this.shape.pose[cls];
    const rec = { key, agent: a, cls, slot: -1, x: p.x, z: p.z, h: from?.h ?? pose.h, tip: from?.tip ?? pose.tip, seed: hashString(key) };
    this.recs.set(key, rec);
    this.attach(rec);
    return true;
  }

  attach(rec) {
    const layer = this.layers[rec.cls];
    rec.slot = layer.add(rec.key);
    layer.seed.array[rec.slot] = rec.seed;
    layer.dim.array[rec.slot] = this.filter(rec.agent) ? 0 : 1;
    layer.flash.array[rec.slot] = 0;
    this.writeActivity(rec);
    const c = new THREE.Color(stateColor(rec.agent.state));
    layer.mesh.instanceColor.setXYZ(rec.slot, c.r, c.g, c.b);
    this.writeMatrix(rec);
  }

  detach(rec) {
    const layer = this.layers[rec.cls];
    const moved = layer.remove(rec.slot);
    if (moved) this.recs.get(moved).slot = rec.slot;
    rec.slot = -1;
  }

  writeMatrix(rec) {
    const layer = this.layers[rec.cls];
    this.shape.matrix(layer.mesh.instanceMatrix.array, rec.slot * 16, rec.x, rec.z, rec.h, rec.tip);
    layer.markDirty();
  }

  /**
   * Idle progress (1 = just served, 0 = about to suspend; -1 = unknown) and
   * whether the agent is serving a request. The collector doesn't stream
   * either yet, so real agents show neither; synthetic mode fakes both (the
   * shader runs the fake idle timer from aIdle as a phase).
   */
  writeActivity(rec) {
    const layer = this.layers[rec.cls];
    const fake = this.fake.value > 0;
    const a = rec.agent;
    let idle = -1;
    if (fake) idle = (rec.seed * 7.31) % 1;
    else if (typeof a.idleProgress === 'number') idle = a.idleProgress;
    layer.attrs.aIdle.array[rec.slot] = idle;
    const serving = fake ? (rec.seed * 13.7) % 1 < 0.22 : (a.inFlight || 0) > 0;
    layer.attrs.aServe.array[rec.slot] = serving ? 1 : 0;
  }

  /** Applies a batch of events that the model has already absorbed. */
  applyEvents(events) {
    let replan = false;
    let workersChanged = false;
    const now = this.time.value;
    for (const ev of events) {
      switch (ev.type) {
        case 'atespace_added':
        case 'atespace_removed':
          replan = true;
          break;
        case 'worker_added':
        case 'worker_updated':
        case 'worker_removed':
        case 'worker_assignment':
          workersChanged = true;
          break;
        default:
          break;
      }
      if (!ev.type.startsWith('agent_') && ev.type !== 'task_updated' && ev.type !== 'worker_assignment') continue;
      const key = ev.key;
      if (ev.type === 'agent_removed') {
        const rec = this.recs.get(key);
        if (rec) {
          this.effects.ripple(rec.x, rec.z, theme.effects.removed, 1.2);
          this.detach(rec);
          this.recs.delete(key);
          this.slots.get(rec.agent.atespace)?.release(key);
        }
        workersChanged = true;
        continue;
      }
      let rec = this.recs.get(key);
      if (!rec) {
        if (!this.slots.has(ev.agent.atespace) || !this.place(key, ev.agent)) {
          replan = true;
          continue;
        }
        rec = this.recs.get(key);
        rec.h = 0;
        rec.tip = 0;
        this.writeMatrix(rec);
        this.animatePose(rec, 1.2);
        if (ev.agent.task) this.effects.beam(rec.x, rec.z, theme.effects.beam);
        this.pinLabel(key, CHANGE_LABEL_SECONDS);
        workersChanged = true;
        continue;
      }
      const prevState = rec.agent.state;
      rec.agent = ev.agent;
      if (prevState !== ev.agent.state) this.restyle(rec);
      switch (ev.type) {
        case 'agent_woke': {
          // Aim at the agent's running pose: it lifts while the arc flies.
          const pose = this.shape.pose.running;
          const top = new THREE.Vector3(rec.x, this.shape.top(pose.h, pose.tip) + 0.2, rec.z);
          const from = this.router.wake(top, now);
          const arrive = () => {
            this.flash(rec.key);
            this.effects.ripple(rec.x, rec.z, theme.states.running, 1.4);
          };
          if (this.router.arcStyle === 'comet') this.effects.comet(from, top, theme.effects.wake, arrive);
          else this.effects.arc(from, top, theme.effects.wake, arrive);
          this.pinLabel(key, CHANGE_LABEL_SECONDS);
          break;
        }
        case 'agent_suspended':
          this.effects.ripple(rec.x, rec.z, theme.effects.suspend, 1.6);
          this.effects.ripple(rec.x, rec.z, theme.effects.suspend, 1.6, 0.35);
          this.pinLabel(key, CHANGE_LABEL_SECONDS);
          break;
        case 'agent_crashed':
          this.effects.shock(rec.x, rec.z, theme.effects.crash);
          this.pinLabel(key, CHANGE_LABEL_SECONDS * 2);
          break;
        case 'task_updated':
          if (ev.new) this.effects.beam(rec.x, rec.z, theme.effects.beam);
          break;
        case 'worker_assignment':
          workersChanged = true;
          break;
        default:
          break;
      }
      if (ev.type === 'agent_state') this.flash(key);
    }
    for (const l of Object.values(this.layers)) l.markDirty();
    if (replan) {
      this.replan(false);
      return;
    }
    if (workersChanged) this.rebuildWorkers();
    this.updateDistrictLabels();
    this.updateMarker();
  }

  /** Moves an agent to its new class and animates its height. */
  restyle(rec) {
    const cls = stateClass(rec.agent.state);
    if (cls !== rec.cls) {
      this.detach(rec);
      rec.cls = cls;
      this.attach(rec);
    } else {
      const c = new THREE.Color(stateColor(rec.agent.state));
      this.layers[cls].mesh.instanceColor.setXYZ(rec.slot, c.r, c.g, c.b);
      this.layers[cls].markDirty();
    }
    this.animatePose(rec, cls === 'suspended' ? 1.6 : 1.0);
  }

  /** Animates an agent from its current pose to its class's pose. */
  animatePose(rec, dur) {
    const to = this.shape.pose[rec.cls];
    this.anims.set(rec.key, { fromH: rec.h, fromTip: rec.tip, toH: to.h, toTip: to.tip, t0: this.time.value, dur });
  }

  flash(key) {
    const rec = this.recs.get(key);
    if (!rec || rec.slot < 0) return;
    const layer = this.layers[rec.cls];
    layer.flash.array[rec.slot] = this.time.value;
    layer.markDirty();
  }

  /** Shows an agent's label for a while (it just changed state). */
  pinLabel(key, seconds) {
    this.labelPinned.set(key, this.time.value + seconds);
  }

  /** 'auto', 'all' or 'off'. */
  setLabelMode(mode) {
    this.labelMode = mode;
    this.lastLabelUpdate = -1;
  }

  /** Sets the filter predicate and dims everything that doesn't match. */
  setFilter(fn) {
    this.filter = fn;
    this.applyFilter();
    this.updateDistrictLabels();
  }

  applyFilter() {
    for (const rec of this.recs.values()) {
      const layer = this.layers[rec.cls];
      layer.dim.array[rec.slot] = this.filter(rec.agent) ? 0 : 1;
      layer.markDirty();
    }
  }

  // --------------------------------------------------------------- island

  buildIsland(clusterName) {
    const g = this.islandGroup;
    for (const child of [...g.children]) {
      g.remove(child);
      child.traverse?.((o) => {
        o.geometry?.dispose();
        for (const m of [o.material].flat()) {
          m?.map?.dispose();
          m?.dispose();
        }
        if (o.isCSS2DObject) o.element.remove();
      });
    }
    const { width, depth, districts } = this.plan;
    this.workerRowZ = depth / 2 + 3.2;
    const islandW = width + 9;
    const islandD = depth + 11;
    this.island = { width: islandW, depth: islandD, cx: -1.2, cz: 2.6 };

    // The slab.
    const shape = roundedRect(islandW, islandD, 3.5);
    const slabGeo = new THREE.ExtrudeGeometry(shape, { depth: 1.4, bevelEnabled: true, bevelThickness: 0.35, bevelSize: 0.35, bevelSegments: 3, curveSegments: 12 });
    slabGeo.rotateX(Math.PI / 2);
    const light = !theme.glow.additive;
    const blend = this.blending;
    const slab = new THREE.Mesh(slabGeo, [
      new THREE.MeshStandardMaterial({ color: theme.island.fill, roughness: light ? 0.9 : 0.8, metalness: light ? 0 : 0.2 }),
      new THREE.MeshStandardMaterial({ color: theme.island.side, roughness: light ? 0.9 : 0.8, metalness: light ? 0 : 0.2 }),
    ]);
    slab.position.set(this.island.cx, -0.4, this.island.cz);
    slab.receiveShadow = true;
    g.add(slab);

    // Shadows cover the island.
    const span = Math.max(islandW, islandD) * 0.75 + 6;
    const cam = this.sun.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.near = 1;
    cam.far = 400;
    cam.updateProjectionMatrix();
    this.sun.target.position.set(this.island.cx, 0, this.island.cz);
    // From the front left, so shadows fall to the right where the camera sees them.
    this.sun.position.set(this.island.cx - 70, 80, this.island.cz + 35);

    // Glowing rim around the top edge.
    const rimPts = shape.getPoints(96).map((p) => new THREE.Vector3(p.x + this.island.cx, 0.0, p.y + this.island.cz));
    rimPts.push(rimPts[0].clone());
    const rim = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(rimPts),
      new THREE.LineBasicMaterial({ color: theme.island.edge, transparent: true, opacity: theme.island.edgeAlpha, blending: blend }),
    );
    g.add(rim);

    // Cluster name along the front edge.
    const name = textPlane(clusterName || 'cluster', { size: 1.5, color: theme.island.label });
    name.material.opacity = 0.75;
    name.position.set(this.island.cx - islandW / 2 + 2.4 + name.geometry.parameters.width / 2, 0.03, this.island.cz + islandD / 2 - 1.3);
    g.add(name);

    // Districts.
    for (const d of districts.values()) {
      // A small per-district hue shift so neighbours read apart.
      const jitter = (hashString(d.name) - 0.5) * theme.district.fillJitter;
      const tileColor = new THREE.Color(theme.district.fill).offsetHSL(jitter, 0, 0);
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(d.w, 0.12, d.d),
        new THREE.MeshStandardMaterial({ color: tileColor, roughness: light ? 0.9 : 0.7, metalness: light ? 0 : 0.2 }),
      );
      tile.position.set(d.x + d.w / 2, 0.06, d.z + d.d / 2);
      tile.receiveShadow = true;
      g.add(tile);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(d.w + 0.04, 0.16, d.d + 0.04)),
        new THREE.LineBasicMaterial({ color: new THREE.Color(theme.district.edge).offsetHSL(jitter, 0, 0), transparent: true, opacity: theme.district.edgeAlpha, blending: blend }),
      );
      edges.position.copy(tile.position);
      g.add(edges);
      // Cell dots so empty capacity reads as "room".
      const dots = [];
      for (let s = 0; s < d.capacity; s++) {
        const p = slotPosition(d, s);
        dots.push(p.x, 0.125, p.z);
      }
      const dotGeo = new THREE.BufferGeometry();
      dotGeo.setAttribute('position', new THREE.Float32BufferAttribute(dots, 3));
      g.add(new THREE.Points(dotGeo, new THREE.PointsMaterial({ color: theme.district.dots, size: 0.12, transparent: true, opacity: 0.8 })));

      const div = document.createElement('div');
      div.className = 'district-label';
      const label = new CSS2DObject(div);
      label.position.set(d.x + 0.4, 0.2, d.z + 1.0);
      label.center.set(0, 0.5);
      g.add(label);
      d.label = div;
    }

    this.buildRouter();
  }

  /**
   * Keeps district labels readable: a label wider than its district on
   * screen drops its state chips (and, when tiny, its count), and a label
   * that would overlap a bigger district's label is hidden.
   */
  layoutDistrictLabels() {
    if (!this.plan) return;
    const W = this.renderer.domElement.clientWidth;
    const H = this.renderer.domElement.clientHeight;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const ds = [...this.plan.districts.values()].filter((d) => d.label).sort((x, y) => y.w * y.d - x.w * x.d);
    // The selected agent's label wins over district labels.
    const placed = [];
    const sel = this.agentLabels.find((o) => o.visible && o.element.classList.contains('selected'));
    if (sel) {
      const r = sel.element.getBoundingClientRect();
      if (r.width) placed.push({ x0: r.left, x1: r.right, y0: r.top, y1: r.bottom });
    }
    for (const d of ds) {
      a.set(d.x, 0, d.z + d.d / 2).project(this.camera);
      b.set(d.x + d.w, 0, d.z + d.d / 2).project(this.camera);
      const px = (Math.abs(b.x - a.x) / 2) * W;
      // Fit the label inside its district's width: full, then without
      // chips, then name only.
      const cl = d.label.classList;
      cl.remove('compact', 'tiny');
      if (d.label.offsetWidth > px) cl.add('compact');
      if (d.label.offsetWidth > px) cl.add('tiny');
      const r = d.label.getBoundingClientRect();
      const box = { x0: r.left - 4, x1: r.right + 4, y0: r.top - 2, y1: r.bottom + 2 };
      const off = r.right < 0 || r.left > W || r.bottom < 0 || r.top > H;
      const hit = placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0);
      d.label.classList.toggle('crowded', hit);
      if (!hit && !off) placed.push(box);
    }
  }

  updateDistrictLabels() {
    if (!this.plan || !this.model) return;
    const per = new Map();
    for (const rec of this.recs.values()) {
      const c = per.get(rec.agent.atespace) || { total: 0, running: 0, crashed: 0, transition: 0, match: 0 };
      c.total++;
      if (rec.cls === 'running') c.running++;
      if (rec.cls === 'crashed') c.crashed++;
      if (rec.cls === 'transition') c.transition++;
      if (this.filter(rec.agent)) c.match++;
      per.set(rec.agent.atespace, c);
    }
    for (const d of this.plan.districts.values()) {
      if (!d.label) continue;
      const c = per.get(d.name) || { total: 0, running: 0, crashed: 0, transition: 0, match: 0 };
      const chips = [];
      if (c.running) chips.push(`<span class="chip running">${c.running} running</span>`);
      if (c.transition) chips.push(`<span class="chip transition">${c.transition} changing</span>`);
      if (c.crashed) chips.push(`<span class="chip crashed">${c.crashed} crashed</span>`);
      d.label.innerHTML = `<div class="name">${esc(d.name)}</div><div class="meta">${c.total} agent${c.total === 1 ? '' : 's'} ${chips.join('')}</div>`;
      d.label.classList.toggle('dim', c.match === 0 && c.total > 0);
    }
  }

  // -------------------------------------------------------------- workers

  rebuildWorkers() {
    if (!this.model || !this.plan) return;
    const list = [...this.model.workers.values()].sort((a, b) => (a.pod || a.name).localeCompare(b.pod || b.name));
    const spacing = 4.2;
    const perRow = Math.max(1, Math.floor((this.plan.width + 4) / spacing));
    const want = new Set(list.map((w) => w.name));
    const hosted = new Map();
    for (const rec of this.recs.values()) {
      if (rec.agent.worker) hosted.set(rec.agent.worker, (hosted.get(rec.agent.worker) || 0) + 1);
    }
    for (const [name, w] of this.workers) {
      if (!want.has(name)) {
        this.world.remove(w.group);
        w.label.element.remove();
        this.workers.delete(name);
      }
    }
    list.forEach((wk, i) => {
      let w = this.workers.get(wk.name);
      if (!w) {
        const group = new THREE.Group();
        const pad = new THREE.Mesh(
          new THREE.BoxGeometry(3.2, 0.3, 1.8),
          new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.5 }),
        );
        pad.position.y = 0.15;
        pad.castShadow = true;
        pad.receiveShadow = true;
        group.add(pad);
        const padEdges = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(3.24, 0.32, 1.84)),
          new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 }),
        );
        padEdges.position.y = 0.15;
        group.add(padEdges);
        const glow = new THREE.Mesh(
          new THREE.PlaneGeometry(2.8, 1.4),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.0, depthWrite: false }),
        );
        glow.rotation.x = -Math.PI / 2;
        glow.position.y = 0.31;
        group.add(glow);
        const div = document.createElement('div');
        div.className = 'worker-label';
        const label = new CSS2DObject(div);
        label.position.set(0, 0.2, 1.75);
        group.add(label);
        this.world.add(group);
        w = { group, pad, padEdges, glow, label };
        this.workers.set(wk.name, w);
      }
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const inRow = Math.min(perRow, list.length - row * perRow);
      const x = this.island.cx - ((inRow - 1) * spacing) / 2 + col * spacing;
      const z = this.workerRowZ + row * 3;
      w.group.position.set(x, 0, z);
      const running = hosted.get(wk.name) || 0;
      const light = !theme.glow.additive;
      w.pad.material.color.set(running ? theme.worker.pad : theme.worker.idle);
      w.pad.material.roughness = light ? 0.85 : 0.45;
      w.pad.material.metalness = light ? 0 : 0.5;
      w.padEdges.material.color.set(theme.worker.padEdge);
      w.padEdges.material.blending = this.blending;
      w.glow.material.blending = this.blending;
      w.glow.material.opacity = running ? (0.06 + Math.min(running, 8) * 0.02) * (light ? 2.5 : 1) : 0.0;
      w.glow.material.color.set(wk.state === 'DRAINING' ? theme.worker.draining : theme.worker.active);
      w.name = wk.name;
      w.state = wk.state;
      w.label.visible = false;
      w.label.element.innerHTML = `<div class="name">${esc(workerLabel(wk))}</div><div class="meta">${running} actor${running === 1 ? '' : 's'}${wk.state && wk.state !== 'ACTIVE' ? ' · ' + esc(wk.state.toLowerCase()) : ''}</div>`;
      w.pos = new THREE.Vector3(x, 0.32, z);
    });
    this.rebuildWorkerLines();
  }

  rebuildWorkerLines() {
    const pts = [];
    for (const rec of this.recs.values()) {
      const wk = rec.agent.worker && this.workers.get(rec.agent.worker);
      if (!wk || !wk.pos) continue;
      pts.push(rec.x, this.topOf(rec), rec.z, wk.pos.x, wk.pos.y, wk.pos.z);
    }
    const g = this.workerLines.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    // Many lines add up; keep the bundle faint as it grows.
    const n = pts.length / 6;
    const a = theme.links.alpha;
    this.workerLines.material.opacity = Math.min(a, Math.max(a * 0.15, a * Math.sqrt(12 / Math.max(n, 1))));
    g.computeBoundingSphere();
  }

  // --------------------------------------------------------------- camera

  /** Pixels on the left covered by the events panel (the fit keeps clear of them). */
  setLeftInset(px) {
    this.leftInset = px;
  }

  fitCamera() {
    // Frame the island in the part of the view the events panel leaves
    // free: pull back to fit the narrower width and shift the target left
    // so the island (and the router tower on its left edge) clears the panel.
    const W = this.renderer.domElement.clientWidth || window.innerWidth;
    const inset = Math.min(this.leftInset || 0, W * 0.4);
    const span = Math.max(this.island.width, this.island.depth * 1.5);
    const dist = Math.max(26, span * 0.95) * (W / (W - inset));
    const viewW = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect;
    const cx = this.island.cx - (inset / 2 / W) * viewW;
    // Aim a little toward the front edge when pulled back, so the island
    // uses the empty sky above it.
    const cz = this.island.cz + 0.5 + (inset ? this.island.depth * 0.05 : 0);
    this.controls.target.set(cx, 0, cz);
    this.camera.position.set(cx + dist * 0.1, dist * 0.56, cz + dist * 0.84);
    this.controls.update();
  }

  /** Smoothly moves the camera to look at an agent. */
  flyTo(key) {
    const rec = this.recs.get(key);
    if (!rec) return;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = Math.max(Math.min(this.camera.position.distanceTo(this.controls.target), 34), 24);
    // With the side panel open, aim right of the agent so it sits left of
    // center, clear of the panel.
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(-dist * 0.18);
    const target = new THREE.Vector3(rec.x, 0.8, rec.z).add(right);
    const camTo = target.clone().add(dir.multiplyScalar(dist));
    this.flyAnim = { t0: this.time.value, dur: 0.9, fromT: this.controls.target.clone(), toT: target, fromC: this.camera.position.clone(), toC: camTo };
  }

  select(key) {
    this.selected = key;
    this.lastLabelUpdate = -1;
    this.updateMarker();
  }

  updateMarker() {
    const rec = this.selected && this.recs.get(this.selected);
    if (!rec) {
      this.marker.group.visible = false;
      return;
    }
    this.marker.group.visible = true;
    this.marker.group.position.set(rec.x, 0.14, rec.z);
    const top = this.topOf(rec);
    this.marker.beam.scale.y = 3;
    this.marker.beam.position.y = top + 1.5;
  }

  // -------------------------------------------------------------- picking

  bindPointer(el) {
    let down = null;
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      const key = this.pick(e.clientX, e.clientY);
      this.handlers.onPick?.(key);
    });
    el.addEventListener('pointermove', (e) => {
      if (down) return;
      this.hoverAt = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerleave', () => {
      this.hoverAt = null;
      this.setHover(null);
    });
  }

  pick(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.agents.pickable(), false);
    for (const h of hits) {
      const layer = h.object.userData.layer;
      if (h.instanceId !== undefined && h.instanceId < layer.keys.length) return layer.keys[h.instanceId];
    }
    return null;
  }

  /** The worker pad under the pointer, by worker name. */
  pickWorker(clientX, clientY) {
    if (!this.hoverAt) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const pads = [...this.workers.values()].map((w) => w.pad);
    const hit = this.raycaster.intersectObjects(pads, false)[0];
    if (!hit) return null;
    for (const [name, w] of this.workers) if (w.pad === hit.object) return name;
    return null;
  }

  setHover(key, x, y) {
    if (key !== this.hovered) {
      this.hovered = key;
      const rec = key && this.recs.get(key);
      this.hoverRing.visible = !!rec;
      if (rec) this.hoverRing.position.set(rec.x, 0.15, rec.z);
    }
    this.handlers.onHover?.(key, x, y);
  }

  // ---------------------------------------------------------------- frame

  frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 1.0) / this.slowmo;
    this.time.value += dt;
    const t = this.time.value;

    // Height animations.
    let linesDirty = false;
    for (const [key, an] of this.anims) {
      const rec = this.recs.get(key);
      if (!rec) {
        this.anims.delete(key);
        continue;
      }
      const k = Math.min((t - an.t0) / an.dur, 1);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      rec.h = an.fromH + (an.toH - an.fromH) * e;
      rec.tip = an.fromTip + (an.toTip - an.fromTip) * e;
      this.writeMatrix(rec);
      if (rec.agent.worker) linesDirty = true;
      if (key === this.selected) this.updateMarker();
      if (k >= 1) this.anims.delete(key);
    }
    if (linesDirty) this.rebuildWorkerLines();
    this.agents.flush();

    // Fly-to.
    if (this.flyAnim) {
      const f = this.flyAnim;
      const k = Math.min((t - f.t0) / f.dur, 1);
      const e = 1 - Math.pow(1 - k, 3);
      this.controls.target.lerpVectors(f.fromT, f.toT, e);
      this.camera.position.lerpVectors(f.fromC, f.toC, e);
      if (k >= 1) this.flyAnim = null;
    }
    this.controls.update();

    // Selection marker pulse, router beacon.
    if (this.marker.group.visible) {
      const s = 1 + 0.12 * Math.sin(t * 3);
      this.marker.ring.scale.set(s, s, s);
    }
    this.router?.update(t, dt);

    this.effects.update(t);

    if (this.hoverAt && t - (this.lastHoverPick || 0) > 0.05) {
      this.lastHoverPick = t;
      const key = this.pick(this.hoverAt.x, this.hoverAt.y);
      this.setHover(key, this.hoverAt.x, this.hoverAt.y);
      const pad = key ? null : this.pickWorker(this.hoverAt.x, this.hoverAt.y);
      if (pad !== this.hoverWorker) {
        this.hoverWorker = pad;
        this.lastLabelUpdate = -1;
      }
    }

    if (t - this.lastLabelUpdate > 0.25) {
      this.lastLabelUpdate = t;
      this.updateAgentLabels();
      this.layoutDistrictLabels();
      this.layoutWorkerLabels();
      this.keepRouterLabelClear();
    }

    this.composer.render();
    this.labelRenderer.render(this.scene, this.camera);
  }

  /**
   * Worker pad labels are quiet like agent labels: shown for the hovered
   * pad, the selected agent's pad, pads that aren't plainly active (for
   * example draining), and every pad when the camera is close to it or
   * labels are 'all'. They are placed greedily in screen space after the
   * district and agent labels and never overlap them or each other.
   */
  layoutWorkerLabels() {
    if (!this.workers.size) return;
    const W = this.renderer.domElement.clientWidth;
    const H = this.renderer.domElement.clientHeight;
    const cam = this.camera.position;
    const mode = this.labelMode;
    const host = this.selected && this.recs.get(this.selected)?.agent.worker;
    const placed = [];
    const obstacle = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width) placed.push({ x0: r.left, x1: r.right, y0: r.top, y1: r.bottom });
    };
    for (const o of this.agentLabels) if (o.visible) obstacle(o.element);
    if (this.plan) for (const d of this.plan.districts.values()) if (d.label && !d.label.classList.contains('crowded')) obstacle(d.label);
    const items = [];
    const wp = new THREE.Vector3();
    for (const [name, w] of this.workers) {
      w.label.getWorldPosition(wp);
      const notable = !!w.state && w.state !== 'ACTIVE';
      const prio = name === this.hoverWorker ? 0 : name === host ? 1 : notable ? 2 : 3;
      const near = cam.distanceTo(wp) < WORKER_LABEL_DISTANCE;
      const want = prio === 0 || (mode !== 'off' && (prio < 3 || near || mode === 'all'));
      w.label.visible = false;
      if (want) items.push({ w, prio, d: cam.distanceTo(wp), p: wp.clone() });
    }
    items.sort((a, b) => a.prio - b.prio || a.d - b.d);
    for (const { w, p } of items) {
      p.project(this.camera);
      if (p.z > 1) continue;
      const x = (p.x * 0.5 + 0.5) * W;
      const y = (-p.y * 0.5 + 0.5) * H;
      // Estimated from the text: the element isn't laid out while hidden.
      const chars = Math.max(4, ...[...w.label.element.children].map((c) => c.textContent.length));
      const half = chars * 3.2 + 6;
      const box = { x0: x - half, x1: x + half, y0: y - 15, y1: y + 15 };
      if (placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
      placed.push(box);
      w.label.visible = true;
    }
  }

  /** Moves the router's label to the right of its anchor when the events panel would cover it. */
  keepRouterLabelClear() {
    const l = this.router?.labelObj;
    if (!l) return;
    const p = l.getWorldPosition(new THREE.Vector3()).project(this.camera);
    const x = (p.x * 0.5 + 0.5) * this.renderer.domElement.clientWidth;
    const w = l.element.offsetWidth || 110;
    const covered = x - w / 2 < (this.leftInset || 0);
    l.center.set(covered ? 0 : 0.5, 0.5);
  }

  /**
   * Picks which agents get a label. In 'auto' mode: the selected agent,
   * agents that just changed state (for a few seconds), and the agents near
   * the camera only when it is close in on a district. 'all' labels every
   * agent near the camera; 'off' none. Hovering shows a tooltip instead.
   */
  updateAgentLabels() {
    const cam = this.camera.position;
    const t = this.time.value;
    const mode = this.labelMode;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse),
    );
    const near = [];
    const p = new THREE.Vector3();
    const closeUp = cam.distanceTo(this.controls.target) < CLOSE_UP_DISTANCE;
    const maxDist = mode === 'all' ? 60 : closeUp ? 34 : 0;
    if (mode !== 'off') {
      for (const rec of this.recs.values()) {
        p.set(rec.x, this.topOf(rec), rec.z);
        const selected = rec.key === this.selected;
        const until = this.labelPinned.get(rec.key) || 0;
        const pinned = until > t;
        const d = cam.distanceTo(p);
        let prio;
        if (selected) prio = -1e9;
        else if (pinned && this.filter(rec.agent)) prio = -until; // newest change first
        else if (d <= maxDist && this.filter(rec.agent)) prio = d;
        else continue;
        if (!frustum.containsPoint(p)) continue;
        near.push({ rec, d: prio, fade: pinned && !selected && until - t < 1.5 });
      }
    }
    near.sort((a, b) => a.d - b.d);
    // Greedy screen-space placement: skip a label that would overlap one
    // already placed, so a dense district doesn't turn into a smear.
    const W = this.renderer.domElement.clientWidth;
    const H = this.renderer.domElement.clientHeight;
    // District labels are obstacles: a passing agent label never covers one.
    const placed = [];
    if (this.plan) {
      for (const d of this.plan.districts.values()) {
        if (!d.label || d.label.classList.contains('crowded')) continue;
        const r = d.label.getBoundingClientRect();
        if (r.width) placed.push({ x0: r.left, x1: r.right, y0: r.top, y1: r.bottom });
      }
    }
    const chosen = [];
    for (const item of near) {
      if (chosen.length >= this.agentLabels.length) break;
      const { rec } = item;
      p.set(rec.x, this.topOf(rec) + 0.13, rec.z).project(this.camera);
      const x = (p.x * 0.5 + 0.5) * W;
      const y = (-p.y * 0.5 + 0.5) * H;
      const w = 40 + rec.agent.name.length * 7 + (rec.agent.state.length + 8) * 5.6;
      const box = { x0: x - w * 0.1, x1: x + w * 0.9, y0: y - 22, y1: y };
      const hit = placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
      if (hit && item.d > -1e9) continue;
      placed.push(box);
      chosen.push(item);
    }
    const now = Date.now();
    for (let i = 0; i < this.agentLabels.length; i++) {
      const obj = this.agentLabels[i];
      const item = chosen[i];
      if (!item) {
        obj.visible = false;
        continue;
      }
      const { rec } = item;
      obj.visible = true;
      obj.position.set(rec.x, this.topOf(rec) + 0.13, rec.z);
      const a = rec.agent;
      const age = duration(since(a.stateSince, now));
      const html = `<span class="dot" style="background:${cssColor(a.state)}"></span>${esc(a.name)}<span class="sub">${esc(a.state.toLowerCase())} ${age}</span>`;
      if (obj.element.innerHTML !== html) obj.element.innerHTML = html;
      obj.element.classList.toggle('selected', rec.key === this.selected);
      obj.element.classList.toggle('fading', !!item.fade);
    }
    for (const [k, until] of this.labelPinned) if (until < t) this.labelPinned.delete(k);
  }
}
