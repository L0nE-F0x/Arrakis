import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { getGroundHeight, WATER_LEVEL } from './terrainMath.js';

const DIRECTOR_DURATION = 42.0; // seconds per full cinematic loop
const GROUND_CLEARANCE = 0.35;

// Scratch vectors for zero-allocation per-frame updates
const _camPos = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function safeY(x, z, y) {
  const floor = Math.max(getGroundHeight(x, z), WATER_LEVEL);
  return Math.max(y, floor + GROUND_CLEARANCE);
}

function buildPresets() {
  const floraCamY = getGroundHeight(6.75, 6.45) + 0.84;
  const floraTgtY = getGroundHeight(3.85, 3.95) + 0.54;
  const nightBloomCamY = getGroundHeight(3.35, 12.35) + 0.78;
  const nightCisternCamY = getGroundHeight(0.25, 13.4) + 0.88;
  const canopyCamY = getGroundHeight(5.15, -9.8) + 0.92;
  const bloomingRidgeCamY = getGroundHeight(1.6, -21.2) + 1.18;
  const muaddibCamY = getGroundHeight(3.86, 10.06) + 0.36;
  const muaddibTgtY = getGroundHeight(3.16, 8.92) + 0.14;

  return {
    cistern: {
      position: new THREE.Vector3(0.55, safeY(0.55, 13.6, 1.78), 13.6),
      target: new THREE.Vector3(0.2, 1.85, -18.0),
      caption: { kicker: 'SIETCH DEW BASIN', title: 'First Light Over the Qanat Cistern' }
    },
    flora: {
      position: new THREE.Vector3(6.75, safeY(6.75, 6.45, floraCamY), 6.45),
      target: new THREE.Vector3(3.85, floraTgtY, 3.95),
      caption: { kicker: 'QANAT RIPARIAN EDGE', title: 'Inkvine, Agave & Condensation Flora' }
    },
    nightBloom: {
      position: new THREE.Vector3(3.35, safeY(3.35, 12.35, nightBloomCamY), 12.35),
      target: new THREE.Vector3(-0.35, 4.6, -24.0),
      caption: { kicker: 'NOCTURNAL OASIS', title: 'Twin-Moon Reflections & Bioluminescent Blooms' }
    },
    nightCistern: {
      position: new THREE.Vector3(0.25, safeY(0.25, 13.4, nightCisternCamY), 13.4),
      target: new THREE.Vector3(0.4, 6.8, -36.0),
      caption: { kicker: 'ASTRAL MIRROR', title: 'Twin Moons & Starlight Reflected in the Cistern' }
    },
    canopy: {
      position: new THREE.Vector3(5.15, safeY(5.15, -9.8, canopyCamY), -9.8),
      target: new THREE.Vector3(2.4, 15.8, -28.0),
      caption: { kicker: 'TAMARISK CANOPY', title: 'Twin Moons & Sister Planet Through Desert Crown' }
    },
    bloomingRidge: {
      position: new THREE.Vector3(1.6, safeY(1.6, -21.2, bloomingRidgeCamY), -21.2),
      target: new THREE.Vector3(-1.5, 6.2, -135.0),
      caption: { kicker: 'OASIS MARGIN', title: 'Great Erg Beyond the Blooming Ridge' }
    },
    ridge: {
      position: new THREE.Vector3(4.2, safeY(4.2, -33.5, 8.2), -33.5),
      target: new THREE.Vector3(-8.5, 6.8, -142.0),
      caption: { kicker: 'THE GREAT ERG', title: 'Star Dune Crests & Endless Horizon' }
    },
    horizon: {
      position: new THREE.Vector3(-3.2, safeY(-3.2, -37.5, 8.2), -37.5),
      target: new THREE.Vector3(0.0, 29.0, -260.0),
      caption: { kicker: 'ARRAKIS SKYLINE', title: 'Canopus, Twin Moons & Sister Planet' }
    },
    yardang: {
      position: new THREE.Vector3(1.8, safeY(1.8, 13.2, 3.15), 13.2),
      target: new THREE.Vector3(-16.2, 4.8, -8.5),
      caption: { kicker: 'SANDSTONE YARDANGS', title: 'Wind-Carved Arch & Fremen Badgir Spire' }
    },
    muaddib: {
      position: new THREE.Vector3(3.86, safeY(3.86, 10.06, muaddibCamY), 10.06),
      target: new THREE.Vector3(3.16, muaddibTgtY, 8.92),
      caption: { kicker: 'DESERT ECOLOGY', title: "Muad'Dib Foraging Beside Moisture Flora" }
    },
    worm: {
      position: new THREE.Vector3(-2.0, safeY(-2.0, -24.0, 9.5), -24.0),
      target: new THREE.Vector3(14.0, 13.5, -108.0),
      caption: { kicker: 'SHAI-HULUD', title: 'Deep-Erg Elder Maker Breach & Sand Plume' }
    },
    spice: {
      position: new THREE.Vector3(-4.5, safeY(-4.5, -26.0, 9.8), -26.0),
      target: new THREE.Vector3(-22.5, 11.8, -70.0),
      caption: { kicker: 'MÉLANGE VEIN', title: 'Pre-Spice Blow & Swirling Dust Devils' }
    },
    camp: {
      position: new THREE.Vector3(-8.8, safeY(-8.8, 9.6, getGroundHeight(-8.8, 9.6) + 1.85), 9.6),
      target: new THREE.Vector3(-14.8, getGroundHeight(-14.5, 5.5) + 1.15, 5.2),
      caption: { kicker: 'FREMEN BIVOUAC', title: 'Yardang Sanctuary Camp & Spice-Oil Brazier' }
    },
    ornithopter: {
      position: new THREE.Vector3(15.2, safeY(15.2, -45.5, getGroundHeight(15.2, -45.5) + 2.8), -45.5),
      target: new THREE.Vector3(26.0, getGroundHeight(26.0, -56.0) + 1.2, -56.0),
      caption: { kicker: 'IMPERIAL RELIC', title: 'Downed Ornithopter Half-Claimed by the Erg' }
    },
    footprints: {
      position: new THREE.Vector3(4.6, safeY(4.6, -26.2, getGroundHeight(4.6, -26.2) + 0.95), -26.2),
      target: new THREE.Vector3(2.6, getGroundHeight(2.6, -33.0) + 0.25, -33.0),
      caption: { kicker: 'FREMEN SANDWALK', title: 'Displaced Boot Prints & Wind-Swept Slipface' }
    },
    spiceCrater: {
      position: new THREE.Vector3(-13.2, safeY(-13.2, -60.2, getGroundHeight(-13.2, -60.2) + 1.65), -60.2),
      target: new THREE.Vector3(-21.0, getGroundHeight(-21.0, -68.0) + 0.35, -68.0),
      caption: { kicker: 'PRE-SPICE BLOW', title: 'Crystalline Mélange Seams & Cinnamon Plume' }
    }
  };
}

