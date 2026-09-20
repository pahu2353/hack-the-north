// Real-3D first-person view. Same contract as pov.js (draw / toWorld / setPointer / reset), so
// main.js can swap between them and everything else — voice, pointing, agent switching, the
// minimap — is unaffected.
//
// The simulation stays the single source of truth: this module never moves a unit, never decides
// a hit, and never invents state. It reads a teamView snapshot and draws it. Walls are the same
// map.walls rectangles the minimap draws, extruded to WALL_H, so what you see and what the sim
// thinks is solid can never drift apart.
//
// Aiming follows the camera in both axes. The sim gives a manual crosshair a real vertical
// extent — it accepts a hit when eye + tan(pitch) * distance falls inside the target's height —
// so pitch decides whether a shot counts, and the view has to show it or the player would be
// aiming on an axis they cannot see.
//
// No external art: players, weapons and the map are built from primitives at runtime, the
// approach open-source browser shooters like claude-of-duty use to stay asset-free.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { MAPS } from './world.js';

const FOV_H = (90 * Math.PI) / 180; // horizontal, matching the raycaster view
const WALL_H = 3;
const EYE = 1.6;
const FAR = 70;
const LINGER = 0.4; // seconds an enemy stays drawn after slipping out of sight
// Overlay heights, in metres up the figure: the head sits at 1.62, so a name at shoulder height
// lands on the body and a bar at 1.95 clears it.
const NAME_H = 1.45;
const BAR_H = 1.95;
// Ambient occlusion works from a depth/normal prepass of the whole scene, and it cannot tell a
// transparent quad from a wall: a muzzle flash or a blast sprite writes depth, AO decides the
// pixels behind it are fully occluded, and the result is a hard black rectangle floating in the
// world. Everything that is glow, smoke or a decal goes on this layer, and the layer is hidden
// from the camera for the duration of the AO pass only.
const FX_LAYER = 2;
const markFx = obj => {
  obj.traverse(o => o.layers.set(FX_LAYER));
  return obj;
};

// Flips a camera layer on or off at a point in the composer chain.
class LayerToggle extends Pass {
  constructor(camera, layer, on) {
    super();
    this.camera = camera;
    this.layer = layer;
    this.on = on;
    this.needsSwap = false;
  }
  render() {
    if (this.on) this.camera.layers.enable(this.layer);
    else this.camera.layers.disable(this.layer);
  }
}

// Desert-map palette: hot pale sky, dusty warm haze at the horizon. Source's env_fog_controller
// tints distance toward the sky colour, which is what keeps long sightlines readable.
const SKY = 0x8fb4d8;
const FOG = 0xcfc3a6;
const OWN = 0x4aa3ff;
const ENEMY = 0xff4d5a;
const POINTER = 0xffd24a;

// World (x, y) is the sim's ground plane; three.js is y-up, so sim y becomes three z.
// A model built facing -z lines up with the sim's atan2(dy, dx) heading at this yaw.
const yawOf = facing => -facing - Math.PI / 2;
const hex = c => (typeof c === 'string' ? new THREE.Color(c) : new THREE.Color(c));

