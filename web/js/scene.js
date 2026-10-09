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

// The 3D scene: the cluster island, districts (atespaces, or workers grouped
// by node pool and node in the "group by worker" view), agents, worker pads
// with flowing links to their agents, the router (in a switchable look), and
// the short animations that show events.
//
// Agents are drawn at three levels of detail (see lod.js): far, each
// district is one aggregate tile (tiles.js); mid, each agent is one point
// sprite (points.js); close, the agents nearest the camera, up to a budget,
// are full shapes (agents.js: one InstancedMesh per visual class), and the
// rest stay points. The levels crossfade per pixel in the shaders. Small
// clusters (no more agents than the budget) draw every agent as a shape,
// as before.

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
import { planIsland, slotPosition, slotAt, SlotTable } from './layout.js';
import { esc, duration, since, workerLabel } from './format.js';
import { Effects } from './effects.js';
import { themeById, classColor, hex } from './themes.js';
import { buildGround, hashString } from './island.js';
import { LinkSet } from './links.js';
import { WorkerPads, PAD_H } from './pads.js';
import { PARKED, WORKER_STRIP, groupId, groupOf, groupCounts, planWorkerView, planPadArea, focusOf, levelOf, sameFocus, workerUsage, teamHues, teamCSS } from './workers.js';
import { PointLayer, CLASS_INDEX } from './points.js';
import { AggregateTiles } from './tiles.js';
import { Aggregates, RectIndex, selectNearest, pickRay, cellPixels, depthForPixels, farMix, lodLevel, FAR_LO, FAR_HI, SHAPE_PX, SHAPE_BUDGET } from './lod.js';
import { FrameStats } from './perf.js';

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

/** Sets a label's HTML when it changed (and forgets its size estimate). */
function setHTML(el, html) {
  if (el.innerHTML === html) return;
  el.innerHTML = html;
  el._est = null;
}

/**
 * A district label's size on screen, estimated from its text (no layout
 * reads, which force reflows): widths full, without chips (compact) and
 * name only (tiny), and heights.
 */
function labelSize(el) {
  if (el._est) return el._est;
  const name = el.querySelector('.name')?.textContent.length || 0;
  const meta = el.querySelector('.meta');
  let base = 0;
  let chips = 0;
  if (meta) {
    for (const n of meta.childNodes) {
      if (n.nodeType === 1 && n.classList.contains('chip')) chips += n.textContent.length * 5.8 + 25;
      else base += (n.textContent || '').length * 6.2;
    }
  }
  const nameW = name * 8 + 22;
  el._est = { full: Math.max(nameW, base + chips + 22), compact: Math.max(nameW, base + 22), tiny: nameW, h: meta ? 38 : 24, th: 24 };
  return el._est;
}

// Seconds a label stays up after its agent changes state (crashes: twice).
const CHANGE_LABEL_SECONDS = 6;
// Camera-to-target distance under which 'auto' labels every nearby agent.
const CLOSE_UP_DISTANCE = 20;
// Camera-to-pad distance under which worker pads show their labels.
const WORKER_LABEL_DISTANCE = 34;
// Seconds agents take to move between layouts when the grouping changes.
const MOVE_SECONDS = 0.8;
// Above this many agents, layout changes are instant (no tween).
const MOVE_MAX_AGENTS = 20000;
// Seconds between level-of-detail re-selections of the shapes near the camera.
const NEAR_EVERY = 0.2;
// Seconds between label passes (agent, district, pad labels) and aggregate updates.
const LABEL_EVERY = 0.25;
// Re-plans (a district overflowed, a new atespace or worker) wait at least this long after the last.
const REPLAN_EVERY = 1.0;
// Effects at scale: at most this many per second (burst: twice that), only in view.
const FX_RATE = 10;
// Point sprites' lift per class (matches points.js), for picking.
const POINT_TOP = { running: 1.0, transition: 0.8, suspended: 0.5, crashed: 0.6, pending: 0.7 };
// Most "just changed" agent labels at once in big clusters.
const MAX_PINNED = 10;
// Pooled labels for worker platforms in big worker views.
const PLATFORM_LABELS = 24;

export class Scene {
  /**
   * @param {HTMLElement} container
   * @param {{onPick?: Function, onHover?: Function, onHoverWorker?: Function, onFocus?: Function}} handlers
   * @param {{shape?: string, router?: string, extras?: boolean, group?: string, budget?: number, quality?: string}} opts
   */
  constructor(container, handlers = {}, opts = {}) {
    this.container = container;
    this.handlers = handlers;
    this.time = { value: 0 };
    this.timer = new THREE.Timer();
    this.recs = new Map();
    /** point index -> agent key */
    this.keyOfIdx = [];
    this.filter = () => true;
    this.selected = null;
    this.anims = new Map();
    this.labelPinned = new Map(); // key -> until (seconds)
    // Agent labels: 'auto' (selected, recent changes, close-ups), 'all', 'off'.
    this.labelMode = 'auto';
    this.plan = null;
    this.model = null;
    // 'atespace' or 'worker': what the districts are (see workers.js).
    this.group = groupId(opts.group);
    // What the user points at; focusOf() turns it into the worker in focus.
    this.hl = { hoverWorker: null, pinnedWorker: null, hoverAgent: null, selectedAgent: null };
    this.focus = { worker: null, strong: false };
    // Agents moving between layouts: key -> {fx, fz, tx, tz, t0, dur}.
    this.moves = new Map();
    this.teams = new Map();
    // Level of detail: the agents drawn as shapes, and how many may be.
    this.near = new Set();
    this.budget = Math.max(100, Math.floor(opts.budget || SHAPE_BUDGET));
    this.baseBudget = this.budget;
    this.allShapes = true;
    this.closeR = { target: 1e6, value: 1e6 };
    this.lastNear = { t: -1, x: NaN, y: NaN, z: NaN, tx: NaN, tz: NaN };
    this.lod = 'close';
    // Incremental bookkeeping: per-district counts, agents per worker.
    this.agg = new Aggregates();
    this.hosted = new Map();
    this.byWorker = new Map();
    this.workerIx = new Map();
    this.dirtyGroups = new Set();
    this.dirtyPads = new Set();
    this.labelsDirty = true;
    this.replanAt = -1;
    this.lastReplan = -Infinity;
    this.fxTokens = FX_RATE * 2;
    this.frameStats = new FrameStats();
    this.cameraDriver = null;
    this.lastInfo = { calls: 0, triangles: 0, points: 0, lines: 0 };
    this.lastCpu = 0;
    const rm = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.reducedMotion = !!rm?.matches;
    rm?.addEventListener?.('change', (e) => {
      this.reducedMotion = e.matches;
      this.links.setFlow(this.extras && !this.reducedMotion);
    });
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
    // Quality: 'auto' lowers the pixel ratio (then bloom) while frames are
    // slow and raises it back when there is headroom; 'high' never lowers;
    // 'low' starts at pixel ratio 1 without bloom.
    const mode = ['auto', 'high', 'low'].includes(opts.quality) ? opts.quality : 'auto';
    const maxDpr = Math.min(window.devicePixelRatio || 1, 2);
    this.quality = { mode, maxDpr, dpr: mode === 'low' ? 1 : maxDpr, bloom: mode !== 'low', slow: 0, fast: 0, lastCheck: 0 };
    renderer.setPixelRatio(this.quality.dpr);
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.info.autoReset = false;
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

    // Shared agent-shader uniforms the theme and the level of detail set.
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
      // How far agents outside a focused worker recede.
      uHiDim: { value: 0.7 },
      // Atespace tiles (worker view): strength, and the tints' saturation and lightness.
      uTeam: { value: 0 },
      uTeamSat: { value: 0.5 },
      uTeamLight: { value: 0.6 },
      // Level of detail (device pixels per world unit at depth 1, and the
      // cell sizes in device pixels where tiles give way to agents).
      uScale: { value: 600 },
      uFarLo: { value: FAR_LO },
      uFarHi: { value: FAR_HI },
      uCloseNear: { value: 1e6 },
      uCloseFar: { value: 2e6 },
      uAllShapes: { value: 1 },
    };

    this.world = new THREE.Group();
    scene.add(this.world);
    this.islandGroup = new THREE.Group();
    this.world.add(this.islandGroup);
    this.agentGroup = new THREE.Group();
    this.world.add(this.agentGroup);

    this.points = new PointLayer(this.agentGroup, this.time, this.look);
    this.tiles = new AggregateTiles(this.world, this.time, this.look);
    this.buildAgents();

    this.effects = new Effects(this.world, this.time);
    this.addBackdrop();
    this.addSelectionMarker();