function buildDirectorCurves() {
  const waypoints = [
    // Leg 1: SIETCH DEW BASIN (framed so Windtrap finial sits cleanly beside top-left HUD badge!)
    {
      pos: [1.15, safeY(1.15, 13.6, 1.82), 13.6],
      tgt: [-1.2, 1.95, -18.0]
    },
    {
      pos: [2.6, safeY(2.6, 13.4, getGroundHeight(2.6, 13.4) + 0.72), 13.4],
      tgt: [1.4, 1.35, -7.5]
    },
    // Leg 2: WINDTRAP QANAT PATH (low shoreline glide y ~ terrain + 0.9m)
    {
      pos: [4.5, safeY(4.5, 10.5, getGroundHeight(4.5, 10.5) + 0.9), 10.5],
      tgt: [2.3, getGroundHeight(2.3, 4.8) + 0.55, 4.8]
    },
    {
      pos: [6.2, safeY(6.2, 2.5, getGroundHeight(6.2, 2.5) + 0.9), 2.5],
      tgt: [3.2, getGroundHeight(3.2, -1.6) + 0.6, -1.6]
    },
    {
      pos: [4.6, safeY(4.6, -6.5, getGroundHeight(4.6, -6.5) + 0.9), -6.5],
      tgt: [1.5, 2.0, -15.5]
    },
    // Leg 3: ARRAKIS SKYLINE (sweeps slightly upward looking skyward)
    {
      pos: [4.8, safeY(4.8, -11.5, 3.6), -11.5],
      tgt: [-3.0, 14.0, -36.0]
    },
    {
      pos: [1.8, safeY(1.8, -18.5, 5.1), -18.5],
      tgt: [-1.4, 9.2, -78.0]
    },
    // Leg 4: THE GREAT ERG (crests ridge overlooking endless dunes)
    {
      pos: [-1.2, safeY(-1.2, -24.5, 6.2), -24.5],
      tgt: [0.0, 3.5, -135.0]
    },
    // Soft aerial glide back over western cistern rim
    {
      pos: [-3.6, safeY(-3.6, -9.0, 4.6), -9.0],
      tgt: [0.0, 1.8, -4.0]
    },
    {
      pos: [-2.1, safeY(-2.1, 8.5, 2.9), 8.5],
      tgt: [0.2, 1.5, -12.0]
    }
  ];

  const posCurve = new THREE.CatmullRomCurve3(
    waypoints.map(w => new THREE.Vector3(...w.pos)),
    true,
    'catmullrom',
    0.5
  );
  const tgtCurve = new THREE.CatmullRomCurve3(
    waypoints.map(w => new THREE.Vector3(...w.tgt)),
    true,
    'catmullrom',
    0.5
  );

  return { posCurve, tgtCurve };
}