// onLost is called if the GPU takes the WebGL context away, which browsers do on their own
// account: a driver reset, a long spell in a background tab, or too much pressure from other
// pages. Nothing throws when it happens — the canvas simply keeps showing its last frame — so
// without this the view looks frozen while the clock, the HUD and the squad carry on.
export function createPov3dRenderer(canvas, hudCanvas, { onLost } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  let contextLost = false;
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault(); // without this the context can never come back at all
    contextLost = true;
    onLost?.();
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // The shadow pass is a second render of every caster. Nothing in this game casts a shadow
  // that changes meaningfully within a sixtieth of a second — the map is static and the agents
  // walk — so it is refreshed on alternate frames and costs half as much.
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;
  // Filmic tone mapping is the single cheapest thing that stops untextured geometry reading as
  // programmer art: it rolls off highlights instead of clipping flat colours to white.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const hud = hudCanvas.getContext('2d');

  const scene = new THREE.Scene();
  // Haze should sit on the far end of a long sightline, not on the man in front of you.
  scene.fog = new THREE.Fog(FOG, 45, 165);
  buildSky(scene);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 240);
  camera.rotation.order = 'YXZ';
  camera.layers.enable(FX_LAYER);

  // The weapon lives in its own scene drawn over the world, so it can never clip into a wall.
  const vmScene = new THREE.Scene();
  // Shooters render the weapon at a narrower FOV than the world, so a wide world FOV doesn't
  // smear the gun across the screen. Same trick here.
  const vmCamera = new THREE.PerspectiveCamera(42, 1, 0.01, 12);

  let W = 0;
  let H = 0;
  // The level is rebuilt from scratch when the snapshot names a different map, so switching
  // maps costs one teardown rather than a second renderer.
  let map = null;
  let level = null;
  let floor = null;
  let walls = [];
  let pickable = [];

  // Source bakes ambient occlusion and bounce into lightmaps; that contact darkening in corners
  // and under ledges is most of why its maps read as solid. We can't bake — the geometry is
  // generated from map.walls at load — so it is computed per frame instead, plus HDR bloom for
  // the blown-out sun the engine is known for. Both are switched off if the frame budget slips.
  let composer = null;
  let ao = null;
  let bloom = null;
  // What this view costs is almost entirely pixels: the post chain, and AO above all, is paid
  // per pixel per frame. So quality is a ladder rather than a switch, and the frame time walks
  // up and down it. Dropping AO first keeps most of the look for most of the saving; resolution
  // is the last thing to go because it is the most visible. It climbs back when the frames
  // allow, so a single explosion no longer costs the rest of the match its lighting.
  const LEVELS = [
    { ao: false, bloom: false, scale: 0.7 },
    { ao: false, bloom: false, scale: 1 },
    { ao: false, bloom: true, scale: 1 },
    { ao: true, bloom: true, scale: 1 },
  ];
  // A Retina display reports 2, which is four times the pixels for very little gain at this
  // art style, and it is where a laptop GPU runs out of room first.
  const MAX_PIXEL_RATIO = 1.5;
  const SLOW_FRAME = 1 / 45; // below this the view is visibly not keeping up
  // Headroom has to be judged against what the display will actually allow: a screen locked to
  // 60Hz never delivers a frame faster than ~16.7ms, so asking for 70fps would mean the view
  // could never climb back on the most ordinary hardware there is. The gap between the two
  // thresholds is the hysteresis that stops a level flipping back and forth.
  const FAST_FRAME = 1 / 55;
  const RECOVERY_FRAMES = 300; // sustained headroom before trying a level up
  const MAX_RECOVERY_FRAMES = 3600;
  let qualityLevel = LEVELS.length - 1;
  let appliedRatio = null;
  let fastFrames = 0;
  // Backing off is for a climb that proved wrong, not for every drop. If the view has been
  // holding a level for a while and then falls behind, something changed — a fight, another
  // tab taking the GPU — and it should recover as soon as that passes. If instead it drops
  // shortly after climbing, that level is one this machine cannot hold, and the next attempt
  // waits twice as long. Without the distinction, one bad stretch costs the rest of the match.
  let recoveryFrames = RECOVERY_FRAMES;
  let framesSinceClimb = Infinity;
  const renderRatio = () => Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1) * LEVELS[qualityLevel].scale;
  const usingPost = () => LEVELS[qualityLevel].ao || LEVELS[qualityLevel].bloom;
  function applyLevel() {
    if (ao) ao.enabled = LEVELS[qualityLevel].ao;
    if (bloom) bloom.enabled = LEVELS[qualityLevel].bloom;
    appliedRatio = null; // makes fit() resize the buffers to the new scale
  }
  let slowFrames = 0;
  let shadowTick = false;

  function buildComposer() {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    ao = new GTAOPass(scene, camera, W, H);
    ao.output = GTAOPass.OUTPUT.Default;
    ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
    // AO must not see the effect layer, or every sprite punches a black hole in the world.
    composer.addPass(new LayerToggle(camera, FX_LAYER, false));
    composer.addPass(ao);
    composer.addPass(new LayerToggle(camera, FX_LAYER, true));
    // The weapon has to join the chain rather than be drawn over it afterwards: the composer
    // owns the framebuffer once it is running, so anything rendered after composer.render()
    // never reaches the screen. Clearing depth on this pass keeps the gun in front of the
    // world, and sitting after AO but before bloom means it picks up the muzzle glow without
    // getting occlusion artifacts along its own edges.
    const vmPass = new RenderPass(vmScene, vmCamera);
    vmPass.clear = false;
    vmPass.clearDepth = true;
    composer.addPass(vmPass);
    // Threshold is in linear HDR, before tone mapping, so it sits well above 1 or the sky
    // alone saturates the bloom buffer.
    bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.28, 0.7, 0.9);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    applyLevel(); // the chain may be built after the view has already stepped down
  }

  const sun = buildLights(scene, vmScene);

  function useMap(next) {
    if (level) {
      scene.remove(level);
      level.traverse(o => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        for (const m of [].concat(o.material)) m.dispose();
      });
    }
    map = next;
    level = new THREE.Group();
    walls = buildWalls(level, map);
    floor = buildFloor(level, map);
    pickable = [floor, ...walls];
    scene.add(level);
    aimSun(sun, map);
  }
  useMap(MAPS.tactical);

  const figures = new Map(); // unit id → { group, parts, lastPos, phase }
  const smokes = new Map(); // smoke id → { group, puffs, t }
  const corpses = new Map();
  const tracers = [];
  const nades = new Map();
  const blasts = [];
  // three.js compiles a shader variant per light count, so adding a light to the scene and
  // taking it away again makes it recompile every material that light could touch. A grenade
  // round does that around ninety times, which is felt as a stutter on every explosion. The
  // lights are therefore made once and never added or removed: a blast borrows one, drives its
  // intensity, and hands it back dark. Three is enough for overlapping blasts; past that the
  // oldest is reused, which nobody can see under two simultaneous explosions.
  const blastLights = Array.from({ length: 3 }, () => {
    const light = new THREE.PointLight(0xffb066, 0, 30);
    light.layers.enableAll(); // a light only reaches objects sharing one of its layers
    scene.add(light);
    return light;
  });
  let nextBlastLight = 0;
  const spike = buildSpike(scene);
  const beacon = buildBeacon(scene);
  const weapon = buildWeapon(vmScene);
  const muzzle = buildMuzzle(scene, vmScene);

  const lastSeen = new Map();
  let watchedId = null;
  let lastViewTime = -Infinity;
  let pointer = null;
  let sway = { x: 0, y: 0, vx: 0, vy: 0, kick: 0, lastYaw: 0 };
  let bobPhase = 0;
  // teamView hands out a fresh copy of every effect each frame, so an effect cannot carry a
  // "already drawn" flag. Compare this frame's keys with last frame's to find the new ones.
  let prevEffects = new Set();
  let newEffects = new Set();

  function reset() {
    lastSeen.clear();
    watchedId = null;
    lastViewTime = -Infinity;
    pointer = null;
    for (const f of figures.values()) scene.remove(f.group);
    figures.clear();
    for (const cloud of smokes.values()) scene.remove(cloud.group);
    smokes.clear();
    for (const c of corpses.values()) scene.remove(c.f.group);
    corpses.clear();
    for (const t of tracers) scene.remove(t.group);
    tracers.length = 0;
    for (const n of nades.values()) scene.remove(n);
    nades.clear();
    for (const b of blasts) disposeBlast(b);
    blasts.length = 0;
    ownHp = undefined;
    ownHurt = 0;
  }

  function fit() {
    // The overlay is 2D text and lines, which cost almost nothing and look wrong when soft, so
    // it stays at display resolution whatever the 3D view is rendering at.
    const hudDpr = Math.min(2, window.devicePixelRatio || 1);
    const ratio = renderRatio();
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return false;
    if (width !== W || height !== H || ratio !== appliedRatio) {
      W = width;
      H = height;
      appliedRatio = ratio;
      renderer.setPixelRatio(ratio);
      renderer.setSize(W, H, false);
      hudCanvas.width = Math.round(W * hudDpr);
      hudCanvas.height = Math.round(H * hudDpr);
      // Hold the horizontal FOV fixed so a wider window shows more to the sides, not less height.
      const vfov = 2 * Math.atan(Math.tan(FOV_H / 2) / (W / H));
      camera.fov = (vfov * 180) / Math.PI;
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
      vmCamera.aspect = W / H;
      vmCamera.updateProjectionMatrix();
      // The composer caches the pixel ratio it was built with, so changing the renderer's
      // alone would resize nothing: the post chain would keep its original buffers and the
      // resolution step would do no work at all.
      composer?.setPixelRatio(ratio);
      composer?.setSize(W, H);
    }
    hud.setTransform(hudDpr, 0, 0, hudDpr, 0, 0);
    hud.clearRect(0, 0, W, H);
    return true;
  }

  // view: a teamView snapshot. unit: the agent being watched. cam: { x, y, angle } from
  // createCamera in pov.js. at: id → smoothed position, the same easing the map uses.
  function draw(view, unit, cam, at = u => u, dt = 1 / 60) {
    if (unit.id !== watchedId || view.time < lastViewTime) {
      lastSeen.clear();
      for (const f of figures.values()) f.group.visible = false;
      // Health belongs to the agent, not to the screen: stepping across to a more wounded
      // squadmate is not you being shot, and neither is the start of a new round.
      ownHp = undefined;
      ownHurt = 0;
    }
    watchedId = unit.id;
    lastViewTime = view.time;
    if (contextLost || !fit()) return;

    const wanted = MAPS[view.mapId] ?? map;
    if (wanted !== map) useMap(wanted);

    camera.position.set(cam.x, EYE, cam.y);
    // YXZ order, so this reads as yaw then pitch the way a first-person camera should.
    camera.rotation.set(cam.pitch ?? 0, yawOf(cam.angle), 0);

    markNewEffects(view);
    syncFigures(view, unit, at, dt, cam);
    syncCorpses(view, dt);
    syncTracers(view, dt);
    syncGrenades(view, dt);
    syncSmoke(view, dt);
    syncSpike(view, dt);
    syncBeacon();
    aimWeapon(view, unit, cam, dt);

    // Walk the quality ladder from the frame time. Dropping is quick, because a player feels a
    // slow frame immediately; climbing back is slow and needs sustained headroom, so the view
    // cannot oscillate between two levels every second.
    if (dt > SLOW_FRAME) slowFrames++;
    else slowFrames = Math.max(0, slowFrames - 1);
    fastFrames = dt < FAST_FRAME ? fastFrames + 1 : 0;
    framesSinceClimb++;
    if (slowFrames > 20 && qualityLevel > 0) {
      qualityLevel--;
      slowFrames = 0;
      fastFrames = 0;
      recoveryFrames = framesSinceClimb < RECOVERY_FRAMES * 2
        ? Math.min(MAX_RECOVERY_FRAMES, recoveryFrames * 2) // that climb was a mistake
        : RECOVERY_FRAMES; // it held for a while, so this is new, not flapping
      applyLevel();
      console.warn(`3D view: stepping down to quality level ${qualityLevel} to hold frame rate`);
    } else if (fastFrames > recoveryFrames && qualityLevel < LEVELS.length - 1) {
      qualityLevel++;
      fastFrames = 0;
      framesSinceClimb = 0;
      applyLevel();
    }
    renderer.shadowMap.needsUpdate = (shadowTick = !shadowTick);
    if (usingPost()) {
      if (!composer) buildComposer();
      composer.render(); // includes the weapon pass
    } else {
      renderer.clear();
      renderer.render(scene, camera);
      renderer.clearDepth(); // the weapon draws on top of the world
      renderer.render(vmScene, vmCamera);
    }

    drawHud(view, unit, dt);
  }

  // ---------- entities ----------

  // Only what this agent can see. The sim says which of your agents see each enemy; a short
  // grace period stops them blinking as they edge past a corner. Identical rule to pov.js.
  function enemyInView(view, unit, u) {
    if (u.seenBy?.includes(unit.id)) {
      lastSeen.set(u.id, view.time);
      return true;
    }
    const age = view.time - (lastSeen.get(u.id) ?? -Infinity);
    return age >= 0 && age < LINGER;
  }

  function syncFigures(view, watching, at, dt, cam) {
    const live = new Set();
    for (const u of view.units) {
      if (!u.alive || u.id === watching.id) continue;
      const own = u.team === view.team;
      if (!own && !enemyInView(view, watching, u)) continue;
      live.add(u.id);
      let f = figures.get(u.id);
      if (!f) {
        f = buildFigure(u.color ?? (own ? OWN : ENEMY), !own);
        scene.add(f.group);
        figures.set(u.id, f);
      }
      const p = at(u);
      f.group.visible = true;
      f.group.position.set(p.x, 0, p.y);
      f.group.rotation.y = yawOf(u.facing);
      // Enemies don't carry a `moving` flag, so read it off their travel instead.
      const moved = f.lastPos ? Math.hypot(p.x - f.lastPos.x, p.y - f.lastPos.y) : 0;
      f.lastPos = { x: p.x, y: p.y };
      const walking = u.moving ?? moved / Math.max(dt, 1e-3) > 0.6;
      // A walking agent is doing something deliberate — clearing an angle, holding fire —
      // and it has to read differently from a sprint or the pace channel is invisible.
      stepGait(f, walking, Boolean(u.firing), dt, u.pace === 'walk' ? 0.5 : 1);
      // A squadmate who walks into the camera fills the whole screen and blinds the view.
      // Shooters fade teammates out as they close on the lens; without it, standing in a
      // stack makes first person unusable. Fully gone under 0.9 m, clear again past 2.0 m.
      const near = Math.hypot(p.x - cam.x, p.y - cam.y);
      const alpha = clamp((near - 0.9) / 1.1, 0, 1);
      f.group.visible = alpha > 0.02;
      setFigureAlpha(f, alpha);

      // How hard they were hit decides how hard it reads: a graze is a tint, a near-fatal
      // hit is the whole body. It fades in about a third of a second either way.
      const hp = u.hp ?? 0;
      if (f.lastHp !== undefined && hp < f.lastHp) {
        f.hurt = Math.min(1, (f.hurt ?? 0) + 0.35 + (f.lastHp - hp) / 70);
      }
      f.lastHp = hp;
      f.hurt = Math.max(0, (f.hurt ?? 0) - dt * 2.8);
      setFigureHurt(f, f.hurt);

      f.parts.flash.visible = Boolean(u.firing);
      if (u.firing) {
        f.parts.flash.scale.setScalar(0.34 + Math.random() * 0.3);
        f.parts.flash.material.rotation = Math.random() * Math.PI * 2;
      }
    }
    for (const [id, f] of figures) if (!live.has(id)) f.group.visible = false;
  }

  // A body should arrive on the floor, not appear there. When a unit dies its own model is
  // handed over intact — right colours, right kit — and tipped over from the feet with the
  // limbs going slack, then left lying until the sim stops reporting the death.
  function syncCorpses(view, dt) {
    for (const e of view.effects) {
      if (e.kind !== 'death') continue;
      const key = effectKey(e);
      if (!newEffects.has(key) || corpses.has(key)) continue;
      // Prefer the actual figure that was standing there a moment ago.
      let taken = null;
      for (const [id, f] of figures) {
        if (!f.lastPos) continue;
        if (Math.hypot(f.lastPos.x - e.x, f.lastPos.y - e.y) < 1.6) {
          taken = f;
          figures.delete(id);
          break;
        }
      }
      const f = taken ?? buildFigure(e.color ?? (e.team === view.team ? OWN : ENEMY), false);
      // The figure was almost certainly flashing red the instant it died, since that is what
      // killed it. A body on the floor is not still being hit, so clear the tint with it.
      f.hurt = 0;
      setFigureHurt(f, 0);
      if (!taken) {
        f.group.position.set(e.x, 0, e.y);
        scene.add(f.group);
      }
      f.group.visible = true;
      corpses.set(key, { f, t: 0, roll: (Math.random() - 0.5) * 0.9, dir: Math.random() < 0.5 ? 1 : -1 });
    }
    const live = new Set(view.effects.filter(e => e.kind === 'death').map(effectKey));
    for (const [key, c] of corpses) {
      if (!live.has(key)) {
        scene.remove(c.f.group);
        corpses.delete(key);
        continue;
      }
      c.t += dt;
      const p = c.f.parts;
      // Fall: ~0.7s tipping from the feet, with a small settle at the end.
      const fall = Math.min(1, c.t / 0.7);
      const eased = 1 - (1 - fall) ** 3;
      const settle = c.t > 0.7 ? Math.sin((c.t - 0.7) * 16) * Math.exp(-(c.t - 0.7) * 7) * 0.05 : 0;
      c.f.group.rotation.x = c.dir * (eased * (Math.PI / 2 - 0.08) + settle);
      c.f.group.rotation.z = c.roll * eased;
      // Limbs go slack as it goes over.
      p.rig.rotation.x = 0.5 + eased * 0.9;
      p.rig.rotation.z = -0.4 * eased * c.dir;
      p.hipL.rotation.x = -0.35 * eased;
      p.hipR.rotation.x = 0.2 * eased;
      p.kneeL.rotation.x = -0.5 * eased;
      p.kneeR.rotation.x = -0.25 * eased;
      p.body.position.y = -0.04 * eased;
    }
  }

  const effectKey = e => (e.kind === 'tracer'
    ? `t:${e.x1.toFixed(2)},${e.y1.toFixed(2)},${e.x2.toFixed(2)},${e.y2.toFixed(2)}`
    : `${e.kind}:${e.x.toFixed(2)},${e.y.toFixed(2)}`);

  function markNewEffects(view) {
    const cur = new Set();
    newEffects = new Set();
    for (const e of view.effects) {
      const key = effectKey(e);
      cur.add(key);
      if (!prevEffects.has(key)) newEffects.add(key);
    }
    prevEffects = cur;
  }

  // Tracers are momentary, so they are spawned fresh and faded out rather than tracked by id.
  // A one-pixel line reads as a scratch on the screen; a thin lit cylinder with a hot core has
  // thickness and fades along its length, and the round ends on an impact spark.
  function syncTracers(view, dt) {
    for (const e of view.effects) {
      if (e.kind !== 'tracer' || !newEffects.has(effectKey(e))) continue;
      const a = new THREE.Vector3(e.x1, 1.32, e.y1);
      const b = new THREE.Vector3(e.x2, 1.28, e.y2);
      const len = a.distanceTo(b);
      const colour = hex(e.color ?? (e.team === view.team ? 0xbfe4ff : 0xffc9a8));
      const group = new THREE.Group();
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.028, len, 6, 1, true),
        new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      // Cylinders are built along Y, so aim it down the shot.
      shaft.position.copy(a).add(b).multiplyScalar(0.5);
      shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      const spark = sprite(SPRITES.glow, 0.5);
      spark.position.copy(b);
      group.add(shaft, spark);
      scene.add(markFx(group));
      tracers.push({ group, shaft, spark, ttl: 0.11 });
    }
    for (let i = tracers.length - 1; i >= 0; i--) {
      const t = tracers[i];
      t.ttl -= dt;
      const k = Math.max(0, t.ttl / 0.11);
      t.shaft.material.opacity = 0.85 * k;
      t.spark.material.opacity = k ** 2;
      t.spark.scale.setScalar(0.5 + (1 - k) * 0.7);
      if (t.ttl <= 0) {
        scene.remove(t.group);
        t.shaft.geometry.dispose();
        t.shaft.material.dispose();
        tracers.splice(i, 1);
      }
    }
  }

  // The pieces of one explosion. The update loop below drives them all; this only builds what
  // that loop expects to find, so the two have to stay in step: core, ring, light, puffs, sparks.
  function spawnBlast(x, y, r, slow = 1) {
    const group = new THREE.Group();
    group.position.set(x, 0, y);
    // Gone in a tenth of a second. It is the shortest-lived part and the one that sells the hit.
    const core = sprite(SPRITES.flash, 1);
    core.position.y = 0.9;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1, 48),
      new THREE.MeshBasicMaterial({ color: 0xffca8a, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2; // rings are built in the XY plane; lay it on the floor
    ring.position.y = 0.06;
    const light = blastLights[nextBlastLight++ % blastLights.length];
    light.position.set(x, 1.1, y);
    light.distance = r * 5;
    group.add(core, ring);

    // A frag is a detonation, not a smoke bomb: a short bloom of fire and a lot of sparks,
    // with just enough smoke left behind to say something burned. Nine slow opaque puffs
    // made every explosion read as grey.
    const fire = [];
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 3.4 + Math.random() * 3.6;
      const s = sprite(SPRITES.glow, 0.9, 0.95);
      s.material.color.setHex(i % 2 ? 0xffb347 : 0xff7326);
      s.position.set(Math.cos(a) * 0.2, 0.55 + Math.random() * 0.5, Math.sin(a) * 0.2);
      group.add(s);
      fire.push({ s, vx: Math.cos(a) * speed, vz: Math.sin(a) * speed, vy: 2.2 + Math.random() * 1.6 });
    }
    const puffs = [];
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 0.9 + Math.random() * 1.5;
      const s = sprite(SPRITES.smoke, 0.8, 0.34);
      // Smoke hides what is behind it rather than glowing, unlike every other sprite here.
      s.material.blending = THREE.NormalBlending;
      s.position.set(Math.cos(a) * 0.3, 0.5 + Math.random() * 0.6, Math.sin(a) * 0.3);
      group.add(s);
      puffs.push({ s, vx: Math.cos(a) * speed, vz: Math.sin(a) * speed, vy: 0.8 + Math.random() * 0.7 });
    }
    const sparks = [];
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 6 + Math.random() * 10;
      const s = sprite(SPRITES.glow, 0.2);
      s.material.color.setHex(0xffd27a);
      s.position.set(0, 0.5, 0);
      group.add(s);
      sparks.push({ s, vx: Math.cos(a) * speed, vz: Math.sin(a) * speed, vy: 3 + Math.random() * 5 });
    }
    scene.add(markFx(group));
    blasts.push({ group, core, ring, light, fire, puffs, sparks, t: 0, r, slow });
  }

  // A blast builds its own geometry and materials, so they go back when it ends.
  function disposeBlast(b) {
    b.light.intensity = 0; // handed back dark, never removed from the scene
    scene.remove(b.group);
    b.group.traverse(o => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    });
  }

  // A smoke has to actually hide what is behind it, or the simulation blocking vision looks
  // like a bug. A cluster of soft billboards reads as volume from any angle and costs far
  // less than real volumetrics; they are wide enough to overlap so there are no gaps.
  function syncSmoke(view, dt) {
    const live = new Set();
    for (const s of view.smokes ?? []) {
      live.add(s.id);
      let cloud = smokes.get(s.id);
      if (!cloud) {
        const group = new THREE.Group();
        const puffs = [];
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2 + Math.random();
          const rise = Math.random();
          const puff = sprite(SPRITES.smoke, 1, 0.85);
          puff.material.blending = THREE.NormalBlending;
          puff.material.depthWrite = false;
          puff.material.color.setHex(0xd7dade);
          puff.position.set(Math.cos(a) * (0.3 + rise * 0.55), 0.5 + rise * 1.5, Math.sin(a) * (0.3 + rise * 0.55));
          group.add(puff);
          puffs.push({ puff, spin: (Math.random() - 0.5) * 0.35, base: puff.position.clone() });
        }
        scene.add(markFx(group));
        cloud = { group, puffs, t: 0 };
        smokes.set(s.id, cloud);
      }
      cloud.t += dt;
      cloud.group.position.set(s.x, 0, s.y);
      for (const { puff, spin, base } of cloud.puffs) {
        // A slow churn, so a standing cloud is never a frozen decal.
        puff.position.set(base.x * s.radius * 0.55, base.y * (0.7 + s.density * 0.5), base.z * s.radius * 0.55);
        puff.material.rotation += spin * dt;
        puff.scale.setScalar(Math.max(0.01, s.radius * 1.25));
        puff.material.opacity = 0.34 * s.density;
      }
    }
    for (const [id, cloud] of smokes) {
      if (live.has(id)) continue;
      scene.remove(cloud.group);
      cloud.group.traverse(o => { o.material?.dispose?.(); });
      smokes.delete(id);
    }
  }

  function syncGrenades(view, dt) {
    const live = new Set();
    for (const g of view.grenades ?? []) {
      live.add(g.id);
      let m = nades.get(g.id);
      if (!m) {
        m = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 12, 10),
          new THREE.MeshStandardMaterial({ color: 0x2f3a2a, emissive: 0x000000, roughness: 0.7 }),
        );
        m.castShadow = true;
        nades.set(g.id, m);
        scene.add(m);
      }
      // In the air it arcs; once it lands it sits on the floor and blinks toward the fuse.
      m.position.set(g.x, g.landed ? 0.18 : 1.1, g.y);
      const blink = g.landed && Math.sin(view.time * 26) > 0 ? 0xff3b2f : 0x000000;
      m.material.emissive.setHex(blink);
    }
    for (const [id, m] of nades) {
      if (live.has(id)) continue;
      scene.remove(m);
      nades.delete(id);
    }
    for (const e of view.effects) {
      if (e.kind !== 'blast' || !newEffects.has(effectKey(e))) continue;
      spawnBlast(e.x, e.y, e.r ?? 5, 1);
    }
    for (let i = blasts.length - 1; i >= 0; i--) {
      const b = blasts[i];
      b.t += dt;
      const LIFE = 1.9 * (b.slow ?? 1);
      const k = b.t / LIFE;
      // Core: gone in a tenth of a second, which is what makes the rest feel like aftermath.
      const flashK = Math.min(1, b.t / (0.1 * (b.slow ?? 1)));
      b.core.material.opacity = Math.max(0, 1 - b.t / (0.13 * (b.slow ?? 1)));
      b.core.scale.setScalar(b.r * (0.35 + flashK * 0.8));
      b.light.intensity = Math.max(0, 40 * (b.slow ?? 1) * (1 - b.t / (0.22 * (b.slow ?? 1))));
      // Shockwave: fast out, fading as it goes.
      const ringK = Math.min(1, b.t / (0.45 * (b.slow ?? 1)));
      b.ring.scale.setScalar(Math.max(0.01, b.r * ringK));
      b.ring.material.opacity = 0.8 * (1 - ringK) ** 1.5;
      // Fireballs: fast, bright, and out inside half a second. This is the part that makes
      // a frag read as a detonation rather than a puff of grey.
      for (const p of b.fire ?? []) {
        p.s.position.x += p.vx * dt;
        p.s.position.z += p.vz * dt;
        p.s.position.y += p.vy * dt;
        p.vy *= 0.9;
        p.vx *= 0.88;
        p.vz *= 0.88;
        const fk = Math.min(1, b.t / (0.45 * (b.slow ?? 1)));
        p.s.scale.setScalar(b.r * (0.25 + fk * 0.55));
        p.s.material.opacity = Math.max(0, (1 - fk) ** 1.4);
      }
      for (const p of b.puffs) {
        p.s.position.x += p.vx * dt;
        p.s.position.z += p.vz * dt;
        p.s.position.y += p.vy * dt;
        p.vy *= 0.97;
        p.vx *= 0.94;
        p.vz *= 0.94;
        p.s.scale.setScalar(b.r * (0.5 + k * 0.9));
        // Thinner than it was, and it arrives after the fire rather than with it.
        p.s.material.opacity = Math.max(0, 0.34 * Math.min(1, b.t * 4) * (1 - k) ** 1.2);
      }
      for (const p of b.sparks) {
        p.vy -= 9 * dt; // sparks actually fall
        p.s.position.x += p.vx * dt;
        p.s.position.z += p.vz * dt;
        p.s.position.y = Math.max(0.05, p.s.position.y + p.vy * dt);
        p.vx *= 0.96;
        p.vz *= 0.96;
        p.s.material.opacity = Math.max(0, 1 - b.t / (0.55 * (b.slow ?? 1)));
      }
      if (b.t >= LIFE) {
        disposeBlast(b);
        blasts.splice(i, 1);
      }
    }
  }

  let lastSpikeTimer = Infinity;
  function syncSpike(view, dt) {
    const sp = view.spike;
    const shown = sp && ['planted', 'dropped'].includes(sp.state);
    spike.group.visible = Boolean(shown);
    if (!shown) {
      lastSpikeTimer = Infinity;
      return;
    }
    spike.group.position.set(sp.x, 0, sp.y);
    const planted = sp.state === 'planted';

    // Legs swing out over about a third of a second when it goes down, and fold back if it is
    // somehow picked up again, so the transition is never an instant snap.
    spike.deploy += ((planted ? 1 : 0) - spike.deploy) * Math.min(1, dt * 7);
    for (let i = 0; i < spike.legs.length; i++) {
      spike.legs[i].rotation.z = -0.15 - spike.deploy * 0.95;
      spike.legs[i].position.y = 0.22 - spike.deploy * 0.02;
    }
    spike.group.position.y = -spike.deploy * 0.04; // settles as it takes weight
    spike.group.rotation.y += dt * (planted ? 0.25 : 0.05);

    if (!planted) {
      // Dropped: inert, a slow standby pulse so it can still be spotted on the floor.
      const idle = 0.35 + Math.sin(view.time * 2) * 0.12;
      spike.core.material.emissiveIntensity = idle;
      for (const sl of spike.slots) sl.material.emissiveIntensity = idle;
      spike.glow.material.opacity = 0.18;
      spike.glow.scale.setScalar(0.8);
      spike.light.intensity = 1.2;
      lastSpikeTimer = Infinity;
      return;
    }

    // Planted: the beat accelerates as the fuse burns, which is the whole tension of the round.
    const left = Math.max(0, sp.timer ?? 0);
    const rate = 1.6 + (1 - Math.min(1, left / 35)) ** 2 * 11;
    spike.beat += dt * rate;
    const pulse = (Math.sin(spike.beat * Math.PI * 2) + 1) / 2;
    const sharp = pulse ** 3; // a beat, not a sine wash
    spike.core.material.emissiveIntensity = 1.2 + sharp * 7;
    for (const sl of spike.slots) sl.material.emissiveIntensity = 0.8 + sharp * 5;
    spike.glow.material.opacity = 0.25 + sharp * 0.6;
    spike.glow.scale.setScalar(1.1 + sharp * 1.5);
    spike.light.intensity = 3 + sharp * 26;
    // Defusing cools it toward white as the wire comes out.
    const defuse = sp.defuse ?? 0;
    spike.core.material.emissive.setHex(defuse > 0.02 ? 0xffd27a : 0xff4a1e);

    // Detonation: the fuse reaching zero is the one moment worth a full-size explosion.
    if (lastSpikeTimer > 0.35 && left <= 0.35) detonate(sp.x, sp.y);
    lastSpikeTimer = left;
  }

  // A much larger, slower version of a grenade blast, plus a ground scorch.
  function detonate(x, y) {
    spawnBlast(x, y, 16, 2.6);
  }

  function syncBeacon() {
    beacon.group.visible = Boolean(pointer);
    if (!pointer) return;
    beacon.group.position.set(pointer.x, 0, pointer.y);
    const age = (performance.now() - pointer.at) / 8000;
    const o = Math.max(0, 1 - age * 0.7);
    beacon.beam.material.opacity = 0.5 * o;
    beacon.gem.material.opacity = o;
    beacon.gem.position.y = 2.6 + Math.sin(performance.now() / 300) * 0.12;
    beacon.gem.rotation.y += 0.03;
  }

  // ---------- weapon ----------

  // Springs, not animation clips: the gun lags behind the turn, bobs while walking and kicks on
  // a shot. The kick is cosmetic — the sim decides accuracy, so the muzzle stays on the crosshair.
  function aimWeapon(view, unit, cam, dt) {
    const dYaw = wrap(cam.angle - sway.lastYaw);
    sway.lastYaw = cam.angle;
    const k = 90;
    const damp = 13;
    sway.vx += (-dYaw * 2.2 - sway.x) * k * dt;
    sway.vy += (-sway.y) * k * dt;
    sway.vx -= sway.vx * damp * dt;
    sway.vy -= sway.vy * damp * dt;
    sway.x += sway.vx * dt;
    sway.y += sway.vy * dt;
    sway.x = clamp(sway.x, -0.09, 0.09);

    const walking = unit.moving;
    bobPhase += dt * (walking ? 11 : 2.5);
    const bob = walking ? 0.016 : 0.004;
    sway.kick = Math.max(0, sway.kick - dt * 9);
    if (unit.firing) sway.kick = 1;

    weapon.group.position.set(
      0.15 + sway.x + Math.cos(bobPhase) * bob,
      -0.22 + sway.y + Math.abs(Math.sin(bobPhase)) * bob - sway.kick * 0.012,
      -0.95 + sway.kick * 0.05,
    );
    // Toed in slightly so the muzzle converges toward the crosshair instead of the gun sitting
    // square to the screen edge — the difference between "held" and "floating".
    weapon.group.rotation.set(sway.kick * 0.09, -0.07 + sway.x * 0.6, sway.y * 0.5);
    muzzle.vm.visible = sway.kick > 0.55;
    if (muzzle.vm.visible) {
      muzzle.vm.scale.setScalar(0.22 + Math.random() * 0.2);
      muzzle.vm.material.rotation = Math.random() * Math.PI * 2;
    }
    muzzle.light.intensity = sway.kick > 0.55 ? 6 : 0;
    muzzle.light.position.copy(camera.position);
  }

  // ---------- HUD ----------

  // Your own hit has nowhere to show: you never see your own body. The screen takes it instead.
  let ownHp;
  let ownHurt = 0;
  function drawHud(view, unit, dt) {
    if (ownHp !== undefined && unit.hp < ownHp) ownHurt = Math.min(1, ownHurt + 0.45 + (ownHp - unit.hp) / 70);
    ownHp = unit.hp;
    ownHurt = Math.max(0, ownHurt - dt * 2.2);
    vignette(ownHurt);
    // Being flashed covers everything, including the crosshair and the name tags: the whole
    // point is that this agent cannot see, and the overlay has to agree with the simulation.
    if (unit.blind > 0) {
      blindWash(unit.blind);
      return;
    }
    // Name tags and health bars sit on the 2D overlay: crisper than sprites and no depth fighting.
    for (const [id, f] of figures) {
      if (!f.group.visible) continue;
      const u = view.units.find(x => x.id === id);
      if (!u) continue;
      const own = u.team === view.team;
      // A teammate's name sits on their shoulders rather than floating over their head, so it
      // reads as belonging to that figure in a crowd. The enemy health bar stays up top, clear
      // of the body it describes.
      const p = project(f.group.position.x, own ? NAME_H : BAR_H, f.group.position.z);
      if (!p) continue;
      hud.textAlign = 'center';
      if (own) {
        const label = u.name.toUpperCase();
        hud.font = '700 12px system-ui, sans-serif';
        const w = hud.measureText(label).width + 10;
        hud.fillStyle = 'rgba(10,14,20,0.6)';
        hud.fillRect(p.x - w / 2, p.y - 13, w, 16);
        hud.fillStyle = u.color ?? '#4aa3ff';
        hud.fillText(label, p.x, p.y);
      } else {
        const w = 34;
        hud.fillStyle = 'rgba(0,0,0,0.55)';
        hud.fillRect(p.x - w / 2, p.y, w, 4);
        hud.fillStyle = u.color ?? '#ff4d5a';
        hud.fillRect(p.x - w / 2, p.y, (w * u.hp) / u.maxHp, 4);
      }
    }
    crosshair(unit);
  }

  // Project a world point to overlay pixels; null when it is behind the camera. Called for
  // every name tag every frame, so it reuses one vector rather than leaving a trail of them
  // for the collector to find mid-round.
  const projected = new THREE.Vector3();
  function project(x, h, z) {
    const v = projected.set(x, h, z).project(camera);
    if (v.z > 1) return null;
    return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
  }

  // Darkened corners pull the eye to the crosshair and hide the fact that the scene has no
  // post-processing. Two pixels of cost, drawn on the overlay rather than in WebGL.
  // Full white at the moment it pops, then thinning to a haze as it wears off. The last
  // second is translucent rather than opaque, so vision comes back before control does.
  function blindWash(left) {
    const strength = Math.min(1, left / 1.4);
    hud.fillStyle = `rgba(255,255,252,${(0.35 + 0.62 * strength).toFixed(3)})`;
    hud.fillRect(0, 0, W, H);
  }

  function vignette(hurt = 0) {
    const g = hud.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.42)');
    hud.fillStyle = g;
    hud.fillRect(0, 0, W, H);
    if (hurt <= 0.01) return;
    // Red from the edges in, never over the middle: the moment you are hit is the moment you
    // most need to see what hit you.
    const r = hud.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.16, W / 2, H / 2, Math.max(W, H) * 0.62);
    r.addColorStop(0, 'rgba(190,20,10,0)');
    r.addColorStop(1, `rgba(190,20,10,${(0.66 * hurt).toFixed(3)})`);
    hud.fillStyle = r;
    hud.fillRect(0, 0, W, H);
  }

  // Green only while the sim says this agent actually has someone under the crosshair, and a
  // marker on a hit it helped land. Drawn permanently green, it said "the bonus is live" at all
  // times — including while you were looking at a wall — so the one mechanic in the game that
  // rewards aiming gave the player nothing to learn from. Same two rules as pov.js: G switches
  // between the two renderers mid-round, and they should not disagree about what you are seeing.
  function crosshair(unit) {
    const cx = W / 2;
    const cy = H / 2;
    hud.strokeStyle = unit.aimTargetId != null ? 'rgba(120, 255, 190, 0.95)' : 'rgba(255, 255, 255, 0.5)';
    hud.lineWidth = 2;
    hud.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      hud.moveTo(cx + dx * 4, cy + dy * 4);
      hud.lineTo(cx + dx * 10, cy + dy * 10);
    }
    hud.stroke();
    if (unit.aimHit) {
      hud.strokeStyle = '#fff';
      hud.beginPath();
      for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        hud.moveTo(cx + dx * 12, cy + dy * 12);
        hud.lineTo(cx + dx * 18, cy + dy * 18);
      }
      hud.stroke();
    }
  }

  // ---------- input ----------

  function setPointer(p) {
    pointer = p;
  }

  // Screen point → world position, by casting at the actual floor and wall meshes. The pick is
  // clamped just short of a wall so an order never lands inside one.
  const ray = new THREE.Raycaster();
  function toWorld(clientX, clientY) {
    if (!W || !H) return null;
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickable, false)[0];
    if (!hit) return null;
    const p = hit.point;
    if (hit.object !== floor) {
      // Pull back along the ray so the spot is standable floor, not the wall face itself.
      const back = ray.ray.direction.clone().multiplyScalar(-0.7);
      p.add(back);
    }
    const d = Math.hypot(p.x - camera.position.x, p.z - camera.position.z);
    if (d > FAR) {
      const t = FAR / d;
      p.x = camera.position.x + (p.x - camera.position.x) * t;
      p.z = camera.position.z + (p.z - camera.position.z) * t;
    }
    return { x: p.x, y: p.z };
  }

  // What this renderer thinks its own state is, for the stall report in main.js.
  const diagnostics = () => ({
    contextLost, qualityLevel, post: usingPost(), renderRatio: appliedRatio, slowFrames, fastFrames, recoveryFrames,
    figures: figures.size, size: [Math.round(W), Math.round(H)],
    glLost: renderer.getContext()?.isContextLost?.() ?? null,
  });

  return { draw, toWorld, setPointer, reset, diagnostics };
}