    // Agent-to-worker links (arcs with flowing dots) and the worker pads.
    this.links = new LinkSet(this.world, this.time);
    this.links.setFlow(this.extras && !this.reducedMotion);
    const makeLabel = (cls) => {
      const div = document.createElement('div');
      div.className = cls;
      return new CSS2DObject(div);
    };
    this.pads = new WorkerPads(this.world, makeLabel);
    // Labels lent to the worker platforms in view (big worker views).
    this.platformLabels = [];
    for (let i = 0; i < PLATFORM_LABELS; i++) {
      const l = makeLabel('district-label');
      l.element.classList.add('worker');
      l.center.set(0, 0.5);
      l.visible = false;
      this.world.add(l);
      this.platformLabels.push(l);
    }

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
          uFade: { value: 0.018 },
        },
        vertexShader: `varying vec3 vP; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vP = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
        fragmentShader: `varying vec3 vP; uniform vec3 uGrid; uniform float uGridA; uniform vec3 uSea; uniform float uSeaA; uniform float uFade;
          void main(){
            vec2 g = abs(fract(vP.xz / 4.0 - 0.5) - 0.5) / fwidth(vP.xz / 4.0);
            float line = 1.0 - min(min(g.x, g.y), 1.0);
            float d = length(vP.xz);
            float fade = exp(-d * uFade);
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
    this.links.setScale(h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))));
    this.updateLodUniforms();
  }

  /** Pixel-dependent level-of-detail uniforms (device pixels: gl_PointSize is in them). */
  updateLodUniforms() {
    const h = this.container.clientHeight || window.innerHeight;
    const dpr = this.renderer.getPixelRatio();
    this.look.uScale.value = (h * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.look.uFarLo.value = FAR_LO * dpr;
    this.look.uFarHi.value = FAR_HI * dpr;
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
    this.scene.fog.density = sc.fogDensity * this.fogScale();
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
    this.look.uHiDim.value = g.additive ? 0.72 : 0.78;
    this.look.uTeamSat.value = t.team.saturation;
    this.look.uTeamLight.value = t.team.lightness;
    // Light themes draw every class at full strength (their suspended color
    // is already pale) and blend the extras normally.
    this.agents.setTheme(t);
    this.applyClassColors();

    this.applyBloom();

    const blend = this.blending;
    this.styleLinks();
    this.marker.ring.material.color.set(t.marker.select);
    this.marker.beam.material.color.set(t.marker.select);
    this.hoverRing.material.color.set(t.marker.hover);
    for (const m of [this.marker.ring.material, this.marker.beam.material, this.hoverRing.material]) m.blending = blend;
    this.effects.blending = blend;

    // Shadows and blending changes need recompiled materials.
    this.scene.traverse((o) => {
      for (const m of [o.material].flat()) if (m) m.needsUpdate = true;
    });
    // Rebuild the ground and pads, recolor the agents drawn as shapes.
    if (this.model && this.plan) {
      this.buildIsland(this.model.cluster);
      for (const key of this.near) this.writeColor(this.recs.get(key));
      this.rebuildWorkers();
      this.syncTiles();
      this.labelsDirty = true;
    }
  }

  /** State colors for the point sprites and the far tiles. */
  applyClassColors() {
    const colors = Object.fromEntries(CLASSES.map((c) => [c, classColor(theme, c)]));
    this.points.setLook(colors, this.shape.id, theme.glow.additive ? THREE.AdditiveBlending : THREE.NormalBlending);
    this.tiles.setColors(colors, THREE.NormalBlending);
  }

  applyBloom() {
    this.bloom.enabled = theme.bloom.strength > 0 && this.quality.bloom;
    this.bloom.strength = theme.bloom.strength;
    this.bloom.radius = theme.bloom.radius;
    this.bloom.threshold = theme.bloom.threshold;
  }

  /** Fog thins out on big islands, so the far side doesn't vanish. */
  fogScale() {
    const span = this.island ? Math.max(this.island.width, this.island.depth * 1.5) : 0;
    return Math.min(1, 170 / Math.max(span, 1));
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
    this.applyClassColors();
    this.anims.clear();
    const near = [...this.near];
    this.near.clear();
    for (const key of near) {
      const rec = this.recs.get(key);
      rec.slot = -1;
      const pose = shape.pose[rec.cls];
      rec.h = pose.h;
      rec.tip = pose.tip;
      this.attach(rec);
    }
    for (const rec of this.recs.values()) {
      if (rec.slot >= 0) continue;
      const pose = shape.pose[rec.cls];
      rec.h = pose.h;
      rec.tip = pose.tip;
    }
    this.relinkAll();
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
    this.links.setFlow(on && !this.reducedMotion);
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
    return rec.slot >= 0 || this.allShapes ? this.shape.top(rec.h, rec.tip) : POINT_TOP[rec.cls];
  }

  // ---------------------------------------------------------------- data

  /** Rebuilds everything from the model (after a snapshot or a re-plan). */
  setModel(model) {
    this.model = model;
    for (const cls of CLASSES) this.layers[cls].clear();
    this.near.clear();
    for (const rec of this.recs.values()) this.points.free(rec.idx);
    this.points.clear();
    this.keyOfIdx = [];
    this.recs.clear();
    this.anims.clear();
    this.moves.clear();
    this.links.clear();
    this.replan(true);
  }

  /** The district plan for the current grouping, with its far tiles and (atespace view) pad area. */
  makePlan() {
    const model = this.model;
    const counts = groupCounts(model, this.group);
    if (this.group === 'worker') {
      const workers = [...counts.entries()]
        .filter(([name]) => name !== PARKED)
        .map(([name, count]) => {
          const w = model.workers.get(name);
          return { name, count, capacity: w?.capacityActors || 0, pool: w?.pool, node: w?.node };
        });
      const plan = planWorkerView(workers, counts.get(PARKED) || 0);
      plan.padArea = null;
      return plan;
    }
    const atespaces = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => (a.name < b.name ? -1 : 1));
    const plan = planIsland(atespaces.length ? atespaces : [{ name: '(none)', count: 0 }]);
    plan.tiles = [...plan.districts.values()].map((d) => ({ name: d.name, kind: 'atespace', x: d.x, z: d.z, w: d.w, d: d.d, groups: [d.name] }));
    plan.frames = [];
    // The worker pads along the front edge, grouped by node pool.
    const area = planPadArea([...model.workers.values()], plan.width);
    const ox = -1.2;
    const oz = plan.depth / 2 + 3.2;
    plan.padArea = { items: area.items.map((it) => ({ ...it, x: it.x + ox, z: it.z + oz })) };
    plan.padFrames = area.frames.map((f) => ({ ...f, x: f.x + ox, z: f.z + oz }));
    plan.padDepth = area.depth;
    return plan;
  }

  /** Asks for a re-plan soon (coalesced: at most one per REPLAN_EVERY). */
  replanSoon() {
    if (this.replanAt < 0) this.replanAt = Math.max(this.time.value, this.lastReplan + REPLAN_EVERY);
  }

  /**
   * Lays out the island again and places every agent. With tween, agents
   * glide from where they were to their new cells (a grouping change).
   */
  replan(fit = false, tween = false) {
    const model = this.model;
    const firstPlan = !this.plan;
    this.replanAt = -1;
    this.lastReplan = this.time.value;
    this.plan = this.makePlan();
    this.slots = new Map();
    for (const d of this.plan.districts.values()) this.slots.set(d.name, new SlotTable(d.capacity));
    this.distIndex = new RectIndex([...this.plan.districts.values()]);
    this.teams = teamHues(model.atespaces.size ? model.atespaces.keys() : new Set([...model.agents.values()].map((a) => a.atespace)));
    this.buildIsland(model.cluster);

    const keys = [...model.agents.keys()].sort();
    const existing = this.recs;
    for (const cls of CLASSES) this.layers[cls].clear();
    this.near.clear();
    this.recs = new Map();
    this.agg.clear();
    this.hosted.clear();
    this.byWorker.clear();
    this.allShapes = keys.length <= this.baseBudget;
    this.look.uAllShapes.value = this.allShapes ? 1 : 0;
    this.points.points.visible = !this.allShapes;
    const animate = tween && !this.reducedMotion && keys.length <= MOVE_MAX_AGENTS;
    const t0 = this.time.value;
    this.moves.clear();
    for (const key of keys) {
      const a = model.agents.get(key);
      const old = existing.get(key);
      if (old) old.slot = -1;
      if (!this.place(key, a, old)) continue;
      if (animate && old) {
        const rec = this.recs.get(key);
        this.moves.set(key, { fx: old.x, fz: old.z, tx: rec.x, tz: rec.z, t0: t0 + rec.seed * 0.15, dur: MOVE_SECONDS });
        rec.x = old.x;
        rec.z = old.z;
        this.writePos(rec);
      }
    }
    // Agents that are gone (or found no room) free their points.
    for (const [key, old] of existing) {
      if (this.recs.has(key)) continue;
      this.points.free(old.idx);
      this.keyOfIdx[old.idx] = undefined;
      this.links.remove(key);
    }
    this.links.clear();
    this.rebuildWorkers();
    this.syncTiles();
    this.labelsDirty = true;
    this.lastNear.t = -1;
    this.refreshNear(true);
    this.relinkAll();
    this.updateMarker();
    if (fit || firstPlan) this.fitCamera();
    if (firstPlan) this.precompile();
  }

  /**
   * Compiles every material up front, including the far tiles and points
   * that are hidden until the camera pulls back, so the first zoom out
   * doesn't stall on shader compiles.
   */
  precompile() {
    const hidden = [this.tiles.mesh, this.points.points].filter((o) => !o.visible);
    for (const o of hidden) o.visible = true;
    try {
      this.renderer.compile(this.scene, this.camera);
    } finally {
      for (const o of hidden) o.visible = false;
    }
  }

  /** Places an agent; from: its earlier record (keeps its point and pose). */
  place(key, a, from) {
    const group = groupOf(a, this.group);
    const table = this.slots.get(group);
    if (!table) return false;
    const cell = table.assign(key);
    if (cell < 0) return false;
    const district = this.plan.districts.get(group);
    const p = slotPosition(district, cell);
    const cls = stateClass(a.state);
    const pose = this.shape.pose[cls];
    const idx = from && from.idx >= 0 ? from.idx : this.points.alloc();
    const rec = { key, agent: a, cls, group, cell, x: p.x, z: p.z, h: from?.h ?? pose.h, tip: from?.tip ?? pose.tip, seed: from?.seed ?? hashString(key), idx, slot: -1, match: this.filter(a) };
    this.keyOfIdx[idx] = key;
    this.recs.set(key, rec);
    this.writePoint(rec);
    this.account(rec, 1);
    if (this.allShapes) this.attach(rec);
    return true;
  }

  /** Adds (sign 1) or removes (-1) an agent from the per-district and per-worker counts. */
  account(rec, sign) {
    const a = rec.agent;
    if (sign > 0) this.agg.add(rec.group, rec.cls, rec.match, a.atespace);
    else this.agg.remove(rec.group, rec.cls, rec.match, a.atespace);
    this.dirtyGroups.add(rec.group);
    this.labelsDirty = true;
    const w = a.worker;
    if (!w) return;
    this.hosted.set(w, (this.hosted.get(w) || 0) + sign);
    let set = this.byWorker.get(w);
    if (sign > 0) {
      if (!set) this.byWorker.set(w, (set = new Set()));
      set.add(rec.key);
    } else set?.delete(rec.key);
    this.dirtyPads.add(w);
    if (this.group === 'worker') this.dirtyGroups.add(w);
  }

  /** A stable small number per worker (for the point shader's focus test). */
  workerIndex(name) {
    if (!name) return -1;
    let i = this.workerIx.get(name);
    if (i === undefined) this.workerIx.set(name, (i = this.workerIx.size));
    return i;
  }

  /** Writes everything about an agent's point. */
  writePoint(rec) {
    const pts = this.points;
    pts.setPos(rec.idx, rec.x, 0, rec.z);
    pts.setA(rec.idx, CLASS_INDEX[rec.cls], rec.seed, rec.match ? 0 : 1, this.workerIndex(rec.agent.worker));
    pts.setTeam(rec.idx, this.teamOf(rec));
    pts.setNear(rec.idx, rec.slot >= 0);
  }

  /**
   * Moves an agent whose district changed (worker view: it got or lost a
   * worker) to a cell in its new district, gliding there. False when the
   * new district is full or missing (the island must be re-planned).
   */
  regroup(rec) {
    const group = groupOf(rec.agent, this.group);
    if (group === rec.group) return true;
    const table = this.slots.get(group);
    if (!table) return false;
    const cell = table.assign(rec.key);
    if (cell < 0) return false;
    this.slots.get(rec.group)?.release(rec.key);
    rec.group = group;
    rec.cell = cell;
    const team = this.teamOf(rec);
    this.points.setTeam(rec.idx, team);
    if (rec.slot >= 0) {
      const layer = this.layers[rec.cls];
      layer.team.array[rec.slot] = team;
      layer.markSlot(rec.slot);
    }
    const p = slotPosition(this.plan.districts.get(group), cell);
    if (this.reducedMotion || (rec.slot < 0 && !this.allShapes)) {
      rec.x = p.x;
      rec.z = p.z;
      this.moves.delete(rec.key);
      this.writePos(rec);
    } else {
      this.moves.set(rec.key, { fx: rec.x, fz: rec.z, tx: p.x, tz: p.z, t0: this.time.value, dur: MOVE_SECONDS * 1.2 });
    }
    return true;
  }

  /** Draws an agent as a full shape (it joins the near set). */
  attach(rec) {
    const layer = this.layers[rec.cls];
    rec.slot = layer.add(rec.key);
    layer.seed.array[rec.slot] = rec.seed;
    layer.dim.array[rec.slot] = rec.match ? 0 : 1;
    layer.flash.array[rec.slot] = 0;
    layer.hi.array[rec.slot] = levelOf(this.focus, rec.agent.worker);
    layer.team.array[rec.slot] = this.teamOf(rec);
    this.writeActivity(rec);
    this.writeColor(rec);
    this.writeMatrix(rec);
    this.near.add(rec.key);
    this.points.setNear(rec.idx, true);
  }

  writeColor(rec) {
    if (!rec || rec.slot < 0) return;
    const c = new THREE.Color(stateColor(rec.agent.state));
    const layer = this.layers[rec.cls];
    layer.mesh.instanceColor.setXYZ(rec.slot, c.r, c.g, c.b);
    layer.markSlot(rec.slot);
  }

  /** The atespace tint of an agent's tile: its hue, plus 2 when parked (drawn fainter); -1 for none. */
  teamOf(rec) {
    const hue = this.teams.get(rec.agent.atespace);
    if (hue === undefined) return -1;
    return rec.group === PARKED ? hue + 2 : hue;
  }

  /** Stops drawing an agent as a shape (it leaves the near set; its point stays). */
  detach(rec) {
    if (rec.slot < 0) return;
    const layer = this.layers[rec.cls];
    const moved = layer.remove(rec.slot);
    if (moved) this.recs.get(moved).slot = rec.slot;
    rec.slot = -1;
    this.near.delete(rec.key);
    this.points.setNear(rec.idx, false);
  }

  /** Writes a shape's matrix (pose and position). */
  writeMatrix(rec) {
    if (rec.slot < 0) return;
    const layer = this.layers[rec.cls];
    this.shape.matrix(layer.mesh.instanceMatrix.array, rec.slot * 16, rec.x, rec.z, rec.h, rec.tip);
    layer.markSlot(rec.slot);
  }

  /** Writes an agent's position (point and shape). */
  writePos(rec) {
    this.points.setPos(rec.idx, rec.x, 0, rec.z);
    this.writeMatrix(rec);
  }

  /**
   * Idle progress (1 = just served, 0 = about to suspend; -1 = unknown) and
   * whether the agent is serving a request. The collector doesn't stream
   * either yet, so real agents show neither; synthetic mode fakes both (the
   * shader runs the fake idle timer from aIdle as a phase).
   */
  writeActivity(rec) {
    if (rec.slot < 0) return;
    const layer = this.layers[rec.cls];
    const fake = this.fake.value > 0;
    const a = rec.agent;
    let idle = -1;
    if (fake) idle = (rec.seed * 7.31) % 1;
    else if (typeof a.idleProgress === 'number') idle = a.idleProgress;
    layer.attrs.aIdle.array[rec.slot] = idle;
    layer.attrs.aServe.array[rec.slot] = this.serving(rec) ? 1 : 0;
    layer.markSlot(rec.slot);
  }

  /** Whether an agent is serving a request (synthetic mode: a fixed random subset). */
  serving(rec) {
    if (this.fake.value > 0) return (rec.seed * 13.7) % 1 < 0.22;
    return (rec.agent.inFlight || 0) > 0;
  }

  /** Big scenes play effects only where they can be seen, and only so many per second. */
  fxAllowed(x, z) {
    if (this.allShapes) return true;
    if (this.fxTokens < 1) return false;
    const p = new THREE.Vector3(x, 0.5, z);
    if (!this.frustum().containsPoint(p)) return false;
    const depth = p.applyMatrix4(this.camera.matrixWorldInverse).z * -1;
    if (cellPixels(depth, this.viewH(), this.camera.fov) < FAR_HI) return false;
    this.fxTokens -= 1;
    return true;
  }

  /** Whether a state-change label is worth pinning (in view, not a far tile). */
  labelAllowed(rec) {
    if (this.allShapes) return true;
    const p = new THREE.Vector3(rec.x, 0.5, rec.z);
    if (!this.frustum().containsPoint(p)) return false;
    const depth = p.applyMatrix4(this.camera.matrixWorldInverse).z * -1;
    return cellPixels(depth, this.viewH(), this.camera.fov) >= SHAPE_PX;
  }

  frustum() {
    if (this._frustumAt !== this.time.value) {
      this._frustumAt = this.time.value;
      this.camera.updateMatrixWorld();
      this._frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    }
    return this._frustum;
  }

  viewH() {
    return this.renderer.domElement.clientHeight || window.innerHeight;
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
        case 'worker_removed':
          // Platforms (worker view) and the pad area come and go.
          replan = true;
          workersChanged = true;
          break;
        case 'worker_updated':
          this.dirtyPads.add(ev.key);
          break;
        default:
          break;
      }
      if (!ev.type.startsWith('agent_') && ev.type !== 'task_updated' && ev.type !== 'worker_assignment') continue;
      const key = ev.key;
      if (ev.type === 'agent_removed') {
        const rec = this.recs.get(key);
        if (rec) {
          if (this.fxAllowed(rec.x, rec.z)) this.effects.ripple(rec.x, rec.z, theme.effects.removed, 1.2);
          this.account(rec, -1);
          this.detach(rec);
          this.points.free(rec.idx);
          this.keyOfIdx[rec.idx] = undefined;
          this.recs.delete(key);
          this.moves.delete(key);
          this.anims.delete(key);
          this.links.remove(key);
          this.slots.get(rec.group)?.release(key);
        }
        continue;
      }
      let rec = this.recs.get(key);
      if (!rec) {
        if (!this.place(key, ev.agent)) {
          replan = true;
          continue;
        }
        rec = this.recs.get(key);
        rec.h = 0;
        rec.tip = 0;
        this.writeMatrix(rec);
        this.animatePose(rec, 1.2);
        if (ev.agent.task && this.fxAllowed(rec.x, rec.z)) this.effects.beam(rec.x, rec.z, theme.effects.beam);
        if (this.labelAllowed(rec)) this.pinLabel(key, CHANGE_LABEL_SECONDS);
        this.lastNear.t = -1;
        this.syncLink(rec);
        continue;
      }
      const prevState = rec.agent.state;
      const prevWorker = rec.agent.worker;
      this.account(rec, -1);
      rec.agent = ev.agent;
      rec.match = this.filter(ev.agent);
      if (prevState !== ev.agent.state) this.restyle(rec);
      let moved = true;
      if (prevWorker !== ev.agent.worker) {
        moved = this.regroup(rec);
        this.points.setWorker(rec.idx, this.workerIndex(ev.agent.worker));
        this.writeHi(rec);
      }
      this.account(rec, 1);
      this.points.setDim(rec.idx, rec.match ? 0 : 1);
      if (!moved) replan = true;
      if (prevWorker !== ev.agent.worker || prevState !== ev.agent.state) this.syncLink(rec);
      switch (ev.type) {
        case 'agent_woke': {
          if (!this.fxAllowed(rec.x, rec.z)) break;
          // Aim at the agent's running pose (and, in worker view, its new
          // cell on the worker): it lifts while the arc flies.
          const pose = this.shape.pose.running;
          const dest = this.moves.get(key);
          const x = dest ? dest.tx : rec.x;
          const z = dest ? dest.tz : rec.z;
          const top = new THREE.Vector3(x, this.shape.top(pose.h, pose.tip) + 0.2, z);
          const from = this.router.wake(top, now);
          const arrive = () => {
            this.flash(rec.key);
            if (this.allShapes) this.effects.ripple(x, z, theme.states.running, 1.4);
          };
          if (this.router.arcStyle === 'comet') this.effects.comet(from, top, theme.effects.wake, arrive);
          else this.effects.arc(from, top, theme.effects.wake, arrive);
          this.pinLabel(key, CHANGE_LABEL_SECONDS);
          break;
        }
        case 'agent_suspended':
          if (!this.fxAllowed(rec.x, rec.z)) break;
          this.effects.ripple(rec.x, rec.z, theme.effects.suspend, 1.6);
          this.effects.ripple(rec.x, rec.z, theme.effects.suspend, 1.6, 0.35);
          this.pinLabel(key, CHANGE_LABEL_SECONDS);
          break;
        case 'agent_crashed':
          if (this.labelAllowed(rec)) this.pinLabel(key, CHANGE_LABEL_SECONDS * 2);
          if (this.fxAllowed(rec.x, rec.z)) this.effects.shock(rec.x, rec.z, theme.effects.crash);
          break;
        case 'task_updated':
          if (ev.new && this.fxAllowed(rec.x, rec.z)) this.effects.beam(rec.x, rec.z, theme.effects.beam);
          break;
        default:
          break;
      }
      // Every change flashes the agent (cheap: a float on its point).
      this.flash(key);
    }
    if (replan) this.replanSoon();
    if (workersChanged && !replan) this.rebuildWorkers();
    this.updateMarker();
  }

  /** Moves an agent to its new class and animates its pose. */
  restyle(rec) {
    const cls = stateClass(rec.agent.state);
    if (cls !== rec.cls) {
      this.points.setClass(rec.idx, CLASS_INDEX[cls]);
      if (rec.slot >= 0) {
        this.detach(rec);
        rec.cls = cls;
        this.attach(rec);
      } else rec.cls = cls;
    } else {
      this.writeColor(rec);
    }
    if (rec.slot >= 0) this.animatePose(rec, cls === 'suspended' ? 1.6 : 1.0);
    else {
      const pose = this.shape.pose[cls];
      rec.h = pose.h;
      rec.tip = pose.tip;
    }
  }

  /** Animates an agent from its current pose to its class's pose. */
  animatePose(rec, dur) {
    const to = this.shape.pose[rec.cls];
    this.anims.set(rec.key, { fromH: rec.h, fromTip: rec.tip, toH: to.h, toTip: to.tip, t0: this.time.value, dur });
  }

  flash(key) {
    const rec = this.recs.get(key);
    if (!rec) return;
    this.points.setFlash(rec.idx, this.time.value);
    if (rec.slot < 0) return;
    const layer = this.layers[rec.cls];
    layer.flash.array[rec.slot] = this.time.value;
    layer.markSlot(rec.slot);
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
  }

  applyFilter() {
    for (const rec of this.recs.values()) {
      const m = this.filter(rec.agent);
      if (m !== rec.match) {
        this.account(rec, -1);
        rec.match = m;
        this.account(rec, 1);
      }
      this.points.setDim(rec.idx, m ? 0 : 1);
      if (rec.slot >= 0) {
        const layer = this.layers[rec.cls];
        layer.dim.array[rec.slot] = m ? 0 : 1;
        layer.markSlot(rec.slot);
      }
    }
    this.labelsDirty = true;
  }

  // --------------------------------------------------------------- island

  buildIsland(clusterName) {
    this.island = buildGround(this.islandGroup, this.plan, theme, {
      cluster: clusterName,
      blending: this.blending,
      makeLabel: (cls) => {
        const div = document.createElement('div');
        div.className = cls;
        return new CSS2DObject(div);
      },
      makeText: textPlane,
      look: this.look,
    });
    this.workerRowZ = this.island.rowZ;
    const { width: islandW, depth: islandD } = this.island;
    const span = Math.max(islandW, islandD * 1.5);

    // Shadows cover the island (big islands: the part around the camera's
    // target, see frame()).
    this.setShadowSpan(Math.max(islandW, islandD) * 0.75 + 6, this.island.cx, this.island.cz);
    // From the front left, so shadows fall to the right where the camera sees them.
    this.sun.position.set(this.island.cx - 70, 80, this.island.cz + 35);

    // The backdrop, fog and camera range grow with the island.
    const k = Math.max(1, span / 500);
    this.sea.scale.set(k, k, 1);
    this.sea.material.uniforms.uFade.value = 0.018 / k;
    this.stars.scale.setScalar(Math.max(1, span / 400));
    this.scene.fog.density = theme.scene.fogDensity * this.fogScale();
    this.camera.far = Math.max(2000, span * 5);
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = Math.max(600, span * 2.2);

    this.buildRouter();
  }

  setShadowSpan(span, x, z) {
    const cam = this.sun.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.near = 1;
    cam.far = 400 + span;
    cam.updateProjectionMatrix();
    this.sun.target.position.set(x, 0, z);
    this.shadowSpan = span;
  }

  /** Every element with a district-style label: districts, pool frames, platform labels in use. */
  districtLabelEls() {
    const out = [];
    if (!this.plan) return out;
    for (const d of this.plan.districts.values()) if (d.label) out.push({ el: d.label, x0: d.x, x1: d.x + d.w, z: d.z + d.d / 2, ax: d.x + 0.4, az: d.z + (d.strip ?? 2) / 2, area: d.w * d.d });
    for (const f of [...(this.plan.frames || []), ...(this.plan.padFrames || [])]) if (f.label) out.push({ el: f.label, x0: f.x, x1: f.x + f.w, z: f.z + f.d / 2, ax: f.x + 0.5, az: f.z + (f.strip ?? 2) / 2, area: f.w * f.d * 4 });
    for (const l of this.platformLabels) {
      const d = l.visible && l.userData.d;
      if (d) out.push({ el: l.element, x0: d.x, x1: d.x + d.w, z: d.z, ax: d.x + 0.4, az: d.z + (d.strip ?? 2) / 2, area: 1 });
    }
    return out;
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
    const ds = this.districtLabelEls().sort((x, y) => y.area - x.area);
    // The selected agent's label wins over district labels.
    const placed = [];
    const sel = this.agentBoxes?.find((q) => q.selected);
    if (sel) placed.push(sel);
    const boxes = [];
    // Sizes are estimated from the text and positions projected from the
    // anchors, so the pass never reads layout (no forced reflows).
    for (const d of ds) {
      a.set(d.x0, 0, d.z).project(this.camera);
      b.set(d.x1, 0, d.z).project(this.camera);
      const px = (Math.abs(b.x - a.x) / 2) * W;
      // Fit the label inside its district's width: full, then without
      // chips, then name only.
      const est = labelSize(d.el);
      const mode = est.full <= px ? '' : est.compact <= px ? 'compact' : 'tiny';
      const cl = d.el.classList;
      cl.toggle('compact', mode !== '');
      cl.toggle('tiny', mode === 'tiny');
      const w = mode === '' ? est.full : mode === 'compact' ? est.compact : est.tiny;
      const h = mode === 'tiny' ? est.th : est.h;
      a.set(d.ax, 0.2, d.az).project(this.camera);
      const sx = (a.x * 0.5 + 0.5) * W;
      const sy = (-a.y * 0.5 + 0.5) * H;
      const box = { x0: sx - 4, x1: sx + w + 4, y0: sy - h / 2 - 2, y1: sy + h / 2 + 2 };
      const off = a.z > 1 || box.x1 < 0 || box.x0 > W || box.y1 < 0 || box.y0 > H;
      const hit = placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0);
      cl.toggle('crowded', hit);
      if (!hit && !off) {
        placed.push(box);
        boxes.push(box);
      }
    }
    this.districtBoxes = boxes;
  }

  /** A worker platform's label HTML: name, node, fill, and the atespaces it runs. */
  platformHTML(d) {
    const c = this.agg.get(d.name);
    const wk = this.model.workers.get(d.name);
    const cap = wk?.capacityActors;
    const agents = `${c.total} agent${c.total === 1 ? '' : 's'}`;
    const teams = [...c.teams.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3);
    const chips = teams.map(([name, n]) => `<span class="chip team" style="--c:${teamCSS(this.teams.get(name) ?? 0, theme)}">${esc(name)} ${n}</span>`);
    const state = wk?.state && wk.state !== 'ACTIVE' ? `<span class="badge">${esc(wk.state.toLowerCase())}</span>` : '';
    return `<div class="name">${esc(wk ? workerLabel(wk) : d.name)}${state}</div><div class="meta">${wk?.node ? `<span class="node">${esc(wk.node)}</span> · ` : ''}${cap ? `${c.total}/${cap} agents` : agents} ${chips.join('')}</div>`;
  }

  updateDistrictLabels() {
    if (!this.plan || !this.model) return;
    this.labelsDirty = false;
    const chip = (cls, n, text) => (n ? `<span class="chip ${cls}">${n} ${text}</span>` : '');
    for (const d of this.plan.districts.values()) {
      if (!d.label) continue;
      const c = this.agg.get(d.name);
      const agents = `${c.total} agent${c.total === 1 ? '' : 's'}`;
      let html;
      if (d.kind === 'worker') html = this.platformHTML(d);
      else if (d.kind === 'parked') {
        html = `<div class="name">Not on a worker</div><div class="meta">${agents} ${chip('suspended', c.suspended, 'suspended')}${chip('pending', c.pending, 'pending')}${chip('crashed', c.crashed, 'crashed')}${chip('transition', c.transition, 'changing')}</div>`;
      } else {
        html = `<div class="name">${esc(d.name)}</div><div class="meta">${agents} ${chip('running', c.running, 'running')}${chip('transition', c.transition, 'changing')}${chip('crashed', c.crashed, 'crashed')}</div>`;
      }
      setHTML(d.label, html);
      d.label.classList.toggle('dim', c.match === 0 && c.total > 0);
      d.label.classList.toggle('focused', d.kind === 'worker' && this.focus.worker === d.name);
    }
    // Node pools: name, workers, agents and what they run.
    for (const f of [...(this.plan.frames || []), ...(this.plan.padFrames || [])]) {
      if (!f.label) continue;
      const c = this.agg.sum(f.workers);
      const pads = this.group !== 'worker';
      const html = `<div class="name">${esc(f.name || 'pool')}</div><div class="meta">${f.workers.length} workers${pads ? '' : ` · ${c.total} agents ${chip('running', c.running, 'running')}${chip('crashed', c.crashed, 'crashed')}`}</div>`;
      setHTML(f.label, html);
    }
    for (const l of this.platformLabels) if (l.visible && l.userData.d) this.fillPlatformLabel(l, l.userData.d);
  }

  fillPlatformLabel(l, d) {
    setHTML(l.element, this.platformHTML(d));
    l.element.classList.toggle('focused', this.focus.worker === d.name);
  }

  /** Big worker views: lends the pooled labels to the platforms nearest the camera that are in view and readable. */
  layoutPlatformLabels() {
    const big = this.group === 'worker' && this.plan && [...this.plan.districts.values()].some((d) => d.kind === 'worker' && !d.label);
    if (!big) {
      for (const l of this.platformLabels) l.visible = false;
      return;
    }
    const cam = this.camera.position;
    const fr = this.frustum();
    const p = new THREE.Vector3();
    const cand = [];
    const maxD = depthForPixels(FAR_HI * 2.5, this.viewH(), this.camera.fov);
    for (const d of this.plan.districts.values()) {
      if (d.kind !== 'worker') continue;
      p.set(d.x + d.w / 2, 0, d.z + d.d / 2);
      const dist = cam.distanceTo(p);
      if (dist > maxD || !fr.containsPoint(p)) continue;
      cand.push({ d, dist });
    }
    cand.sort((a, b) => a.dist - b.dist);
    this.platformLabels.forEach((l, i) => {
      const c = cand[i];
      if (!c) {
        l.visible = false;
        l.userData.d = null;
        return;
      }
      l.visible = true;
      l.userData.d = c.d;
      l.position.set(c.d.x + 0.4, 0.2, c.d.z + (c.d.strip ?? 2) / 2);
      this.fillPlatformLabel(l, c.d);
    });
  }

  // ------------------------------------------------------------ far tiles

  /** Lays out the far tiles for the plan and writes their counts. */
  syncTiles() {
    this.tiles.sync(this.plan.tiles || [], (t) => (t.groups.length === 1 ? this.agg.get(t.groups[0]) : this.agg.sum(t.groups)));
    this.dirtyGroups.clear();
  }

  /** Rewrites the tiles whose districts changed. */
  flushTiles() {
    if (!this.dirtyGroups.size) return;
    const done = new Set();
    for (const g of this.dirtyGroups) {
      const i = this.tiles.tileOf(g);
      if (i === undefined || done.has(i)) continue;
      done.add(i);
      const t = this.tiles.tiles[i];
      this.tiles.write(i, t.groups.length === 1 ? this.agg.get(t.groups[0]) : this.agg.sum(t.groups));
    }
    this.dirtyGroups.clear();
  }

  // -------------------------------------------------------------- workers

  /** Places and styles every worker pad, then rebuilds the links. */
  rebuildWorkers() {
    if (!this.model || !this.plan) return;
    const items = [];
    if (this.group === 'worker') {
      // Each pad sits in its platform's label strip, at the right.
      for (const wk of this.model.workers.values()) {
        const d = this.plan.districts.get(wk.name);
        if (!d) continue;
        items.push({ worker: wk, x: d.x + d.w - 3.2 / 2 - 0.45, z: d.z + WORKER_STRIP / 2, usage: workerUsage(wk, this.hosted.get(wk.name) || 0) });
      }
    } else {
      // The pad area along the island's front edge (planned with the island).
      for (const it of this.plan.padArea?.items || []) {
        const wk = this.model.workers.get(it.name);
        if (wk) items.push({ worker: wk, x: it.x, z: it.z, usage: workerUsage(wk, this.hosted.get(wk.name) || 0) });
      }
    }
    this.pads.sync(items, theme, this.blending, { cardAbove: this.group === 'worker' });
    this.pads.setFocus(this.focus);
    this.dirtyPads.clear();
    this.relinkAll();
  }

  /** Rewrites the pads whose worker or hosted count changed. */
  flushPads() {
    if (!this.dirtyPads.size || !this.model) return;
    for (const name of this.dirtyPads) {
      const wk = this.model.workers.get(name);
      if (wk) this.pads.update(name, wk, workerUsage(wk, this.hosted.get(name) || 0));
    }
    this.dirtyPads.clear();
  }

  /** How busy an agent's link looks: 0 idle to 1 serving (more, faster dots). */
  linkRate(rec) {
    if (rec.cls !== 'running') return 0;
    if (this.serving(rec)) return 1;
    return this.fake.value > 0 ? ((rec.seed * 5.31) % 1) * 0.45 : 0.15;
  }

  /**
   * Whether an agent's link to its worker is drawn: for agents drawn as
   * shapes (the close-up budget), every agent of the worker in focus, and
   * the selected or hovered agent. 100,000 arcs would be noise.
   */
  wantsLink(rec) {
    const w = rec.agent.worker;
    if (!w || !this.pads.get(w)) return false;
    return rec.slot >= 0 || w === this.focus.worker || rec.key === this.selected || rec.key === this.hovered;
  }

  /** Adds, moves or drops an agent's link to its worker's pad. */
  syncLink(rec) {
    if (!rec) return;
    if (!this.wantsLink(rec)) {
      this.links.remove(rec.key);
      return;
    }
    const pad = this.pads.get(rec.agent.worker);
    const level = levelOf(this.focus, rec.agent.worker);
    this.links.set(rec.key, { x: rec.x, y: this.topOf(rec), z: rec.z }, pad.pos, level, this.linkRate(rec), (rec.seed * 3.7) % 1);
  }

  relinkAll() {
    this.links.clear();
    const keys = new Set(this.near);
    for (const k of this.byWorker.get(this.focus.worker) || []) keys.add(k);
    if (this.selected) keys.add(this.selected);
    if (this.hovered) keys.add(this.hovered);
    for (const k of keys) this.syncLink(this.recs.get(k));
    this.styleLinks();
  }

  /** Link colors and alpha: many arcs add up, so the bundle gets fainter as it grows. */
  styleLinks() {
    const n = Math.max(this.links.count, 1);
    const a = theme.links.alpha;
    this.links.setLook({
      color: theme.links.color,
      highlight: theme.links.highlight,
      flow: theme.links.flow,
      restAlpha: Math.min(a, Math.max(a * 0.35, a * Math.sqrt(30 / n))),
      focusAlpha: theme.links.focusAlpha,
      dotAlpha: Math.min(0.85, Math.max(0.35, Math.sqrt(60 / n))) * (theme.glow.additive ? 1 : 0.85),
      blending: this.blending,
    });
  }

  // ------------------------------------------------------- level of detail

  /**
   * Re-selects the agents drawn as full shapes: the nearest within the
   * budget and the shape distance, in the frustum. Runs a few times a
   * second while the camera moves; the diff attaches and detaches only the
   * agents that changed.
   */
  refreshNear(force = false) {
    if (this.allShapes || !this.plan) {
      this.closeR.target = 1e6;
      return;
    }
    const cam = this.camera.position;
    const tgt = this.controls.target;
    const L = this.lastNear;
    const t = this.time.value;
    const movedBy = Math.hypot(cam.x - L.x, cam.y - L.y, cam.z - L.z) + Math.hypot(tgt.x - L.tx, tgt.z - L.tz);
    if (!force && L.t >= 0 && (t - L.t < NEAR_EVERY || movedBy < 0.02 * Math.max(5, cam.distanceTo(tgt)))) return;
    L.t = t;
    L.x = cam.x;
    L.y = cam.y;
    L.z = cam.z;
    L.tx = tgt.x;
    L.tz = tgt.z;
    const maxR = depthForPixels(SHAPE_PX, this.viewH(), this.camera.fov);
    const fr = this.frustum();
    const planes = fr.planes.map((p) => ({ x: p.normal.x, y: p.normal.y, z: p.normal.z, c: p.constant }));
    const pts = this.points;
    // Only the districts the shape radius reaches (on the ground) can hold
    // candidates; when that is a small part of the cluster, test just them.
    const reach2 = maxR * maxR - cam.y * cam.y;
    let subset = null;
    if (reach2 > 0) {
      const reach = Math.sqrt(reach2) + 2;
      const near = [];
      let total = 0;
      for (const d of this.plan.districts.values()) {
        const dx = Math.max(d.x - cam.x, 0, cam.x - (d.x + d.w));
        const dz = Math.max(d.z - cam.z, 0, cam.z - (d.z + d.d));
        if (dx * dx + dz * dz <= reach * reach) {
          near.push(d.name);
          total += this.slots.get(d.name)?.size || 0;
        }
      }
      if (total < this.recs.size * 0.6) {
        subset = new Int32Array(total);
        let k = 0;
        for (const name of near) {
          for (const key of this.slots.get(name).byKey.keys()) {
            const rec = this.recs.get(key);
            if (rec && k < total) subset[k++] = rec.idx;
          }
        }
        subset = subset.subarray(0, k);
      }
    } else {
      this.closeR.target = 0;
      for (const k of [...this.near]) {
        const rec = this.recs.get(k);
        if (rec) {
          this.detach(rec);
          this.syncLink(rec);
        }
      }
      return;
    }
    const { idx, radius } = selectNearest(pts.attrs.position.array, pts.live, pts.hwm, cam, this.budget, maxR, planes, 3, subset);
    const want = new Set();
    for (const i of idx) {
      const k = this.keyOfIdx[i];
      if (k) want.add(k);
    }
    // Keep the selected and hovered agents as shapes when they are close.
    for (const k of [this.selected, this.hovered]) if (k && this.near.has(k) && want.size < this.budget + 2) want.add(k);
    const changed = [];
    for (const k of [...this.near]) {
      if (want.has(k)) continue;
      const rec = this.recs.get(k);
      if (rec) {
        this.detach(rec);
        changed.push(rec);
      }
    }
    for (const k of want) {
      if (this.near.has(k)) continue;
      const rec = this.recs.get(k);
      if (!rec) continue;
      const pose = this.shape.pose[rec.cls];
      if (!this.anims.has(k)) {
        rec.h = pose.h;
        rec.tip = pose.tip;
      }
      this.attach(rec);
      changed.push(rec);
    }
    this.closeR.target = idx.length ? radius : 0;
    for (const rec of changed) this.syncLink(rec);
    if (changed.length) this.styleLinks();
  }

  /** Per-frame level-of-detail uniforms (the close-up radius eases to its target). */
  updateLod(dt) {
    const r = this.closeR;
    if (this.allShapes) r.value = r.target = 1e6;
    else if (r.value > 1e5) r.value = r.target;
    else r.value += (r.target - r.value) * (1 - Math.exp(-dt * 6));
    this.look.uCloseFar.value = r.value;
    this.look.uCloseNear.value = r.value * 0.85;
    // What the overlay reports: the level under the view's center.
    const d = this.camera.position.distanceTo(this.controls.target);
    this.lod = lodLevel(cellPixels(d, this.viewH(), this.camera.fov), this.allShapes ? 1 : this.near.size && r.value > 1 ? this.near.size : 0);
    // Tiles only draw when some district can be far.
    if (this.island) {
      const far = d + Math.max(this.island.width, this.island.depth);
      this.tiles.mesh.visible = farMix(cellPixels(far, this.viewH(), this.camera.fov)) > 0;
    }
  }

  // ------------------------------------------------------------ highlight

  /** Writes an agent's shape highlight level (its worker may have changed). */
  writeHi(rec) {
    if (rec.slot < 0) return;
    const layer = this.layers[rec.cls];
    layer.hi.array[rec.slot] = levelOf(this.focus, rec.agent.worker);
    layer.markSlot(rec.slot);
  }

  /** Recomputes the worker in focus; repaints agents, links and pads when it changed. */
  refreshFocus() {
    const f = focusOf(this.hl, (key) => this.recs.get(key)?.agent.worker);
    if (sameFocus(f, this.focus)) return;
    const before = this.focus.worker;
    this.focus = f;
    // Points test the focus in the shader; shapes carry a level each.
    this.points.setFocus(f.worker ? this.workerIndex(f.worker) : -1, f.strong);
    for (const key of this.near) this.writeHi(this.recs.get(key));
    // Links: the old and new focused workers' agents come and go; every
    // drawn link takes its new level.
    for (const w of new Set([before, f.worker])) for (const k of this.byWorker.get(w) || []) this.syncLink(this.recs.get(k));
    for (const k of this.links.keys) this.links.setLevel(k, levelOf(f, this.recs.get(k)?.agent.worker));
    this.styleLinks();
    this.pads.setFocus(f);
    this.labelsDirty = true;
    this.lastLabelUpdate = -1;
    this.handlers.onFocus?.(f);
  }

  /** Pins a worker (clicked pad, or "show worker"); null unpins. */
  pinWorker(name) {
    this.hl.pinnedWorker = name || null;
    this.refreshFocus();
  }

  get pinnedWorker() {
    return this.hl.pinnedWorker;
  }

  /** Smoothly moves the camera to look at a worker's pad (or platform). */
  flyToWorker(name) {
    const pad = this.pads.get(name);
    if (!pad) return;
    const d = this.group === 'worker' && this.plan.districts.get(name);
    const target = d ? new THREE.Vector3(d.x + d.w / 2, 0.5, d.z + d.d / 2) : pad.pos.clone();
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = Math.max(Math.min(this.camera.position.distanceTo(this.controls.target), 60), 40);
    this.flyAnim = { t0: this.time.value, dur: 0.9, fromT: this.controls.target.clone(), toT: target, fromC: this.camera.position.clone(), toC: target.clone().add(dir.multiplyScalar(dist)) };
  }

  // -------------------------------------------------------------- grouping

  /** Switches between atespace and worker districts; agents glide to their new cells. */
  setGroup(mode) {
    mode = groupId(mode);
    if (mode === this.group) return;
    this.group = mode;
    if (!this.model) return;
    this.replan(false, true);
    if (this.selected && this.recs.has(this.selected)) this.flyTo(this.selected);
    else this.fitCamera(true);
  }

  // --------------------------------------------------------------- camera

  /** Pixels on the left covered by the events panel (the fit keeps clear of them). */
  setLeftInset(px) {
    this.leftInset = px;
  }

  /** Frames the whole island; smooth: fly there instead of jumping. */
  fitCamera(smooth = false) {
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
    const toT = new THREE.Vector3(cx, 0, cz);
    const toC = new THREE.Vector3(cx + dist * 0.1, dist * 0.56, cz + dist * 0.84);
    if (smooth) {
      this.flyAnim = { t0: this.time.value, dur: 0.9, fromT: this.controls.target.clone(), toT, fromC: this.camera.position.clone(), toC };
      return;
    }
    this.flyAnim = null;
    this.controls.target.copy(toT);
    this.camera.position.copy(toC);
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
    // Where the agent is going, if it is moving between layouts.
    const mv = this.moves.get(key);
    const target = new THREE.Vector3(mv ? mv.tx : rec.x, 0.8, mv ? mv.tz : rec.z).add(right);
    const camTo = target.clone().add(dir.multiplyScalar(dist));
    this.flyAnim = { t0: this.time.value, dur: 0.9, fromT: this.controls.target.clone(), toT: target, fromC: this.camera.position.clone(), toC: camTo };
  }

  select(key) {
    const before = this.selected;
    this.selected = key;
    this.hl.selectedAgent = key;
    this.lastLabelUpdate = -1;
    for (const k of [before, key]) if (k) this.syncLink(this.recs.get(k));
    this.updateMarker();
    this.refreshFocus();
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

  /** Lets a benchmark drive the camera (fn(frame) each frame), or gives it back (null). */
  setCameraDriver(fn) {
    this.cameraDriver = fn;
    this.flyAnim = null;
    this.controls.enabled = !fn;
    if (!fn) this.controls.update();
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
      const worker = key ? null : this.pickWorker(e.clientX, e.clientY);
      this.handlers.onPick?.(key, worker);
    });
    el.addEventListener('pointermove', (e) => {
      if (down) return;
      this.hoverAt = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerleave', () => {
      this.hoverAt = null;
      this.setHover(null);
      this.setHoverWorker(null);
    });
  }

  /** The ray under a client position. */
  rayAt(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.ray;
  }

  /** The agent under a client position: the ray walks the agent grid (lod.js pickRay), no per-instance raycasting. */
  pick(clientX, clientY) {
    if (!this.plan) return null;
    const ray = this.rayAt(clientX, clientY);
    return pickRay(ray.origin, ray.direction, {
      lookup: (x, z) => {
        const d = this.distIndex.at(x, z);
        if (!d) return null;
        const s = slotAt(d, x, z);
        return s < 0 ? null : this.slots.get(d.name)?.keyAt(s) || null;
      },
      body: (key) => {
        const rec = this.recs.get(key);
        if (!rec) return null;
        return { x: rec.x, z: rec.z, y0: 0.1, y1: Math.max(0.5, this.topOf(rec)), r: 0.62 };
      },
    });
  }

  /** The worker pad under the pointer, by worker name. */
  pickWorker(clientX, clientY) {
    const ray = this.rayAt(clientX, clientY);
    if (ray.direction.y > -1e-4) return null;
    const t = (PAD_H - ray.origin.y) / ray.direction.y;
    if (t <= 0) return null;
    return this.pads.at(ray.origin.x + ray.direction.x * t, ray.origin.z + ray.direction.z * t);
  }

  setHover(key, x, y) {
    if (key !== this.hovered) {
      const before = this.hovered;
      this.hovered = key;
      const rec = key && this.recs.get(key);
      this.hoverRing.visible = !!rec;
      if (rec) this.hoverRing.position.set(rec.x, 0.15, rec.z);
      this.hl.hoverAgent = key || null;
      for (const k of [before, key]) if (k) this.syncLink(this.recs.get(k));
      this.refreshFocus();
    }
    this.handlers.onHover?.(key, x, y);
  }

  setHoverWorker(name) {
    if (name === this.hl.hoverWorker) return;
    this.hl.hoverWorker = name || null;
    this.refreshFocus();
    this.handlers.onHoverWorker?.(name);
  }

  // ---------------------------------------------------------------- frame

  /**
   * Adapts to the frame rate in 'auto' quality: while frames are slow
   * (over 26 ms), lower the pixel ratio to 1, then turn bloom off, then
   * halve the shape budget (to 1,200); with headroom (under 12 ms for five
   * seconds), step back up in reverse.
   */
  adaptQuality(t) {
    const q = this.quality;
    if (q.mode !== 'auto' || t - q.lastCheck < 1) return;
    q.lastCheck = t;
    const f = this.frameStats.summary();
    if (this.frameStats.count < 30) return;
    if (f.avgMs > 26) {
      q.fast = 0;
      if (++q.slow < 2) return;
      q.slow = 0;
      if (q.dpr > 1) q.dpr = Math.max(1, q.dpr - 0.25);
      else if (q.bloom) q.bloom = false;
      else if (!this.allShapes && this.budget > 1200) this.budget = Math.max(1200, Math.floor(this.budget / 2));
      else return;
    } else if (f.avgMs < 12) {
      q.slow = 0;
      if (++q.fast < 5) return;
      q.fast = 0;
      if (this.budget < this.baseBudget) this.budget = Math.min(this.baseBudget, this.budget * 2);
      else if (!q.bloom) q.bloom = true;
      else if (q.dpr < q.maxDpr) q.dpr = Math.min(q.maxDpr, q.dpr + 0.25);
      else return;
    } else {
      q.slow = q.fast = 0;
      return;
    }
    this.renderer.setPixelRatio(q.dpr);
    this.resize();
    this.applyBloom();
    this.refreshNear(true);
    this.frameStats.count = 0;
  }

  frame() {
    const start = performance.now();
    this.renderer.info.reset();
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 1.0) / this.slowmo;
    this.time.value += dt;
    const t = this.time.value;
    this.fxTokens = Math.min(FX_RATE * 2, this.fxTokens + dt * FX_RATE);

    if (this.replanAt >= 0 && t >= this.replanAt && this.model) this.replan(false, this.group === 'worker');

    // Layout moves (a grouping change, or an agent changing worker).
    for (const [key, mv] of this.moves) {
      const rec = this.recs.get(key);
      if (!rec) {
        this.moves.delete(key);
        continue;
      }
      const k = Math.min(Math.max((t - mv.t0) / mv.dur, 0), 1);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      rec.x = mv.fx + (mv.tx - mv.fx) * e;
      rec.z = mv.fz + (mv.tz - mv.fz) * e;
      this.points.setPos(rec.idx, rec.x, 0, rec.z);
      if (!this.anims.has(key)) this.writeMatrix(rec);
      if (rec.agent.worker) this.links.setFrom(key, rec.x, this.topOf(rec), rec.z);
      if (key === this.selected) this.updateMarker();
      if (key === this.hovered) this.hoverRing.position.set(rec.x, 0.15, rec.z);
      if (k >= 1) this.moves.delete(key);
    }

    // Pose animations (shapes only).
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
      if (rec.agent.worker && rec.slot >= 0) this.links.setFrom(key, rec.x, this.topOf(rec), rec.z);
      if (key === this.selected) this.updateMarker();
      if (k >= 1) this.anims.delete(key);
    }

    // Atespace tiles fade in with the worker view; links fade with a focus.
    const ease = 1 - Math.exp(-dt * 8);
    const team = this.group === 'worker' ? theme.team.alpha : 0;
    this.look.uTeam.value += (team - this.look.uTeam.value) * ease;
    if (Math.abs(team - this.look.uTeam.value) < 0.002) this.look.uTeam.value = team;
    const fu = this.links.uniforms.uFocus;
    fu.value += ((this.focus.worker ? 1 : 0) - fu.value) * ease;

    // Camera: the benchmark's path, a fly-to, or the user.
    if (this.cameraDriver) {
      this.cameraDriver({ cpu: this.lastCpu, calls: this.lastInfo.calls, tris: this.lastInfo.triangles });
    } else {
      if (this.flyAnim) {
        const f = this.flyAnim;
        const k = Math.min((t - f.t0) / f.dur, 1);
        const e = 1 - Math.pow(1 - k, 3);
        this.controls.target.lerpVectors(f.fromT, f.toT, e);
        this.camera.position.lerpVectors(f.fromC, f.toC, e);
        if (k >= 1) this.flyAnim = null;
      }
      this.controls.update();
    }
    this.camera.updateMatrixWorld();

    // Level of detail: which agents are shapes, and the crossfade radius.
    this.refreshNear();
    this.updateLod(dt);
    // Big islands: shadows cover the part around the camera's target.
    if (this.island && Math.max(this.island.width, this.island.depth) > 200) {
      const d = this.camera.position.distanceTo(this.controls.target);
      const span = Math.min(Math.max(this.island.width, this.island.depth) * 0.75 + 6, Math.max(30, d * 0.9));
      const tg = this.controls.target;
      if (Math.abs(span - this.shadowSpan) > span * 0.1 || this.sun.target.position.distanceTo(tg) > span * 0.2) {
        this.setShadowSpan(span, tg.x, tg.z);
        this.sun.position.set(tg.x - 70, 80, tg.z + 35);
      }
    }

    this.agents.flush();
    this.points.flush();
    this.links.flush();

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
      this.setHoverWorker(key ? null : this.pickWorker(this.hoverAt.x, this.hoverAt.y));
    }

    if (t - this.lastLabelUpdate > LABEL_EVERY || this.lastLabelUpdate < 0) {
      this.lastLabelUpdate = t;
      this.flushTiles();
      this.flushPads();
      if (this.labelsDirty) this.updateDistrictLabels();
      this.updateAgentLabels();
      this.layoutPlatformLabels();
      this.layoutDistrictLabels();
      this.layoutWorkerLabels();
      this.keepRouterLabelClear();
    }
    this.tiles.flush();
    this.pads.flush();

    this.composer.render();
    this.labelRenderer.render(this.scene, this.camera);
    const info = this.renderer.info.render;
    this.lastInfo = { calls: info.calls, triangles: info.triangles, points: info.points, lines: info.lines };
    this.lastCpu = performance.now() - start;
    this.frameStats.push(start, this.lastCpu);
    this.adaptQuality(t);
  }

  /** Renderer and layer numbers for the perf overlay. */
  stats() {
    const mem = this.renderer.info.memory;
    const layers = { points: this.allShapes ? 0 : this.points.count, shapes: 0 };
    for (const cls of CLASSES) {
      const n = this.layers[cls].keys.length;
      layers.shapes += n;
      if (n) layers[`  ${cls}`] = n;
    }
    layers.tiles = this.tiles.mesh.visible ? this.tiles.count : 0;
    layers.links = this.links.count;
    Object.assign(layers, this.pads.stats());
    layers.effects = this.effects.items.length;
    layers.labels = this.agentLabels.filter((l) => l.visible).length + this.platformLabels.filter((l) => l.visible).length;
    const q = this.quality;
    return {
      ...this.lastInfo,
      geometries: mem.geometries,
      textures: mem.textures,
      heapMB: performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : 0,
      lod: `${this.lod}${this.allShapes ? ' (all shapes)' : ` (budget ${this.budget}, r ${Math.min(this.closeR.value, 9999).toFixed(0)})`}`,
      quality: `${q.mode} · dpr ${q.dpr.toFixed(2)}${this.bloom.enabled ? '' : ' · no bloom'}`,
      layers,
    };
  }

  /**
   * Worker pad labels are quiet like agent labels: shown for the worker in
   * focus (a card when it is hovered or pinned), pads that aren't plainly
   * active (for example draining), and every pad when the camera is close to
   * it or labels are 'all'. In worker view the platforms carry the names, so
   * only the focused pad's card shows. They are placed greedily in screen
   * space after the district and agent labels and never overlap them or
   * each other (a card always shows). Labels come from the pads' pool.
   */
  layoutWorkerLabels() {
    if (!this.pads.count) return;
    const W = this.renderer.domElement.clientWidth;
    const H = this.renderer.domElement.clientHeight;
    const cam = this.camera.position;
    const mode = this.labelMode;
    const byWorker = this.group === 'worker';
    // Obstacles: the agent and district labels just placed (their boxes,
    // not layout reads).
    const placed = [...(this.agentBoxes || []), ...(this.districtBoxes || [])];
    const items = [];
    const wp = new THREE.Vector3();
    const fr = this.frustum();
    for (const [name, p] of this.pads.pads) {
      wp.set(p.x, 0.2, p.z + 2.6);
      const focused = name === this.focus.worker;
      const card = focused && this.focus.strong;
      const notable = !!p.worker.state && p.worker.state !== 'ACTIVE';
      const prio = card ? 0 : focused ? 1 : notable ? 2 : 3;
      const d = cam.distanceTo(wp);
      const near = d < WORKER_LABEL_DISTANCE;
      const want = card || (!byWorker && mode !== 'off' && (prio < 3 || near || mode === 'all'));
      if (want && (card || fr.containsPoint(wp))) items.push({ p, prio, d, at: wp.clone() });
    }
    items.sort((a, b) => a.prio - b.prio || a.d - b.d);
    const show = [];
    for (const { p, prio, at } of items) {
      if (show.length >= this.pads.labelPool.length) break;
      at.project(this.camera);
      if (at.z > 1) continue;
      if (prio === 0) {
        show.push({ name: p.name, card: true });
        continue;
      }
      const x = (at.x * 0.5 + 0.5) * W;
      const y = (-at.y * 0.5 + 0.5) * H;
      // Estimated from the text: the element isn't laid out while hidden.
      const chars = Math.max(10, (p.worker.pod || p.worker.name).length + 2);
      const half = chars * 3.2 + 6;
      const box = { x0: x - half, x1: x + half, y0: y - 15, y1: y + 15 };
      if (placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
      placed.push(box);
      show.push({ name: p.name, card: false });
    }
    this.pads.showLabels(show);
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
   * Only agents drawn as shapes (plus pinned and selected ones) are
   * candidates, so the pass costs the close-up budget, not the cluster.
   * Far away (districts as tiles) only the selected agent keeps its label.
   */
  updateAgentLabels() {
    const cam = this.camera.position;
    const t = this.time.value;
    const mode = this.labelMode;
    const frustum = this.frustum();
    const near = [];
    const p = new THREE.Vector3();
    const closeUp = cam.distanceTo(this.controls.target) < CLOSE_UP_DISTANCE;
    const maxDist = mode === 'all' ? 60 : closeUp ? 34 : 0;
    const farView = this.lod === 'far';
    const cands = new Set();
    if (this.selected) cands.add(this.selected);
    if (mode !== 'off' && !farView) {
      for (const k of this.labelPinned.keys()) cands.add(k);
      if (maxDist > 0) for (const k of this.allShapes ? this.recs.keys() : this.near) cands.add(k);
    }
    for (const key of cands) {
      const rec = this.recs.get(key);
      if (!rec) continue;
      p.set(rec.x, this.topOf(rec), rec.z);
      const selected = rec.key === this.selected;
      const until = this.labelPinned.get(rec.key) || 0;
      const pinned = until > t;
      const d = cam.distanceTo(p);
      let prio;
      if (selected) prio = -1e9;
      else if (mode === 'off') continue;
      else if (pinned && rec.match) prio = -until; // newest change first
      else if (d <= maxDist && rec.match) prio = d;
      else continue;
      if (!frustum.containsPoint(p)) continue;
      near.push({ rec, d: prio, pinned: pinned && !selected && prio < 0, fade: pinned && !selected && until - t < 1.5 });
    }
    near.sort((a, b) => a.d - b.d);
    // Big clusters change hundreds of agents a second: show only the
    // newest few changes, so labels don't flicker everywhere.
    let pinnedShown = 0;
    const shown = this.allShapes ? near : near.filter((x) => !x.pinned || ++pinnedShown <= MAX_PINNED);
    // Greedy screen-space placement: skip a label that would overlap one
    // already placed, so a dense district doesn't turn into a smear.
    const W = this.renderer.domElement.clientWidth;
    const H = this.renderer.domElement.clientHeight;
    // District labels are obstacles: a passing agent label never covers one.
    const placed = [...(this.districtBoxes || [])];
    const agentBoxes = [];
    const chosen = [];
    for (const item of shown) {
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
      agentBoxes.push({ ...box, selected: item.d <= -1e9 });
      chosen.push(item);
    }
    this.agentBoxes = agentBoxes;
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