export function createCameraController(camera, domElement, worldState, playerController = null) {
  const presets = buildPresets();
  const { posCurve, tgtCurve } = buildDirectorCurves();

  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.065;
  controls.rotateSpeed = 0.72;
  controls.panSpeed = 0.75;
  controls.zoomSpeed = 0.9;
  controls.minDistance = 0.8;
  controls.maxDistance = 420;
  controls.maxPolarAngle = Math.PI * 0.94;
  controls.minPolarAngle = 0.06;

  let mode = worldState.cameraMode || 'director';
  let directorElapsed = 0;
  let directorParamT = 0;

  // Smooth preset transition state
  const transition = {
    active: false,
    progress: 1,
    duration: 0.9,
    fromPos: new THREE.Vector3(),
    fromTarget: new THREE.Vector3(),
    toPos: new THREE.Vector3(),
    toTarget: new THREE.Vector3()
  };

  // Free-camera WASD / Arrow key state
  const keys = new Set();
  const onKeyDown = e => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (
      e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD' ||
      e.code === 'KeyQ' || e.code === 'KeyE' || e.code === 'ShiftLeft' || e.code === 'ShiftRight' ||
      e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight'
    ) {
      keys.add(e.code);
    }
  };
  const onKeyUp = e => keys.delete(e.code);
  const onBlur = () => keys.clear();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  // If user interacts with OrbitControls during a transition, hand over cleanly
  const onControlStart = () => {
    transition.active = false;
  };
  controls.addEventListener('start', onControlStart);

  function clampCameraAboveTerrain() {
    camera.position.x = THREE.MathUtils.clamp(camera.position.x, -175, 175);
    camera.position.z = THREE.MathUtils.clamp(camera.position.z, -210, 85);
    const minY = safeY(camera.position.x, camera.position.z, -Infinity);
    if (camera.position.y < minY) {
      camera.position.y = minY;
    }
    controls.target.y = Math.max(controls.target.y, -4.0);
  }

  function evalDirectorAt(phaseSec, outPos, outTgt) {
    const u = ((phaseSec / DIRECTOR_DURATION) % 1 + 1) % 1;
    const t = posCurve.getUtoTmapping(u, u);
    directorParamT = t;
    posCurve.getPoint(t, outPos);
    tgtCurve.getPoint(t, outTgt);
    const minY = safeY(outPos.x, outPos.z, -Infinity);
    if (outPos.y < minY) outPos.y = minY;
  }

  function setPreset(name, instant = false) {
    const validName =
      name === 'walk' || name === 'director' || name === 'free' || presets[name] ? name : 'director';
    const prevMode = mode;
    mode = validName;
    worldState.cameraMode = validName;

    if (prevMode === 'walk' && validName !== 'walk') {
      playerController?.exitWalkMode?.();
    }

    if (validName === 'walk') {
      controls.enabled = false;
      transition.active = false;
      const dropFromHere = prevMode === 'free' && camera.position.y < getGroundHeight(camera.position.x, camera.position.z) + 18.0;
      playerController?.enterWalkMode?.(dropFromHere);
      return;
    }

    if (validName === 'director') {
      controls.enabled = false;
      if (instant) {
        directorElapsed = 0;
        evalDirectorAt(0, _camPos, _targetPos);
        camera.position.copy(_camPos);
        controls.target.copy(_targetPos);
        camera.lookAt(controls.target);
        transition.active = false;
      } else {
        // Blend smoothly into current director pose
        evalDirectorAt(directorElapsed, _camPos, _targetPos);
        transition.active = true;
        transition.progress = 0;
        transition.fromPos.copy(camera.position);
        transition.fromTarget.copy(controls.target);
        transition.toPos.copy(_camPos);
        transition.toTarget.copy(_targetPos);
      }
      return;
    }

    controls.enabled = true;

    if (validName === 'free') {
      transition.active = false;
      if (instant && prevMode === 'director') {
        // Place free orbit at cistern overlook when snapped directly
        const p = presets.cistern;
        camera.position.copy(p.position);
        controls.target.copy(p.target);
      } else {
        // Preserve current camera view direction seamlessly when switching to Free Orbit
        camera.getWorldDirection(_forward);
        controls.target.copy(camera.position).addScaledVector(_forward, 12.0);
      }
      clampCameraAboveTerrain();
      camera.lookAt(controls.target);
      controls.update();
      return;
    }

    const preset = presets[validName];
    // Clear any residual OrbitControls damping inertia before moving to a preset
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = true;

    if (instant) {
      transition.active = false;
      camera.position.copy(preset.position);
      controls.target.copy(preset.target);
      clampCameraAboveTerrain();
      camera.lookAt(controls.target);
      controls.update();
    } else {
      transition.active = true;
      transition.progress = 0;
      transition.fromPos.copy(camera.position);
      transition.fromTarget.copy(controls.target);
      transition.toPos.copy(preset.position);
      transition.toTarget.copy(preset.target);
    }
  }

  function update(dt) {
    const step = Math.min(Math.max(dt, 0), 0.1);

    if (mode === 'walk') {
      playerController?.update?.(step);
      return;
    }

    if (mode === 'director') {
      if (!worldState.paused) {
        directorElapsed = (directorElapsed + step) % DIRECTOR_DURATION;
      }
      evalDirectorAt(directorElapsed, _camPos, _targetPos);

      if (transition.active) {
        transition.progress = Math.min(1, transition.progress + step / transition.duration);
        const s = transition.progress * transition.progress * (3 - 2 * transition.progress);
        camera.position.lerpVectors(transition.fromPos, _camPos, s);
        controls.target.lerpVectors(transition.fromTarget, _targetPos, s);
        if (transition.progress >= 1) transition.active = false;
      } else {
        camera.position.copy(_camPos);
        controls.target.copy(_targetPos);
      }

      // Ultra-subtle desert wind / sandworm tremor feel on open Erg legs
      if (worldState.worm.tremor > 0.35) {
        const rumble = (worldState.worm.tremor - 0.35) * 0.018;
        camera.position.x += Math.sin(worldState.elapsed * 29.0) * rumble;
        camera.position.y += Math.cos(worldState.elapsed * 37.0) * rumble * 0.6;
      }

      clampCameraAboveTerrain();
      camera.lookAt(controls.target);
      return;
    }

    // Transition ease for named presets
    if (transition.active) {
      transition.progress = Math.min(1, transition.progress + step / transition.duration);
      const s = transition.progress * transition.progress * (3 - 2 * transition.progress);
      camera.position.lerpVectors(transition.fromPos, transition.toPos, s);
      controls.target.lerpVectors(transition.fromTarget, transition.toTarget, s);
      clampCameraAboveTerrain();
      camera.lookAt(controls.target);
      if (transition.progress >= 1) {
        transition.active = false;
        controls.enableDamping = false;
        controls.update();
        controls.enableDamping = true;
      }
      return;
    }

    // Free-cam WASD / Arrow glide
    if (mode === 'free' && keys.size > 0 && step > 0) {
      camera.getWorldDirection(_forward);
      _forward.y = 0;
      if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, -1);
      _forward.normalize();
      _right.crossVectors(_forward, _up).normalize();

      _move.set(0, 0, 0);
      if (keys.has('KeyW') || keys.has('ArrowUp')) _move.add(_forward);
      if (keys.has('KeyS') || keys.has('ArrowDown')) _move.sub(_forward);
      if (keys.has('KeyD') || keys.has('ArrowRight')) _move.add(_right);
      if (keys.has('KeyA') || keys.has('ArrowLeft')) _move.sub(_right);
      if (keys.has('KeyE')) _move.y += 0.85;
      if (keys.has('KeyQ')) _move.y -= 0.85;

      if (_move.lengthSq() > 0) {
        const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.45 : 1.0;
        const speed = 12.5 * boost;
        _move.normalize().multiplyScalar(speed * step);
        camera.position.add(_move);
        controls.target.add(_move);
      }
    }

    controls.update();
    clampCameraAboveTerrain();
    // Keep glowglobe animated smoothly if still lit in Free Fly
    playerController?.update?.(step);
  }

  function getCaption() {
    if (mode === 'walk') {
      const p = worldState.player;
      if (p?.onOpenErg) {
        return {
          kicker: p.sandwalking ? 'GREAT ERG · SANDWALKING' : 'THE GREAT ERG · OPEN SAND',
          title: p.sliding ? 'Slipface Avalanche Slide' : p.sandwalking ? 'Walking Without Rhythm' : 'Rhythmic Steps Draw Shai-Hulud'
        };
      }
      if (p?.inWater) {
        return { kicker: 'SIETCH DEW CISTERN', title: 'Wading the Mirrored Qanat Spring' };
      }
      return { kicker: 'FREMEN ON FOOT', title: 'Desert Reconnaissance · WASD · C Sandwalk · T Thumper' };
    }

    if (mode === 'director') {
      if (directorParamT < 0.20 || directorParamT >= 0.88) {
        return { kicker: 'SIETCH DEW BASIN', title: 'First Light Over the Qanat Cistern' };
      }
      if (directorParamT < 0.48) {
        return { kicker: 'WINDTRAP QANAT PATH', title: 'Shoreline Flora & Condensation Runnels' };
      }
      if (directorParamT < 0.68) {
        return { kicker: 'ARRAKIS SKYLINE', title: 'Canopus, Twin Moons & Sandstone Overhangs' };
      }
      return { kicker: 'THE GREAT ERG', title: 'Endless Star Dunes & Shai-Hulud Territory' };
    }

    if (mode === 'free') {
      return { kicker: 'FREE ORBIT', title: 'Arrakis Reconnaissance · Drag & WASD Glide' };
    }

    return presets[mode]?.caption || presets.cistern.caption;
  }

  // Initialize cleanly into the initial camera mode
  setPreset(mode, true);

  return {
    setPreset,
    update,
    getCaption,
    controls,
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      controls.removeEventListener('start', onControlStart);
      controls.dispose();
    }
  };
}