// ---------- scene construction ----------

// The shadow camera has to cover whichever map is loaded, so the sun is re-aimed on every
// map change rather than positioned once at startup.
function aimSun(sun, map) {
  const reach = Math.max(map.width, map.height) * 1.1;
  const dir = sunVector().multiplyScalar(reach);
  sun.position.set(map.width / 2 + dir.x, Math.max(30, dir.y), map.height / 2 + dir.z);
  sun.target.position.set(map.width / 2, 0, map.height / 2);
  sun.target.updateMatrixWorld();
  const span = Math.max(map.width, map.height) * 0.62;
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: Math.max(220, map.height * 3.2) });
  sun.shadow.camera.updateProjectionMatrix();
}

// A gradient dome is still a painted backdrop. This is three's Preetham atmospheric model:
// the horizon haze, the blue falloff overhead and the glare around the sun all come out of
// scattering maths, so the sky changes correctly with sun height instead of being a ramp.
// Sun elevation and azimuth are shared with the directional light, so shadows always agree
// with where the sun visibly is.
// A painted dome, not a scattering model. three's Preetham sky is physically nicer but it
// outputs real radiance: the sun disc blooms uncontrollably and every exposure decision in the
// scene ends up serving the sky. A dome gives the same cues — deep zenith, pale horizon band,
// cloud, a sun glow in the right place — with the brightness under our control.
function skyCanvas() {
  const w = 1024;
  const h = 512;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#1f5b96');
  grad.addColorStop(0.32, '#5d93c4');
  grad.addColorStop(0.62, '#a8c3d8');
  grad.addColorStop(0.84, '#ddd3bb');
  grad.addColorStop(1, '#cbbb9c');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // Cloud banks: stacks of soft ellipses, flattened and kept to the upper half.
  for (let i = 0; i < 26; i++) {
    const cx = Math.random() * w;
    const cy = h * (0.08 + Math.random() * 0.42);
    const scale = 40 + Math.random() * 130;
    for (let k = 0; k < 7; k++) {
      const rx = scale * (0.4 + Math.random() * 0.8);
      const ry = rx * (0.18 + Math.random() * 0.16);
      const blob = g.createRadialGradient(cx + (Math.random() - 0.5) * scale, cy + (Math.random() - 0.5) * scale * 0.3, 0,
        cx, cy, rx);
      blob.addColorStop(0, `rgba(255,255,255,${0.1 + Math.random() * 0.16})`);
      blob.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = blob;
      g.save();
      g.translate(cx, cy);
      g.scale(1, ry / rx);
      g.translate(-cx, -cy);
      g.beginPath();
      g.arc(cx, cy, rx, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  return c;
}

const SUN_ELEVATION = 34;
const SUN_AZIMUTH = 128;
const sunVector = () => new THREE.Vector3().setFromSphericalCoords(
  1, THREE.MathUtils.degToRad(90 - SUN_ELEVATION), THREE.MathUtils.degToRad(SUN_AZIMUTH),
);

function buildSky(scene) {
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(170, 32, 20),
    new THREE.MeshBasicMaterial({ map: texture(skyCanvas(), true), side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  markFx(dome);
  scene.add(dome);
  // A soft glow on the true sun vector, so the bright part of the sky and the direction the
  // shadows fall agree with each other.
  const glow = sprite(SPRITES.glow, 46);
  glow.position.copy(sunVector().multiplyScalar(150));
  glow.material.opacity = 0.75;
  markFx(glow);
  scene.add(glow);
  return dome;
}

function buildLights(scene, vmScene) {
  // Warm key against cool fill. Colour contrast between light and shadow does more for depth
  // than any texture: flat grey lighting is what makes untextured scenes look dead.
  scene.add(new THREE.HemisphereLight(0xbcd6f0, 0x54452f, 1.25));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.1);
  sun.castShadow = true;
  // 2048 costs four times 1024 for a difference nobody sees on untextured geometry at this
  // scale, and the shadow pass re-renders every caster in the map.
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0009;
  scene.add(sun, sun.target);
  // The weapon is lit on its own so it reads clearly in shadowed corridors.
  vmScene.add(new THREE.HemisphereLight(0xdfe8f2, 0x2a2a30, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-0.6, 1.1, 0.8);
  vmScene.add(key);
  return sun;
}

// ---------- procedural Source-style surfaces ----------
//
// Source materials are an albedo plus a $bumpmap; that pairing, not texture resolution, is what
// makes its surfaces catch light. Here both are generated at runtime: a height field is drawn
// once, converted to a normal map by finite differences, and paired with a matching albedo.

const SIZE = 256;

function canvas2d(size = SIZE) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

// Slope of the height field becomes the surface normal. Wrapped lookups keep it tileable.
function heightToNormal(height, strength) {
  const src = height.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
  const out = canvas2d();
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  const at = (x, y) => src[((((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)) * 4] / 255;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * SIZE + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function texture(canvas, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Grain, on both the colour and the height, is what stops a large flat surface looking like a
// solid fill. Stone gets coarse aggregate, plaster gets fine tooth.
function speckle(g, count, alpha, spread = 2) {
  for (let i = 0; i < count; i++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${Math.random() * alpha})`;
    g.fillRect(Math.random() * SIZE, Math.random() * SIZE, Math.random() * spread + 1, Math.random() * spread + 1);
  }
}

// Offset courses of blocks with recessed mortar: the dust2 sandstone read.
function blockSurface({ base, mortar, light, rows = 4, cols = 2, jitter = 0.05, rough = 0.85 }) {
  const albedo = canvas2d();
  const height = canvas2d();
  const rough_ = canvas2d();
  const a = albedo.getContext('2d');
  const h = height.getContext('2d');
  const r = rough_.getContext('2d');
  a.fillStyle = mortar;
  a.fillRect(0, 0, SIZE, SIZE);
  h.fillStyle = '#000';          // mortar sits low
  h.fillRect(0, 0, SIZE, SIZE);
  r.fillStyle = '#ffffff';       // mortar is rough
  r.fillRect(0, 0, SIZE, SIZE);
  const rh = SIZE / rows;
  const cw = SIZE / cols;
  const gap = 5; // wider mortar joint, so the courses read at a distance
  for (let row = 0; row < rows; row++) {
    const shift = (row % 2) * (cw / 2); // running bond
    for (let col = -1; col <= cols; col++) {
      const x = col * cw + shift + gap / 2;
      const y = row * rh + gap / 2;
      const w = cw - gap;
      const bh = rh - gap;
      const tint = 1 + (Math.random() - 0.5) * jitter * 2;
      a.fillStyle = shade(base, tint);
      a.fillRect(x, y, w, bh);
      h.fillStyle = `rgb(${Math.round(190 + Math.random() * 45)},0,0)`; // block face sits proud
      h.fillRect(x, y, w, bh);
      r.fillStyle = shade('#d8d8d8', tint);
      r.fillRect(x, y, w, bh);
      // A lit top edge on each block, the way worn stone catches the sun.
      a.fillStyle = shade(light, tint);
      a.fillRect(x, y, w, 2);
    }
  }
  speckle(a, SIZE * 8, 0.12, 3);
  speckle(h, SIZE * 6, 0.16, 2);
  return {
    map: texture(albedo, true),
    normalMap: texture(heightToNormal(height, 4.2), false),
    roughnessMap: texture(rough_, false),
    roughness: rough,
  };
}

// Poured concrete slabs with expansion joints: floors and walkways.
function slabSurface({ base, joint, rough = 0.95, cells = 2 }) {
  const albedo = canvas2d();
  const height = canvas2d();
  const a = albedo.getContext('2d');
  const h = height.getContext('2d');
  a.fillStyle = base;
  a.fillRect(0, 0, SIZE, SIZE);
  h.fillStyle = '#c8c8c8';
  h.fillRect(0, 0, SIZE, SIZE);
  // Broad stains keep big floors from tiling visibly to the eye.
  for (let i = 0; i < 18; i++) {
    const rad = 20 + Math.random() * 70;
    const grad = a.createRadialGradient(Math.random() * SIZE, Math.random() * SIZE, 2, Math.random() * SIZE, Math.random() * SIZE, rad);
    grad.addColorStop(0, `rgba(0,0,0,${Math.random() * 0.07})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    a.fillStyle = grad;
    a.fillRect(0, 0, SIZE, SIZE);
  }
  const step = SIZE / cells;
  for (let i = 0; i <= cells; i++) {
    for (const [gx, gy, gw, gh] of [[i * step - 1.5, 0, 3, SIZE], [0, i * step - 1.5, SIZE, 3]]) {
      a.fillStyle = joint;
      a.fillRect(gx, gy, gw, gh);
      h.fillStyle = '#101010';
      h.fillRect(gx, gy, gw, gh);
    }
  }
  speckle(a, SIZE * 10, 0.1, 2);
  speckle(h, SIZE * 8, 0.2, 2);
  return {
    map: texture(albedo, true),
    normalMap: texture(heightToNormal(height, 2.2), false),
    roughness: rough,
  };
}

function shade(hexStr, k) {
  const n = parseInt(hexStr.slice(1), 16);
  const ch = i => Math.max(0, Math.min(255, Math.round(((n >> (i * 8)) & 255) * k)));
  return `rgb(${ch(2)},${ch(1)},${ch(0)})`;
}

// Sawn planks with gaps, for crates.
function plankSurface({ base, gap, rows = 4 }) {
  const albedo = canvas2d();
  const height = canvas2d();
  const a = albedo.getContext('2d');
  const h = height.getContext('2d');
  a.fillStyle = gap;
  a.fillRect(0, 0, SIZE, SIZE);
  h.fillStyle = '#000';
  h.fillRect(0, 0, SIZE, SIZE);
  const rh = SIZE / rows;
  for (let i = 0; i < rows; i++) {
    const tint = 1 + (Math.random() - 0.5) * 0.16;
    a.fillStyle = shade(base, tint);
    a.fillRect(0, i * rh + 2, SIZE, rh - 4);
    h.fillStyle = '#d0d0d0';
    h.fillRect(0, i * rh + 2, SIZE, rh - 4);
    // Grain: long low-contrast streaks along the plank.
    for (let s = 0; s < 22; s++) {
      a.fillStyle = `rgba(0,0,0,${Math.random() * 0.1})`;
      a.fillRect(Math.random() * SIZE, i * rh + 3 + Math.random() * (rh - 8), Math.random() * 90 + 20, 1);
    }
  }
  speckle(a, SIZE * 4, 0.08, 2);
  return {
    map: texture(albedo, true),
    normalMap: texture(heightToNormal(height, 2), false),
    roughness: 0.92,
  };
}

// Generated on first use and shared thereafter: the normal-map conversion is a per-pixel loop,
// so it should happen once per surface for the whole session, not once per mesh.
const cache = new Map();
const once = (key, make) => {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
};
const SURFACES = {
  // A warm sandstone/concrete palette: the desert-map look Source shooters are built around.
  get stone() {
    return once('stone', () => blockSurface({ base: '#c1a97f', mortar: '#6f6047', light: '#dcc79f', rows: 3, cols: 2, jitter: 0.2 }));
  },
  get ground() {
    return once('ground', () => slabSurface({ base: '#a8977a', joint: '#6f6350', cells: 2 }));
  },
  get crate() {
    return once('crate', () => plankSurface({ base: '#9a6f3f', gap: '#3d2a16' }));
  },
  // Two more wall families, so a street isn't one material end to end.
  get plaster() {
    return once('plaster', () => slabSurface({ base: '#d2c3a4', joint: '#a6957a', cells: 1, rough: 0.9 }));
  },
  get painted() {
    return once('painted', () => blockSurface({ base: '#cbc2a9', mortar: '#9b907a', light: '#e2dac2', rows: 3, cols: 2, jitter: 0.14 }));
  },
};

// Soft radial sprites for anything that glows or drifts. Additive sprites are what make a
// muzzle flash and an explosion read as light rather than as more geometry.
function radial(stops, size = 128) {
  const c = canvas2d(size);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, col] of stops) grad.addColorStop(at, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

// A muzzle flash is a bright core with a few uneven petals, never a disc.
function flashCanvas() {
  const size = 128;
  const c = canvas2d(size);
  const g = c.getContext('2d');
  g.translate(size / 2, size / 2);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + Math.random() * 0.4;
    const len = size * (0.24 + Math.random() * 0.24);
    g.fillStyle = 'rgba(255,214,130,0.85)';
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(Math.cos(a - 0.12) * len, Math.sin(a - 0.12) * len);
    g.lineTo(Math.cos(a + 0.12) * len, Math.sin(a + 0.12) * len);
    g.closePath();
    g.fill();
  }
  const core = g.createRadialGradient(0, 0, 0, 0, 0, size * 0.22);
  core.addColorStop(0, 'rgba(255,255,240,1)');
  core.addColorStop(0.5, 'rgba(255,206,120,0.9)');
  core.addColorStop(1, 'rgba(255,150,40,0)');
  g.fillStyle = core;
  g.fillRect(-size / 2, -size / 2, size, size);
  return c;
}

const SPRITES = {
  get flash() { return once('sp:flash', () => texture(flashCanvas(), true)); },
  get smoke() {
    return once('sp:smoke', () => texture(radial([[0, 'rgba(180,170,155,0.85)'], [0.55, 'rgba(150,140,125,0.45)'], [1, 'rgba(130,120,105,0)']]), true));
  },
  get glow() {
    return once('sp:glow', () => texture(radial([[0, 'rgba(255,240,200,1)'], [0.4, 'rgba(255,170,70,0.7)'], [1, 'rgba(255,120,30,0)']]), true));
  },
};

const sprite = (map, size, opacity = 1) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity,
  }));
  s.scale.setScalar(size);
  return s;
};

// The bombsite marker, the way a defusal map paints it: a big stencilled letter inside a
// rough painted box, sprayed on and then walked over for a few years.
function siteCanvas(letter) {
  const size = 512;
  const c = canvas2d(size);
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  g.strokeStyle = 'rgba(214,138,42,0.85)';
  g.lineWidth = 16;
  g.setLineDash([54, 26]);
  g.strokeRect(46, 46, size - 92, size - 92);
  g.setLineDash([]);
  g.fillStyle = 'rgba(224,150,48,0.9)';
  g.font = `900 ${size * 0.62}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(letter, size / 2, size * 0.54);
  g.font = `800 ${size * 0.075}px system-ui, sans-serif`;
  g.fillStyle = 'rgba(232,206,160,0.7)';
  g.fillText(`BOMB SITE ${letter}`, size / 2, size * 0.9);
  // Wear: punch holes back out of the paint so it looks walked on, not printed.
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 900; i++) {
    g.globalAlpha = Math.random() * 0.5;
    g.beginPath();
    g.arc(Math.random() * size, Math.random() * size, Math.random() * 9, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  return c;
}

// Stains, sand drift and cracks. Large flat areas are the thing that reads as untextured, and
// a handful of soft dark blotches breaks them up more cheaply than any amount of tiling detail.
function grimeCanvas() {
  const size = 256;
  const c = canvas2d(size);
  const g = c.getContext('2d');
  for (let i = 0; i < 12; i++) {
    const r = 30 + Math.random() * 80;
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, r);
    grad.addColorStop(0, `rgba(40,32,22,${0.05 + Math.random() * 0.1})`);
    grad.addColorStop(1, 'rgba(40,32,22,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  for (let i = 0; i < 26; i++) {
    g.strokeStyle = `rgba(30,24,16,${Math.random() * 0.22})`;
    g.lineWidth = Math.random() * 2 + 0.4;
    g.beginPath();
    let x = Math.random() * size;
    let y = Math.random() * size;
    g.moveTo(x, y);
    for (let k = 0; k < 5; k++) {
      x += (Math.random() - 0.5) * 70;
      y += (Math.random() - 0.5) * 70;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  return c;
}

// Repeat is per-mesh, so every surface shares one generated texture rather than cloning it.
function tiled(src, rx, ry) {
  const out = {};
  for (const key of ['map', 'normalMap', 'roughnessMap']) {
    if (!src[key]) continue;
    out[key] = src[key].clone();
    out[key].needsUpdate = true;
    out[key].repeat.set(rx, ry);
  }
  return { ...src, ...out };
}

function buildFloor(scene, map) {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(map.width, map.height),
    new THREE.MeshStandardMaterial(tiled(SURFACES.ground, map.width / 4, map.height / 4)),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(map.width / 2, 0, map.height / 2);
  floor.receiveShadow = true;
  scene.add(floor);
  // Paint the bombsites on the ground the way a defusal map does.
  for (const name of map.sites) {
    const z = map.zones.find(zz => zz.name === name);
    if (!z) continue;
    const side = Math.min(z.rect.w, z.rect.h) * 0.85;
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(side, side),
      new THREE.MeshBasicMaterial({
        map: once(`site:${name[0]}`, () => texture(siteCanvas(name[0]), true)),
        transparent: true, depthWrite: false, opacity: 0.85,
      }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(z.center.x, 0.02, z.center.y);
    scene.add(markFx(pad));
  }
  // Scatter grime over the walkable areas so the floor isn't an unbroken tiled field.
  const grime = once('grime', () => texture(grimeCanvas(), true));
  const rnd = seeded({ x: map.width, y: map.height, w: 3, h: 5 });
  for (const z of map.zones) {
    const n = Math.max(1, Math.round((z.rect.w * z.rect.h) / 90));
    for (let i = 0; i < n; i++) {
      const sizeM = 5 + rnd() * 9;
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(sizeM, sizeM),
        new THREE.MeshBasicMaterial({ map: grime, transparent: true, depthWrite: false, opacity: 0.5 + rnd() * 0.4 }),
      );
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = rnd() * Math.PI * 2;
      m.position.set(z.rect.x + rnd() * z.rect.w, 0.015, z.rect.y + rnd() * z.rect.h);
      scene.add(markFx(m));
    }
  }
  return floor;
}

// Every wall rectangle is solid to the sim, so every one has to be solid on screen — but a
// waist-high block of cover and a full-height building want to look different. Small rects
// become crate stacks and barrels, the way a Source map dresses its cover; large ones become
// sandstone structures. Collision is identical either way: the sim only knows the rectangle.
const COVER = 5; // rects at or under this, on both axes, are cover rather than architecture

// Every rectangle is solid to the sim, but nothing says they all have to be the same slab.
// Height, massing and dressing are pure decoration here — the sim only ever sees the 2D
// rectangle — so the map can have low garden walls, two-storey blocks and a landmark dome
// without changing a single sightline or hitbox.
function buildWalls(scene, map) {
  const meshes = [];
  for (const r of map.walls) {
    const rnd = seeded(r);
    const cover = r.w <= COVER && r.h <= COVER;
    const edge = r.x <= 0 || r.y <= 0 || r.x + r.w >= map.width || r.y + r.h >= map.height;
    // Perimeter masses become buildings; interior walls vary around head height so the
    // skyline has some rhythm instead of one flat band everywhere.
    const height = cover ? 1.5 : edge ? 7 + rnd() * 6 : 2.8 + rnd() * 2.2;

    const family = [SURFACES.stone, SURFACES.plaster, SURFACES.painted][Math.floor(rnd() * 3)];
    const solid = new THREE.Mesh(
      new THREE.BoxGeometry(r.w, height, r.h),
      cover
        ? new THREE.MeshBasicMaterial({ visible: false })
        : new THREE.MeshStandardMaterial(tiled(family, Math.max(1, r.w / 3), Math.max(1, height / 3))),
    );
    solid.position.set(r.x + r.w / 2, height / 2, r.y + r.h / 2);
    solid.castShadow = !cover;
    solid.receiveShadow = !cover;
    scene.add(solid);
    meshes.push(solid); // pickable either way, so pointing at cover lands in front of it

    if (cover) {
      dressCover(scene, r);
      continue;
    }
    dressWall(scene, r, height, rnd, edge);
    dressStreet(scene, r, height, rnd);
  }
  buildScenery(scene, map);
  return meshes;
}

// Skirting, cornice, pilasters and recessed openings. None of it is load-bearing; it exists
// because a bare extruded box has no edges for the sun to catch, and edges are what make
// masonry look like masonry.
function dressWall(scene, r, height, rnd, edge) {
  const trim = new THREE.MeshStandardMaterial({ color: 0x6b5f4a, roughness: 0.95 });
  const cap = new THREE.MeshStandardMaterial({ color: 0xd9cdae, roughness: 0.8 });
  const shade = new THREE.MeshStandardMaterial({ color: 0x2a2419, roughness: 1 });
  const cx = r.x + r.w / 2;
  const cz = r.y + r.h / 2;
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    return m;
  };

  add(new THREE.BoxGeometry(r.w + 0.09, 0.34, r.h + 0.09), trim, cx, 0.17, cz);
  add(new THREE.BoxGeometry(r.w + 0.13, 0.16, r.h + 0.13), cap, cx, height - 0.08, cz);
  // A parapet on the tall masses reads as a roof edge rather than a sawn-off wall.
  if (edge) add(new THREE.BoxGeometry(r.w + 0.05, 0.5, r.h + 0.05), cap, cx, height + 0.25, cz);
  // String course partway up breaks the vertical expanse into storeys.
  if (height > 4.5) add(new THREE.BoxGeometry(r.w + 0.11, 0.13, r.h + 0.11), cap, cx, height * 0.55, cz);

  const long = Math.max(r.w, r.h);
  const along = r.w >= r.h; // pilasters march down the longer face
  const bays = Math.floor(long / 5);
  for (let i = 1; i <= bays; i++) {
    const t = (i / (bays + 1) - 0.5) * long;
    const px = along ? cx + t : cx;
    const pz = along ? cz : cz + t;
    const w = along ? 0.5 : r.w + 0.12;
    const d = along ? r.h + 0.12 : 0.5;
    add(new THREE.BoxGeometry(w, height - 0.4, d), cap, px, (height - 0.4) / 2, pz);
    // Recessed openings: a dark niche with a round head, the arch motif without the geometry.
    if (height > 4.5 && rnd() < 0.7) {
      const oh = 1.1;
      const oy = height * 0.62;
      const ow = along ? 0.9 : r.w + 0.2;
      const od = along ? r.h + 0.2 : 0.9;
      const offset = along ? [px + (long / (bays + 1)) * 0.5, pz] : [px, pz + (long / (bays + 1)) * 0.5];
      add(new THREE.BoxGeometry(ow, oh, od), shade, offset[0], oy, offset[1]);
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, along ? r.h + 0.2 : 0.9, 12, 1, false, 0, Math.PI), shade);
      head.rotation.set(Math.PI / 2, 0, along ? 0 : Math.PI / 2);
      if (!along) head.rotation.set(Math.PI / 2, Math.PI / 2, 0);
      head.position.set(offset[0], oy + oh / 2, offset[1]);
      scene.add(head);
    }
  }
}

// Everything past the playable rectangle: rooflines, a landmark dome and palms. It is all
// outside the walls the sim knows about, so it can never be walked into or shot through —
// it exists to give the horizon something other than a flat band of wall.
function buildScenery(scene, map) {
  const rnd = seeded({ x: map.width, y: map.height, w: 7, h: 13 });
  const wall = new THREE.MeshStandardMaterial(tiled(SURFACES.stone, 3, 3));
  const pale = new THREE.MeshStandardMaterial({ color: 0xcdbb95, roughness: 0.85 });
  const far = new THREE.MeshStandardMaterial({ color: 0xbfc7c4, roughness: 0.9 });

  // A ring of blocks just outside the map, plus a looser outer ring for depth.
  for (const [inset, mat, count] of [[-9, wall, 26], [-26, far, 18]]) {
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const edge = Math.floor(t * 4);
      const along = (t * 4 - edge);
      const span = edge % 2 ? map.height : map.width;
      const pos = along * span;
      const out = inset - rnd() * 14;
      const p = [
        { x: pos, z: out },
        { x: map.width - out, z: pos },
        { x: span - pos, z: map.height - out },
        { x: out, z: span - pos },
      ][edge];
      const h = (mat === far ? 16 : 8) + rnd() * (mat === far ? 18 : 9);
      const b = new THREE.Mesh(new THREE.BoxGeometry(6 + rnd() * 9, h, 6 + rnd() * 9), mat);
      b.position.set(p.x, h / 2, p.z);
      b.rotation.y = rnd() * 0.3;
      b.castShadow = mat === wall;
      scene.add(b);
      if (mat === wall && rnd() < 0.35) {
        const par = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.6, 6.4), pale);
        par.position.set(p.x, h + 0.3, p.z);
        scene.add(par);
      }
    }
  }

  // The landmark: a drum and dome behind one corner, the way a desert map anchors its skyline.
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 11, 24), pale);
  drum.position.set(map.width * 0.18, 5.5, -20);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(7.4, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x2f4f7a, roughness: 0.45, metalness: 0.25 }));
  dome.position.set(map.width * 0.18, 11, -20);
  const finial = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.4, 10),
    new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.35, metalness: 0.7 }));
  finial.position.set(map.width * 0.18, 19.4, -20);
  scene.add(drum, dome, finial);

  for (let i = 0; i < 14; i++) {
    const side = i % 4;
    const t = 0.1 + rnd() * 0.8;
    const out = -5 - rnd() * 10;
    const p = [
      { x: t * map.width, z: out },
      { x: map.width - out, z: t * map.height },
      { x: t * map.width, z: map.height - out },
      { x: out, z: t * map.height },
    ][side];
    scene.add(palm(p.x, p.z, 5 + rnd() * 4, rnd));
  }
}

function palm(x, z, h, rnd) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.26, h, 8),
    new THREE.MeshStandardMaterial({ color: 0x7a6242, roughness: 1 }));
  trunk.position.y = h / 2;
  trunk.castShadow = true;
  g.add(trunk);
  const leaf = new THREE.MeshStandardMaterial({ color: 0x5c7a37, roughness: 0.9, side: THREE.DoubleSide });
  for (let i = 0; i < 8; i++) {
    const frond = new THREE.Mesh(new THREE.ConeGeometry(0.42, 3.1, 4, 1, true), leaf);
    frond.position.y = h;
    frond.rotation.set(Math.PI / 2.4, (i / 8) * Math.PI * 2, 0, 'YXZ');
    frond.scale.set(1, 1, 0.22);
    frond.translateY(1.3);
    frond.castShadow = true;
    g.add(frond);
  }
  g.position.set(x, 0, z);
  g.rotation.y = rnd() * Math.PI;
  return g;
}

// Awnings, roof clutter and water tanks. None of it is collidable; it exists so that two walls
// of the same height still read as different buildings.
function dressStreet(scene, r, height, rnd) {
  const cloth = new THREE.MeshStandardMaterial({ color: rnd() < 0.5 ? 0x9c4436 : 0x3c5a72, roughness: 0.95, side: THREE.DoubleSide });
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 0.6, metalness: 0.5 });
  const along = r.w >= r.h;
  const long = Math.max(r.w, r.h);
  const cx = r.x + r.w / 2;
  const cz = r.y + r.h / 2;

  // An awning over part of the long face, tilted down and away from the wall.
  if (height > 3.4 && long > 8 && rnd() < 0.55) {
    const width = Math.min(5, long * 0.4);
    const off = (rnd() - 0.5) * (long - width);
    const depth = 1.6;
    const awn = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), cloth);
    awn.rotation.x = -Math.PI / 2 + 0.38;
    const face = (along ? r.h : r.w) / 2 + depth * 0.4;
    if (along) awn.position.set(cx + off, 2.7, cz - face);
    else {
      awn.rotation.z = Math.PI / 2;
      awn.position.set(cx - face, 2.7, cz + off);
    }
    awn.castShadow = true;
    scene.add(awn);
  }
  // Roof clutter on the taller masses: vents, and sometimes a water tank beside one.
  if (height > 6) {
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const w = 0.8 + rnd() * 1.4;
      const h = 0.6 + rnd() * 1.1;
      const unit = new THREE.Mesh(rbox(w, h, w * 0.8, 0.05), metal);
      unit.position.set(r.x + 1 + rnd() * Math.max(0.1, r.w - 2), height + h / 2 + 0.4, r.y + 1 + rnd() * Math.max(0.1, r.h - 2));
      unit.castShadow = true;
      scene.add(unit);
      if (rnd() < 0.4) {
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.1, 12), metal);
        tank.position.set(unit.position.x + 1.4, height + 0.95, unit.position.z);
        tank.castShadow = true;
        scene.add(tank);
      }
    }
  }
}

function seeded(r) {
  let s = Math.imul(r.x * 73856093 ^ r.y * 19349663 ^ r.w * 83492791 ^ r.h * 2971215073, 1) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function dressCover(scene, r) {
  const rnd = seeded(r);
  const crate = (size, x, y, z, rot) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(size, size, size),
      new THREE.MeshStandardMaterial(tiled(SURFACES.crate, 1, 1)));
    // Corner battens: the detail that makes a box read as a crate and not a cube.
    const batten = new THREE.MeshStandardMaterial({ color: 0x6b4b2a, roughness: 0.9 });
    g.add(body);
    for (const [ax, ay] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(size * 0.1, size * 1.02, size * 0.1), batten);
      post.position.set(ax * size * 0.46, 0, ay * size * 0.46);
      g.add(post);
    }
    g.position.set(x, y, z);
    g.rotation.y = rot;
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(g);
  };
  const barrel = (x, z) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.15, 16),
      new THREE.MeshStandardMaterial({ color: 0x7a3b2e, roughness: 0.55, metalness: 0.55 }));
    m.position.set(x, 0.575, z);
    m.castShadow = true;
    m.receiveShadow = true;
    // Two rolled ribs, as on every oil drum in every shooter.
    for (const y of [-0.22, 0.22]) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.04, 6, 18),
        new THREE.MeshStandardMaterial({ color: 0x5f2d24, roughness: 0.6, metalness: 0.5 }));
      rib.rotation.x = Math.PI / 2;
      rib.position.y = y;
      m.add(rib);
    }
    scene.add(m);
  };
  const cx = r.x + r.w / 2;
  const cz = r.y + r.h / 2;
  const pick = rnd();
  if (pick < 0.22) {
    // Jersey barriers: the tapered concrete profile is unmistakable even as two boxes.
    for (const off of [-0.5, 0.5]) {
      const base = new THREE.Mesh(new THREE.BoxGeometry(Math.min(2.6, r.w * 0.9), 0.45, 0.7),
        new THREE.MeshStandardMaterial({ color: 0xb9b3a4, roughness: 0.95 }));
      base.position.set(cx, 0.22, cz + off * 0.5);
      const top = new THREE.Mesh(new THREE.BoxGeometry(Math.min(2.6, r.w * 0.9), 0.6, 0.34),
        new THREE.MeshStandardMaterial({ color: 0xc6c0b1, roughness: 0.95 }));
      top.position.set(cx, 0.75, cz + off * 0.5);
      for (const m of [base, top]) { m.castShadow = true; m.receiveShadow = true; scene.add(m); }
    }
    return;
  }
  if (pick < 0.42) {
    // Sandbags: three courses, each offset, each bag a squashed rounded box.
    const bag = new THREE.MeshStandardMaterial({ color: 0x9a8b63, roughness: 1 });
    for (let row = 0; row < 3; row++) {
      const n = 3 - (row % 2 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 6), bag);
        b.scale.set(1, 0.5, 0.66);
        b.position.set(cx + (i - (n - 1) / 2) * 0.62 + (row % 2 ? 0.3 : 0), 0.18 + row * 0.32, cz);
        b.rotation.y = rnd() * 0.4;
        b.castShadow = true;
        b.receiveShadow = true;
        scene.add(b);
      }
    }
    return;
  }
  if (pick < 0.58) {
    // A pair of drums roughly filling the footprint.
    barrel(cx - Math.min(0.45, r.w / 4), cz);
    barrel(cx + Math.min(0.45, r.w / 4), cz + (rnd() - 0.5) * 0.3);
    return;
  }
  // Otherwise crates: one big, sometimes a smaller one stacked askew on top.
  const size = Math.min(1.5, Math.max(r.w, r.h) * 0.95);
  crate(size, cx, size / 2, cz, (rnd() - 0.5) * 0.4);
  if (rnd() < 0.55) crate(size * 0.62, cx + (rnd() - 0.5) * 0.3, size + size * 0.31, cz + (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.9);
}

// A soft blob under each figure. Real contact shadows need a depth pass; this sells the same
// thing — that the model is standing on the floor and not hovering over it — for one quad.
let blobTex = null;
function blobShadow() {
  if (!blobTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    blobTex = new THREE.CanvasTexture(c);
  }
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.5),
    new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.03;
  return markFx(m);
}

// The spike, in the shape the objective actually takes: a dark angular housing with a lit core,
// four legs that fold out when it is planted, and a beacon that beats faster as the fuse runs
// down. Dropped it sits inert with the legs stowed; planted it opens up and starts counting.
function buildSpike(scene) {
  const group = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.42, metalness: 0.7 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.35, metalness: 0.8 });
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0xff5a2a, emissive: 0xff4a1e, emissiveIntensity: 2, roughness: 0.3,
  });

  // Housing: a tapered drum with a chamfered cap, not a cone on the floor.
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.21, 0.4, 8), shell);
  housing.position.y = 0.26;
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 8), trim);
  collar.position.y = 0.46;
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.17, 0.16, 8), shell);
  head.position.y = 0.55;
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.02, 0.28, 6), trim);
  antenna.position.y = 0.76;
  // The core reads through slots in the housing, so it glows from inside rather than on top.
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 10), coreMat);
  core.position.y = 0.42;
  const slots = [];
  for (let i = 0; i < 4; i++) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.2, 0.035), coreMat);
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    slot.position.set(Math.cos(a) * 0.17, 0.28, Math.sin(a) * 0.17);
    slots.push(slot);
    group.add(slot);
  }

  // Four legs on hinges: stowed against the housing, swung out and down when planted.
  const legs = [];
  for (let i = 0; i < 4; i++) {
    const hinge = new THREE.Group();
    const a = (i / 4) * Math.PI * 2;
    hinge.position.set(Math.cos(a) * 0.15, 0.22, Math.sin(a) * 0.15);
    hinge.rotation.y = -a;
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.07), trim);
    leg.position.set(0.02, -0.17, 0);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.045, 0.1), shell);
    foot.position.set(0.02, -0.34, 0);
    hinge.add(leg, foot);
    legs.push(hinge);
    group.add(hinge);
  }

  const glow = markFx(sprite(SPRITES.glow, 1.4));
  glow.position.y = 0.42;
  const light = new THREE.PointLight(0xff5a2a, 0, 9, 2);
  light.position.y = 0.5;

  group.add(housing, collar, head, antenna, core, glow, light);
  group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.visible = false;
  scene.add(group);
  return { group, core, slots, legs, glow, light, deploy: 0, beat: 0 };
}

function buildBeacon(scene) {
  const group = new THREE.Group();
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 2.6, 8),
    new THREE.MeshBasicMaterial({ color: POINTER, transparent: true, opacity: 0.5, depthWrite: false }),
  );
  beam.position.y = 1.3;
  const gem = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.3),
    new THREE.MeshBasicMaterial({ color: POINTER, transparent: true }),
  );
  gem.position.y = 2.6;
  markFx(beam);
  markFx(gem);
  group.add(beam, gem);
  group.visible = false;
  scene.add(group);
  return { group, beam, gem };
}

// ---------- weapons ----------
//
// Hard-edged boxes are the single biggest "this is programmer geometry" tell, because a real
// edge is never infinitely sharp — it catches a highlight. Every part here is a rounded box,
// so each edge picks up a thin specular line, which is most of what separates a modelled gun
// from a black slab. Parts follow a real carbine's landmarks: receiver, handguard with rail
// slots, curved magazine, collapsible stock, pistol grip, optic, muzzle brake, charging handle.
const rbox = (w, h, d, r = 0.008, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, Math.min(w, h, d) / 2.05));

// Local landmarks other code aims at: where each hand goes, and where the muzzle is.
export const GRIP = new THREE.Vector3(0, -0.10, 0.10);
export const HANDGUARD = new THREE.Vector3(0, -0.055, -0.2);
export const MUZZLE = new THREE.Vector3(0, 0.005, -0.78);

function rifle(scale = 1) {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0x33383f, roughness: 0.38, metalness: 0.75 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.55, metalness: 0.45 });
  const poly = new THREE.MeshStandardMaterial({ color: 0x2e3228, roughness: 0.82, metalness: 0.05 });
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    g.add(m);
    return m;
  };

  add(rbox(0.072, 0.105, 0.44, 0.012), steel, 0, 0, 0.02);            // upper receiver
  add(rbox(0.066, 0.055, 0.2, 0.01), dark, 0, -0.07, 0.04);           // lower receiver
  add(rbox(0.06, 0.07, 0.34, 0.014), poly, 0, -0.008, -0.34);         // handguard
  // Rail slots: six shallow cuts along the handguard read as machining, not a smooth tube.
  for (let i = 0; i < 6; i++) add(rbox(0.064, 0.012, 0.022, 0.004), dark, 0, 0.028, -0.2 - i * 0.05);
  add(new THREE.CylinderGeometry(0.0125, 0.0125, 0.3, 12), steel, 0, 0.004, -0.62, Math.PI / 2); // barrel
  // Muzzle brake: a slightly fatter can with three cut ports.
  add(new THREE.CylinderGeometry(0.021, 0.021, 0.075, 12), dark, 0, 0.004, -0.775, Math.PI / 2);
  for (let i = 0; i < 3; i++) add(rbox(0.044, 0.008, 0.008, 0.002), poly, 0, 0.022, -0.755 - i * 0.02);

  // Magazine: three short segments stepped back, which reads as the classic curve.
  for (let i = 0; i < 3; i++) {
    add(rbox(0.05, 0.075, 0.085, 0.01), poly, 0, -0.135 - i * 0.068, 0.048 + i * 0.016, 0.2 + i * 0.05);
  }
  add(rbox(0.062, 0.03, 0.1, 0.008), dark, 0, -0.1, 0.05);            // magwell

  add(rbox(0.05, 0.11, 0.065, 0.014), poly, 0, -0.12, 0.13, 0.28);    // pistol grip
  add(rbox(0.03, 0.02, 0.05, 0.004), steel, 0, -0.062, 0.115);        // trigger guard top
  add(new THREE.TorusGeometry(0.026, 0.005, 6, 12), steel, 0, -0.082, 0.115, Math.PI / 2);

  add(rbox(0.05, 0.062, 0.16, 0.012), poly, 0, -0.015, 0.28);         // buffer tube / stock
  add(rbox(0.07, 0.085, 0.055, 0.012), poly, 0, -0.02, 0.36);         // butt pad
  add(rbox(0.026, 0.05, 0.04, 0.008), dark, 0.045, 0.02, 0.12);       // charging handle

  // Optic: tube, mount, and a hooded objective.
  add(rbox(0.042, 0.03, 0.12, 0.008), dark, 0, 0.068, 0.0);
  add(new THREE.CylinderGeometry(0.023, 0.023, 0.115, 12), dark, 0, 0.095, -0.01, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.026, 0.026, 0.016, 12), steel, 0, 0.095, -0.072, Math.PI / 2);
  add(rbox(0.012, 0.03, 0.05, 0.004), steel, 0, 0.055, -0.19);        // front sight base

  g.scale.setScalar(scale);
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// A fist wrapped round the weapon: a palm plus four knuckle ridges and a thumb. Tiny, but a
// bare cube for a hand is exactly what made the old figures look like they were miming.
function fist(mat, mirror = 1) {
  const h = new THREE.Group();
  const palm = new THREE.Mesh(rbox(0.055, 0.085, 0.075, 0.018), mat);
  h.add(palm);
  for (let i = 0; i < 4; i++) {
    const finger = new THREE.Mesh(rbox(0.05, 0.019, 0.028, 0.008), mat);
    finger.position.set(0, 0.031 - i * 0.021, -0.046);
    h.add(finger);
  }
  const thumb = new THREE.Mesh(rbox(0.022, 0.05, 0.026, 0.009), mat);
  thumb.position.set(mirror * 0.03, 0.012, 0.028);
  thumb.rotation.x = 0.4;
  h.add(thumb);
  h.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
  return h;
}

function buildWeapon(vmScene) {
  const group = new THREE.Group();
  // rifle() is modelled facing -z, the same way the camera looks, so the barrel already points
  // downrange — no flip. Scaled to sit in the corner rather than fill the screen.
  const gun = rifle(0.72);
  // A lit dot on the optic: one emissive speck, but it makes the gun look like equipment
  // rather than a prop, and it sits on the crosshair line the sim actually shoots along.
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.008, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff5544 }),
  );
  dot.position.set(0, 0.077, -0.05);
  const hand = new THREE.Mesh(
    new THREE.BoxGeometry(0.075, 0.075, 0.16),
    new THREE.MeshStandardMaterial({ color: 0x8a6a4e, roughness: 0.9 }),
  );
  hand.position.set(0, -0.075, 0.06);
  group.add(gun, dot, hand);
  vmScene.add(group);
  return { group, gun };
}

function buildMuzzle(scene, vmScene) {
  const vm = sprite(SPRITES.flash, 0.3);
  vm.position.set(0.15, -0.21, -1.4);
  vm.visible = false;
  vmScene.add(vm); // viewmodel scene is not AO'd, so no layer needed
  const light = new THREE.PointLight(0xffd88a, 0, 9, 2);
  scene.add(light);
  return { vm, light };
}

// A blocky operator: legs that swing, a torso, a head with a visor, and the same rifle the
// viewmodel uses, so teammates and enemies are recognisably holding what you are holding.
// An operator, articulated rather than assembled: every limb hangs from a pivot at its joint,
// with a sphere at each joint so the seam never opens up when it swings. Blocks stacked with
// gaps are what made the old figure read as a toy — the geometry budget is the same, the
// difference is entirely in where the rotation happens.
//
// Proportions follow a 1.8 m soldier: boot 0.10, shin to 0.48, hip 0.92, shoulders 1.42,
// crown 1.78. Gear is in the agent's colour for readability; fatigues are desaturated toward
// grey so a squad doesn't look like four traffic cones.
function buildFigure(color, outline) {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const c = hex(color);
  // The tag palette is tuned to read as text on a dark panel, so its lightest entries are
  // near-white. Capping luminance keeps each agent's hue distinct while stopping the pale
  // ones from rendering as a ghost across a whole body.
  const cap = (col, max) => {
    const lum = 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
    return lum > max ? col.multiplyScalar(max / lum) : col;
  };
  const muted = cap(c.clone(), 0.5).lerp(new THREE.Color(0x585852), 0.45);

  // The tag colour is tuned to read as text on a dark panel, which is too bright for a
  // whole torso, so the gear sits a step below it while staying the same hue.
  const gear = new THREE.MeshStandardMaterial({ color: cap(c.clone(), 0.42), roughness: 0.65 });
  const cloth = new THREE.MeshStandardMaterial({ color: muted, roughness: 0.92 });
  const webbing = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.95 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 1 });
  // Balaclava rather than a blank face: a featureless head sphere is the tell that a model
  // was generated. Covered, the goggles become the focal point instead.
  const skin = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.95 });

  const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  const ball = (r, mat) => new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), mat);
  // A limb hangs below its pivot, so rotating the pivot swings it from the joint.
  const segment = (r, length, mat) => {
    const pivot = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.02, length - r * 2), 4, 10), mat);
    mesh.position.y = -length / 2;
    pivot.add(mesh);
    return pivot;
  };

  // ---- legs ----
  const legs = {};
  for (const [side, sign] of [['L', -1], ['R', 1]]) {
    const hip = segment(0.085, 0.44, cloth);
    hip.position.set(sign * 0.105, 0.92, 0);
    hip.add(ball(0.095, cloth)); // hip joint
    const knee = segment(0.072, 0.38, cloth);
    knee.position.y = -0.44;
    const kneeBall = ball(0.076, cloth);
    knee.add(kneeBall);
    const pad = new THREE.Mesh(rbox(0.15, 0.13, 0.07, 0.03), webbing);
    pad.position.set(0, -0.04, -0.065);
    knee.add(pad);
    const pouch = new THREE.Mesh(rbox(0.1, 0.16, 0.07, 0.025), webbing);
    pouch.position.set(sign * 0.09, -0.18, 0.02);
    hip.add(pouch);
    const boot = new THREE.Mesh(rbox(0.145, 0.115, 0.29, 0.035), rubber);
    boot.position.set(0, -0.375, -0.045);
    knee.add(boot);
    hip.add(knee);
    body.add(hip);
    legs[`hip${side}`] = hip;
    legs[`knee${side}`] = knee;
  }

  // ---- torso ----
  // A torso is a tapered barrel, not a slab: an 8-sided cylinder that narrows at the waist
  // gives the silhouette a waist and shoulders, and rounds off against the light.
  const pelvis = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.145, 0.2, 10), cloth);
  pelvis.position.y = 1.0;
  pelvis.scale.z = 0.78;
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.163, 0.163, 0.062, 10), webbing);
  belt.position.y = 0.94;
  belt.scale.z = 0.8;
  const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.155, 0.38, 10), cloth);
  chest.position.y = 1.26;
  chest.scale.z = 0.72;
  // The plate carrier is the silhouette: a curved front and back plate, not a box.
  const vest = new THREE.Mesh(rbox(0.4, 0.34, 0.27, 0.06), gear);
  vest.position.y = 1.27;
  const pouches = new THREE.Mesh(rbox(0.3, 0.1, 0.09, 0.03), webbing);
  pouches.position.set(0, 1.13, -0.15);
  const pack = new THREE.Mesh(rbox(0.28, 0.3, 0.14, 0.05), webbing);
  pack.position.set(0, 1.26, 0.17);
  const straps = [];
  for (const sx of [-0.12, 0.12]) {
    const strap = new THREE.Mesh(rbox(0.075, 0.17, 0.3, 0.03), webbing);
    strap.position.set(sx, 1.42, 0);
    straps.push(strap);
  }

  // ---- head ----
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.07, 0.1, 8), skin);
  neck.position.y = 1.48;
  const head = ball(0.115, skin);
  head.scale.set(1, 1.12, 1.02);
  head.position.y = 1.62;
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.135, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), gear);
  helmet.position.y = 1.635;
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.137, 0.137, 0.035, 16), gear);
  brim.position.y = 1.632;
  const goggles = new THREE.Mesh(rbox(0.2, 0.058, 0.05, 0.022), new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.2, metalness: 0.8 }));
  goggles.position.set(0, 1.645, -0.09);
  // Ear cups break the bare-sphere read of the helmet.
  const ears = [];
  for (const sx of [-1, 1]) {
    const cup = new THREE.Mesh(rbox(0.045, 0.085, 0.08, 0.02), webbing);
    cup.position.set(sx * 0.115, 1.6, -0.01);
    ears.push(cup);
  }

  // ---- arms, solved onto the weapon ----
  // The weapon is placed first, in a real carry stance, and the arms are then solved to reach
  // its grip and handguard. Posing the two independently is what made the old figures look
  // like they were miming: the hands simply never arrived at the gun.
  // Weapon and both arms live in one rig, so aiming, lowering and recoil move them together
  // instead of the gun drifting away from the hands.
  // The rig pivots at the chest, not at the origin between the feet: rotating it about the
  // feet swung the arms through a 1.4 m lever and threw the weapon across the body. An inner
  // group cancels the offset so parts keep their natural head-height coordinates.
  const rig = new THREE.Group();
  rig.position.y = 1.35;
  const rigInner = new THREE.Group();
  rigInner.position.y = -1.35;
  rig.add(rigInner);
  body.add(rig);
  const gun = rifle(0.85);
  // Shouldered on the right, not centred: on the centreline the trigger arm has to reach
  // across the chest and its forearm ends up inside the torso.
  gun.position.set(0.15, 1.22, -0.16);
  gun.rotation.set(-0.02, 0.13, 0.04);
  rigInner.add(gun);
  gun.updateMatrixWorld(true);

  const arms = {};
  const L1 = 0.28;
  const L2 = 0.26;
  for (const [side, sign, landmark] of [['R', 1, GRIP], ['L', -1, HANDGUARD]]) {
    const shoulder = segment(0.068, L1, cloth);
    shoulder.position.set(sign * 0.2, 1.4, 0);
    shoulder.add(ball(0.078, webbing)); // pauldron: covers the shoulder seam
    const forearm = segment(0.056, L2, cloth);
    forearm.position.y = -L1;
    forearm.add(ball(0.058, cloth)); // elbow
    const hand = fist(webbing, sign);
    hand.position.y = -L2 - 0.02;
    hand.rotation.x = -Math.PI / 2; // knuckles forward, so the fist wraps the weapon
    forearm.add(hand);
    shoulder.add(forearm);
    rigInner.add(shoulder);
    // Elbows swing out and down, the way they do on a shouldered rifle.
    reachFor(shoulder, forearm, L1, L2, gun.localToWorld(landmark.clone()),
      sign > 0 ? new THREE.Vector3(1.05, -1, 0.45) : new THREE.Vector3(-0.85, -0.9, 0.1));
    arms[`arm${side}`] = shoulder;
  }

  // Sheathed knife on the off-side thigh, and a holstered sidearm on the belt: small, but
  // they are the difference between a soldier and a mannequin holding a rifle.
  const sheath = box(0.07, 0.24, 0.05, webbing);
  sheath.position.set(-0.19, 0.78, 0.04);
  sheath.rotation.z = 0.12;
  const hilt = box(0.035, 0.11, 0.035, new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.5, metalness: 0.4 }));
  hilt.position.set(-0.20, 0.94, 0.04);
  const holster = box(0.10, 0.17, 0.07, webbing);
  holster.position.set(0.20, 0.82, 0.03);
  const pistol = box(0.05, 0.09, 0.04, new THREE.MeshStandardMaterial({ color: 0x23272d, roughness: 0.5, metalness: 0.55 }));
  pistol.position.set(0.20, 0.94, 0.03);

  // Flash at the actual muzzle, taken from the weapon's own landmark rather than guessed.
  const flash = sprite(SPRITES.flash, 0.5);
  flash.position.copy(gun.localToWorld(MUZZLE.clone()));
  body.worldToLocal(flash.position);
  markFx(flash);
  flash.visible = false;
  rigInner.add(flash);

  body.add(pelvis, belt, chest, vest, pouches, pack, ...straps, neck, head, helmet, brim, goggles,
    ...ears, sheath, hilt, holster, pistol);
  body.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  const blob = blobShadow(); // stays on the floor while the body bobs
  blob.castShadow = false;
  group.add(blob);

  return {
    group,
    parts: { ...legs, ...arms, rig, body, flash },
    phase: 0,
    lastPos: null,
  };
}

// Two-bone IK. Bones hang along their own -Y, so the shoulder is given a basis whose -Y points
// at the elbow and whose X is the bend axis; the forearm then bends about its local X alone.
// The pole vector decides which way the elbow breaks, which is the difference between a
// natural stance and a broken-looking one.
const IK = { to: new THREE.Vector3(), pole: new THREE.Vector3(), x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3(), m: new THREE.Matrix4() };
function reachFor(shoulder, forearm, L1, L2, targetWorld, poleHint) {
  const target = shoulder.parent.worldToLocal(targetWorld.clone()).sub(shoulder.position);
  const d = Math.min(target.length(), (L1 + L2) * 0.998) || 1e-4;
  IK.to.copy(target).normalize();
  const a = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const b = Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
  IK.pole.copy(poleHint).normalize();
  IK.x.crossVectors(IK.pole, IK.to).normalize();
  if (!IK.x.lengthSq()) IK.x.set(1, 0, 0);
  // Upper arm direction: the straight-line direction swung out by the shoulder angle.
  const upper = IK.to.clone().applyAxisAngle(IK.x, -a);
  IK.y.copy(upper).negate();                       // local -Y runs down the bone
  IK.z.crossVectors(IK.x, IK.y).normalize();
  IK.m.makeBasis(IK.x, IK.y, IK.z);
  shoulder.quaternion.setFromRotationMatrix(IK.m);
  forearm.rotation.set(Math.PI - b, 0, 0);
  return { a, b };
}

// Three poses, the way a tac-shooter reads at a glance: running with the weapon dropped off
// the shoulder, standing at the ready, and firing with the muzzle up and the body absorbing
// recoil. The arms are IK-solved onto the weapon once at build time, so animating the rig
// moves the whole grip together and the hands never come off the gun.
// Materials are built per figure, so dimming one never touches another.
const HURT = new THREE.Color(0xff2412);
// A hit is otherwise invisible from in here: the health bar is on the overlay, at the edge of
// vision, during the one moment you are least able to read it. Flashing the body itself puts
// the information where you are already looking. Each figure owns its materials, so tinting
// one never touches another.
function setFigureHurt(f, amount) {
  if (f.hurtShown === amount) return;
  f.hurtShown = amount;
  f.group.traverse(o => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) {
      if (!m.emissive) continue;
      if (m.userData.baseEmissive === undefined) m.userData.baseEmissive = m.emissive.getHex();
      m.emissive.setHex(m.userData.baseEmissive).lerp(HURT, amount);
    }
  });
}

function setFigureAlpha(f, alpha) {
  if (f.alpha === alpha) return;
  f.alpha = alpha;
  f.group.traverse(o => {
    if (!o.isMesh && !o.isSprite) return;
    for (const m of [].concat(o.material)) {
      if (m.userData.baseOpacity === undefined) m.userData.baseOpacity = m.opacity;
      m.opacity = m.userData.baseOpacity * alpha;
      m.transparent = m.transparent || alpha < 1;
      m.depthWrite = alpha > 0.98 ? m.userData.baseDepthWrite ?? m.depthWrite : false;
      if (m.userData.baseDepthWrite === undefined) m.userData.baseDepthWrite = m.depthWrite;
    }
  });
}

function stepGait(f, walking, firing, dt, effort = 1) {
  const p = f.parts;
  f.phase += dt * (walking ? 8.5 * effort : 1.6);
  const s = Math.sin(f.phase);
  const swing = walking ? 0.46 * effort : 0.03;
  p.hipL.rotation.x = s * swing;
  p.hipR.rotation.x = -s * swing;
  // Knees only bend one way, and mostly as the leg trails behind.
  p.kneeL.rotation.x = -Math.max(0, -s) * (walking ? 0.5 : 0.05) - 0.04;
  p.kneeR.rotation.x = -Math.max(0, s) * (walking ? 0.5 : 0.05) - 0.04;
  // Weight transfer: two small rises per stride.
  p.body.position.y = walking ? Math.abs(Math.cos(f.phase)) * 0.035 : 0;

  // firing is a short window per shot, so let the kick decay even while it stays true;
  // holding it at 1 pinned the weapon at full deflection.
  f.kick = Math.max(0, (f.kick ?? 0) - dt * 9);
  if (firing && f.kick < 0.35) f.kick = 1;
  // Running drops the muzzle; firing snaps it up and rocks the shoulders back.
  // A careful walk keeps the weapon up; a sprint drops it. That is the whole visual tell
  // that an agent is clearing ground rather than crossing it.
  const target = firing ? 0.02 : walking ? -0.4 * effort : -0.06;
  f.aim = (f.aim ?? target) + (target - (f.aim ?? target)) * Math.min(1, dt * 9);
  p.rig.rotation.x = f.aim - f.kick * 0.13;
  p.rig.rotation.z = (walking && !firing ? 0.12 : 0) + f.kick * 0.04;
  p.rig.position.z = f.kick * 0.035;
  // A walking figure swings the weapon side to side a little; a firing one is locked in.
  p.rig.rotation.y = walking && !firing ? s * 0.07 : 0;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap = a => ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
