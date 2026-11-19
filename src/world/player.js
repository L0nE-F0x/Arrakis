import * as THREE from 'three';
import { getGroundHeight, getGroundNormal, getTerrainInfo, WATER_LEVEL, CISTERN_CENTER } from './terrainMath.js';
import { ARRAKIS_LANDMARKS } from '../state/worldState.js';

const STAND_EYE_HEIGHT = 1.66;
const CROUCH_EYE_HEIGHT = 0.94;
const GRAVITY = 15.8;
const JUMP_SPEED = 5.4;

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _moveDir = new THREE.Vector3();
const _groundNormal = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _lookDir = new THREE.Vector3();
const _rayPt = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function buildGlowglobeMesh() {
  const group = new THREE.Group();
  group.name = 'FremenSuspensorGlowglobe';

  // Delicate luminous amber suspensor orb (unlit MeshBasicMaterial so internal PointLight never blows out bloom!)
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.044, 18, 14),
    new THREE.MeshBasicMaterial({
      color: 0xffd07a
    })
  );
  group.add(core);

  // Filigree brushed-brass suspensor meridian rings (unlit-tinted metallic look unaffected by point-light singularity)
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xb8843f
  });
  const ringA = new THREE.Mesh(new THREE.TorusGeometry(0.064, 0.0055, 8, 28), ringMat);
  ringA.rotation.x = Math.PI * 0.35;
  group.add(ringA);

  const ringB = new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.0045, 8, 28), ringMat);
  ringB.rotation.y = Math.PI * 0.42;
  ringB.rotation.x = -Math.PI * 0.22;
  group.add(ringB);

  // Soft radial feathered suspensor halo sprite (zero hard sphere shell edge!)
  const haloCanvas = document.createElement('canvas');
  haloCanvas.width = 64;
  haloCanvas.height = 64;
  const hCtx = haloCanvas.getContext('2d');
  const hGrad = hCtx.createRadialGradient(32, 32, 2, 32, 32, 31);
  hGrad.addColorStop(0.0, 'rgba(255, 224, 158, 0.75)');
  hGrad.addColorStop(0.35, 'rgba(255, 168, 72, 0.28)');
  hGrad.addColorStop(1.0, 'rgba(255, 130, 32, 0.0)');
  hCtx.fillStyle = hGrad;
  hCtx.fillRect(0, 0, 64, 64);
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(haloCanvas),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
  );
  halo.scale.set(0.32, 0.32, 1.0);
  group.add(halo);
  group.scale.setScalar(0.76);

  // Real dynamic PointLight illuminating desert night, footprints & canyon rock
  const light = new THREE.PointLight(0xffb458, 12.0, 28.0, 1.5);
  light.position.set(0, -0.05, 0);
  group.add(light);

  group.visible = false;
  return { group, ringA, ringB, light, core };
}

function buildThumperAimReticle() {
  const group = new THREE.Group();
  group.name = 'ThumperAimReticle';

  const outerMat = new THREE.MeshBasicMaterial({
    color: 0xffc870,
    transparent: true,
    opacity: 0.82,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  const outerRing = new THREE.Mesh(new THREE.RingGeometry(0.58, 0.72, 32), outerMat);
  outerRing.rotation.x = -Math.PI * 0.5;
  group.add(outerRing);

  const innerRing = new THREE.Mesh(
    new THREE.RingGeometry(0.14, 0.22, 24),
    new THREE.MeshBasicMaterial({
      color: 0x5cc0ff,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false
    })
  );
  innerRing.rotation.x = -Math.PI * 0.5;
  group.add(innerRing);

  // Vertical spike guide shaft preview
  const guide = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.04, 1.1, 8),
    new THREE.MeshBasicMaterial({
      color: 0x5cc0ff,
      transparent: true,
      opacity: 0.42,
      depthWrite: false
    })
  );
  guide.position.y = 0.55;
  group.add(guide);

  group.visible = false;
  return { group, outerRing, outerMat, innerRing };
}

export function createPlayerController({
  camera,
  domElement,
  scene,
  worldState,
  sandTrails,
  atmosphereFX,
  soundscape,
  colliders = [],
  interactables = [],
  onDiscovery = null
}) {
  const pState = worldState.player;

  // Glowglobe & Thumper aim preview added directly to scene
  const glowglobe = buildGlowglobeMesh();
  const aimReticle = buildThumperAimReticle();
  scene.add(glowglobe.group);
  scene.add(aimReticle.group);

  const keys = new Set();
  let draggingLook = false;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let rightMouseDown = false;
  let opticsToggle = false;
  let opticsTargetZoom = 2.6;

  // Footstep / stride phase tracking
  let stepDistAccum = 0;
  let nextStepInterval = 1.45;
  let leftFoot = true;
  let headBobPhase = 0;
  let curEyeHeight = STAND_EYE_HEIGHT;
  let landingDip = 0;
  let rollAngle = 0;
  let slideFurrowCooldown = 0;
  let waterRippleCooldown = 0;
  let seismicSampleTimer = 0;
  let thumperAimPos = new THREE.Vector3();
  let thumperAimValid = false;
  let activeInteractable = null;

  function placeAtDefaultStart(fromCamera = false) {
    if (fromCamera) {
      const cx = clamp(camera.position.x, -165, 165);
      const cz = clamp(camera.position.z, -195, 75);
      const gy = Math.max(getGroundHeight(cx, cz), WATER_LEVEL - 0.35);
      pState.feetPosition.set(cx, gy, cz);
      // Extract yaw/pitch from current camera forward vector
      camera.getWorldDirection(_lookDir);
      pState.yaw = Math.atan2(-_lookDir.x, -_lookDir.z);
      pState.pitch = clamp(Math.asin(clamp(_lookDir.y, -0.95, 0.95)), -1.38, 1.38);
    } else {
      const sx = 0.55;
      const sz = 13.8;
      const gy = getGroundHeight(sx, sz);
      pState.feetPosition.set(sx, gy, sz);
      pState.yaw = 0.02;
      pState.pitch = -0.02;
    }
    pState.velocity.set(0, 0, 0);
    pState.grounded = true;
    pState.crouching = false;
    pState.sliding = false;
    curEyeHeight = STAND_EYE_HEIGHT;
    pState.position.set(pState.feetPosition.x, pState.feetPosition.y + curEyeHeight, pState.feetPosition.z);
    pState.glowglobePos.copy(pState.position).add(new THREE.Vector3(-0.6, 0.35, -0.7));
  }

  function enterWalkMode(fromCurrentCamera = true) {
    pState.active = true;
    placeAtDefaultStart(fromCurrentCamera);
    soundscape?.ensureStarted?.();
  }

  function exitWalkMode() {
    pState.active = false;
    pState.thumperAiming = false;
    pState.opticsActive = false;
    pState.opticsZoom = 1.0;
    pState.nearbyPrompt = null;
    opticsToggle = false;
    rightMouseDown = false;
    aimReticle.group.visible = false;
    soundscape?.setSlideIntensity?.(0);
    if (document.pointerLockElement === domElement) {
      document.exitPointerLock?.();
    }
    camera.fov = 48;
    camera.updateProjectionMatrix();
  }

  function requestPointerLock() {
    if (!pState.active) return;
    soundscape?.ensureStarted?.();
    if (document.pointerLockElement !== domElement && domElement.requestPointerLock) {
      try {
        const res = domElement.requestPointerLock();
        if (res && typeof res.catch === 'function') res.catch(() => {});
      } catch {}
    }
  }

  function raycastAimSand() {
    camera.getWorldDirection(_lookDir);
    // March forward from camera up to 16m to find terrain surface intersection
    let prevDiff = 1;
    for (let d = 1.6; d <= 16.0; d += 0.35) {
      _rayPt.copy(camera.position).addScaledVector(_lookDir, d);
      const gy = getGroundHeight(_rayPt.x, _rayPt.z);
      const diff = _rayPt.y - gy;
      if (diff <= 0 && prevDiff > 0) {
        const frac = prevDiff / (prevDiff - diff + 1e-5);
        const hitD = d - 0.35 * (1.0 - frac);
        _rayPt.copy(camera.position).addScaledVector(_lookDir, hitD);
        const info = getTerrainInfo(_rayPt.x, _rayPt.z);
        thumperAimPos.set(_rayPt.x, info.height, _rayPt.z);
        // Valid on dry sand (not deep water, not steep rock)
        thumperAimValid = !info.isWater && info.rockMask < 0.55;
        return true;
      }
      prevDiff = diff;
    }
    // Fallback: project 3.2m ahead on ground at feet level
    _forward.set(-Math.sin(pState.yaw), 0, -Math.cos(pState.yaw));
    const fx = pState.feetPosition.x + _forward.x * 3.2;
    const fz = pState.feetPosition.z + _forward.z * 3.2;
    const info = getTerrainInfo(fx, fz);
    thumperAimPos.set(fx, info.height, fz);
    thumperAimValid = !info.isWater && info.rockMask < 0.55;
    return true;
  }

  function plantThumperAt(x, z) {
    const gy = getGroundHeight(x, z);
    worldState.triggerThumper(x, z, true);
    sandTrails?.stampCrater?.(x, z, 0.85, 1.15);
    soundscape?.playThumperPlant?.();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      atmosphereFX?.spawnSandPuff?.(
        x + Math.cos(a) * 0.45,
        gy + 0.15,
        z + Math.sin(a) * 0.45,
        Math.cos(a) * 1.4,
        1.1 + Math.random() * 0.7,
        Math.sin(a) * 1.4,
        0.55
      );
    }
    worldState.pushToast(
      'THUMPER ACTIVATED',
      'Seismic Decoy Planted',
      'Rhythmic strikes echo deep into the Erg — watch the northern dunes for Wormsign.'
    );
  }

  function toggleGlowglobe() {
    pState.glowglobeOn = !pState.glowglobeOn;
    soundscape?.playGlowglobeToggle?.(pState.glowglobeOn);
    if (pState.glowglobeOn) {
      pState.glowglobePos.copy(pState.position).add(new THREE.Vector3(-0.65, 0.35, -0.75));
    }
  }

  function triggerInteract() {
    if (!pState.active || !activeInteractable) return;
    soundscape?.ensureStarted?.();
    const hooks = {
      onWaterDrink: (wx, wz) => {
        soundscape?.playWaterDrink?.();
        sandTrails?.addWaterRipple?.(wx, wz, 1.25);
        sandTrails?.addWaterRipple?.(CISTERN_CENTER.x + (wx - CISTERN_CENTER.x) * 0.65, CISTERN_CENTER.z + (wz - CISTERN_CENTER.z) * 0.65, 0.85);
      },
      onSpiceHarvest: (sx, sy, sz) => {
        soundscape?.playSpiceHarvest?.();
        atmosphereFX?.spawnSpiceBurst?.(sx, sy, sz);
      },
      onFeedMuadDib: () => {
        soundscape?.playDiscoveryChime?.();
      }
    };
    activeInteractable.onInteract?.(worldState, hooks);
  }

  // --- Input Event Listeners ---
  const onPointerLockChange = () => {
    pState.pointerLocked = document.pointerLockElement === domElement;
    if (!pState.pointerLocked) {
      draggingLook = false;
    }
  };

  const onMouseMove = (e) => {
    if (!pState.active) return;
    const zoomSens = 1.0 / Math.max(1.0, pState.opticsZoom);
    if (pState.pointerLocked) {
      const sens = 0.0021 * zoomSens;
      pState.yaw -= e.movementX * sens;
      pState.pitch = clamp(pState.pitch - e.movementY * sens, -1.42, 1.42);
    } else if (draggingLook) {
      const dx = e.clientX - lastMouseX;
      const dy = e.clientY - lastMouseY;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      const sens = 0.0034 * zoomSens;
      pState.yaw -= dx * sens;
      pState.pitch = clamp(pState.pitch - dy * sens, -1.42, 1.42);
    }
  };

  const onMouseDown = (e) => {
    if (!pState.active) return;
    if (e.target !== domElement) return;
    soundscape?.ensureStarted?.();

    if (e.button === 2) {
      // Right-click: cancel thumper aim OR hold Electro-Optics zoom!
      if (pState.thumperAiming) {
        pState.thumperAiming = false;
      } else {
        rightMouseDown = true;
      }
      return;
    }

    if (e.button === 0) {
      if (pState.thumperAiming) {
        raycastAimSand();
        if (thumperAimValid) {
          plantThumperAt(thumperAimPos.x, thumperAimPos.z);
          pState.thumperAiming = false;
        } else {
          worldState.pushToast('CANNOT PLANT', 'Solid Rock or Water', 'Aim at open sand to drive the Fremen Thumper.');
        }
        return;
      }
      if (!pState.pointerLocked) {
        draggingLook = true;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        requestPointerLock();
      }
    }
  };

  const onMouseUp = (e) => {
    if (e.button === 0) draggingLook = false;
    if (e.button === 2) rightMouseDown = false;
  };

  const onContextMenu = (e) => {
    if (pState.active && e.target === domElement) {
      e.preventDefault();
    }
  };

  const onWheel = (e) => {
    if (!pState.active) return;
    if (pState.opticsActive) {
      e.preventDefault();
      opticsTargetZoom = clamp(opticsTargetZoom - Math.sign(e.deltaY) * 0.45, 1.6, 5.0);
    }
  };

  const onKeyDown = (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
        keys.add(e.code);
      }
      return;
    }
    keys.add(e.code);
    if (!pState.active) return;

    if (e.code === 'KeyC' && !e.repeat) {
      pState.sandwalking = !pState.sandwalking;
      if (pState.sandwalking) {
        worldState.pushToast('FREMEN DISCIPLINE', 'Sandwalk Active', 'Walk without rhythm across the open Erg to evade Shai-Hulud.');
      }
    } else if (e.code === 'KeyL' && !e.repeat) {
      toggleGlowglobe();
    } else if (e.code === 'KeyV' && !e.repeat) {
      opticsToggle = !opticsToggle;
    } else if ((e.code === 'KeyT' || e.code === 'KeyF') && !e.repeat) {
      if (pState.thumperAiming) {
        raycastAimSand();
        if (thumperAimValid) {
          plantThumperAt(thumperAimPos.x, thumperAimPos.z);
          pState.thumperAiming = false;
        }
      } else {
        pState.thumperAiming = true;
      }
    } else if (e.code === 'KeyE' && !e.repeat) {
      triggerInteract();
    } else if (e.code === 'Space' && !e.repeat && pState.grounded) {
      pState.velocity.y = JUMP_SPEED * (pState.inWater ? 0.78 : 1.0);
      pState.grounded = false;
      pState.sliding = false;
      soundscape?.playFootstep?.(pState.surfaceType, 1.15, false);
    } else if (e.code === 'Escape' && pState.thumperAiming) {
      pState.thumperAiming = false;
    }
  };

  const onKeyUp = (e) => {
    keys.delete(e.code);
  };

  const onBlur = () => {
    keys.clear();
    draggingLook = false;
    rightMouseDown = false;
  };

  document.addEventListener('pointerlockchange', onPointerLockChange);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  function evaluateOpticsScanner() {
    camera.getWorldDirection(_lookDir);
    const candidates = [
      {
        label: 'SHAI-HULUD (ELDER MAKER)',
        sub: worldState.worm.phase === 'breach' ? 'BREACHING · EXTREME HAZARD' : worldState.worm.phase === 'hunting' ? 'WORMSIGN INBOUND' : 'DEEP ERG PATROL',
        pos: worldState.worm.headPos,
        maxAng: 0.26,
        visible: worldState.worm.phase !== 'patrol' || worldState.thumper.active
      },
      {
        label: 'FREMEN THUMPER',
        sub: worldState.thumper.active ? 'ACTIVE SEISMIC BEACON' : 'DORMANT',
        pos: new THREE.Vector3(worldState.thumper.position.x, getGroundHeight(worldState.thumper.position.x, worldState.thumper.position.z) + 0.8, worldState.thumper.position.z),
        maxAng: 0.11,
        visible: true
      },
      ...ARRAKIS_LANDMARKS.map(lm => ({
        label: lm.name.toUpperCase(),
        sub: lm.kicker,
        pos: new THREE.Vector3(lm.x, getGroundHeight(lm.x, lm.z) + 1.8, lm.z),
        maxAng: 0.12,
        visible: true
      }))
    ];

    let best = null;
    let bestScore = Infinity;
    for (const c of candidates) {
      if (!c.visible) continue;
      _tmpVec.copy(c.pos).sub(camera.position);
      const dist = _tmpVec.length();
      if (dist < 1.2) continue;
      _tmpVec.divideScalar(dist);
      const ang = Math.acos(clamp(_tmpVec.dot(_lookDir), -1, 1));
      if (ang < c.maxAng && ang < bestScore) {
        bestScore = ang;
        best = { label: c.label, sub: c.sub, dist: Math.round(dist) };
      }
    }

    // Also scan celestial bodies if looking skyward!
    if (!best && _lookDir.y > 0.05) {
      const skyTargets = [
        { label: 'CANOPUS (ALPHA CARINAE)', sub: worldState.eclipseActive ? 'TOTAL SOLAR ECLIPSE' : 'PRIMARY STAR · ARRAKIS SYSTEM', dir: worldState.sunDir },
        { label: 'KRELLN (FIRST MOON)', sub: 'MUAD\'DIB SILHOUETTE · ORBITING', dir: worldState.moonKrellnDir },
        { label: 'ARVON (SECOND MOON)', sub: 'CRESCENT SATELLITE', dir: worldState.moonArvonDir },
        { label: 'RINGED GAS GIANT', sub: 'SISTER PLANET · OUTER ORBIT', dir: worldState.gasGiantDir }
      ];
      for (const s of skyTargets) {
        const ang = Math.acos(clamp(_lookDir.dot(s.dir), -1, 1));
        if (ang < 0.10) {
          best = { label: s.label, sub: s.sub, dist: null };
          break;
        }
      }
    }

    pState.opticsTarget = best;
  }

  function update(dt) {
    const step = clamp(dt || 0, 0, 0.05);

    // Always animate Glowglobe smoothly if enabled (even briefly visible in Free Fly if left on!)
    const showGlobe = pState.glowglobeOn && (pState.active || worldState.cameraMode === 'free');
    glowglobe.group.visible = showGlobe;
    if (showGlobe) {
      const t = worldState.elapsed;
      _forward.set(-Math.sin(pState.yaw), 0, -Math.cos(pState.yaw));
      _right.set(Math.cos(pState.yaw), 0, -Math.sin(pState.yaw));
      const anchor = pState.active ? pState.position : camera.position;
      _tmpVec
        .copy(anchor)
        .addScaledVector(_right, -0.78)
        .addScaledVector(_forward, 1.85);
      _tmpVec.y += 0.24 + Math.sin(t * 2.3) * 0.055;
      pState.glowglobePos.lerp(_tmpVec, Math.min(1, step * 5.2 || 1));
      glowglobe.group.position.copy(pState.glowglobePos);
      glowglobe.ringA.rotation.z = t * 1.4;
      glowglobe.ringB.rotation.y = -t * 1.1;
      const nightBoost = 1.0 - THREE.MathUtils.smoothstep(worldState.sunDir.y, -0.10, 0.24);
      glowglobe.light.intensity = 8.0 + nightBoost * 11.0 + worldState.eclipseStrength * 10.0;
    }

    if (!pState.active) {
      aimReticle.group.visible = false;
      return;
    }

    // 1. Movement inputs
    pState.crouching = keys.has('ControlLeft') || keys.has('ControlRight');
    const shiftHeld = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const moveFwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const moveRight = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const hasMoveInput = moveFwd !== 0 || moveRight !== 0;

    if (shiftHeld && hasMoveInput && pState.sandwalking) {
      // Sprinting naturally breaks Sandwalk discipline
      pState.sandwalking = false;
    }
    pState.sprinting = shiftHeld && hasMoveInput && !pState.crouching && !pState.inWater;

    _forward.set(-Math.sin(pState.yaw), 0, -Math.cos(pState.yaw));
    _right.set(Math.cos(pState.yaw), 0, -Math.sin(pState.yaw));
    _moveDir.set(0, 0, 0);
    if (moveFwd !== 0) _moveDir.addScaledVector(_forward, moveFwd);
    if (moveRight !== 0) _moveDir.addScaledVector(_right, moveRight);
    if (_moveDir.lengthSq() > 0) _moveDir.normalize();

    // Sample current terrain surface properties
    const terrainInfo = getTerrainInfo(pState.feetPosition.x, pState.feetPosition.z);
    getGroundNormal(pState.feetPosition.x, pState.feetPosition.z, _groundNormal);
    const slopeSin = Math.hypot(_groundNormal.x, _groundNormal.z);

    pState.waterDepth = terrainInfo.waterDepth;
    pState.inWater = terrainInfo.waterDepth > 0.03;
    if (pState.inWater) pState.surfaceType = 'water';
    else if (terrainInfo.rockMask > 0.45) pState.surfaceType = 'rock';
    else if (terrainInfo.pathMask > 0.40) pState.surfaceType = 'path';
    else pState.surfaceType = 'sand';

    pState.onOpenErg = pState.feetPosition.z < -20.5 && terrainInfo.rockMask < 0.35 && !pState.inWater;

    // Check shelter from Coriolis storm (near Yardang Sanctuary Camp or Western Arch)
    const distCamp = Math.hypot(pState.feetPosition.x + 14.5, pState.feetPosition.z - 5.5);
    const distArch = Math.hypot(pState.feetPosition.x + 24.5, pState.feetPosition.z + 1.5);
    pState.sheltered = distCamp < 4.5 || distArch < 5.5 || (pState.crouching && terrainInfo.rockMask > 0.35);

    // Base target movement speed with slope effort & wading drag
    let targetSpeed = 4.4;
    if (pState.sandwalking) targetSpeed = 2.85;
    else if (pState.crouching) targetSpeed = 2.35;
    else if (pState.sprinting) targetSpeed = 7.7;
    if (pState.inWater) targetSpeed *= 0.68;

    // Slope resistance uphill vs exhilarating Sand-Slide downhill!
    let slopeDot = 0;
    if (_moveDir.lengthSq() > 0 && slopeSin > 0.04) {
      // Positive slopeDot means heading DOWNHILL (along normal's horizontal projection)
      slopeDot = (_moveDir.x * _groundNormal.x + _moveDir.z * _groundNormal.z) / slopeSin;
      if (slopeDot < 0) {
        // Climbing steep sand slows stride realistically
        targetSpeed *= clamp(1.0 + slopeDot * slopeSin * 1.15, 0.48, 1.0);
      }
    }

    const canSlide =
      pState.grounded &&
      pState.surfaceType === 'sand' &&
      !pState.sandwalking &&
      slopeSin > 0.24 &&
      (slopeDot > 0.35 || (!hasMoveInput && slopeSin > 0.40));

    pState.sliding = canSlide;
    if (canSlide) {
      // Gravity-driven sand-surfing slide down leeward barchan slipfaces!
      const slideAccel = 12.5 * slopeSin;
      const downX = _groundNormal.x / slopeSin;
      const downZ = _groundNormal.z / slopeSin;
      pState.velocity.x += (downX * slideAccel + _moveDir.x * 4.5) * step;
      pState.velocity.z += (downZ * slideAccel + _moveDir.z * 4.5) * step;
      const horizSpd = Math.hypot(pState.velocity.x, pState.velocity.z);
      if (horizSpd > 11.4) {
        pState.velocity.x *= 11.4 / horizSpd;
        pState.velocity.z *= 11.4 / horizSpd;
      }
      pState.slideIntensity = clamp((horizSpd - 3.0) / 6.5, 0.25, 1.0);
    } else {
      const accel = pState.grounded ? 11.5 : 3.2;
      const desiredVx = _moveDir.x * targetSpeed;
      const desiredVz = _moveDir.z * targetSpeed;
      const blend = Math.min(1, step * accel);
      pState.velocity.x += (desiredVx - pState.velocity.x) * blend;
      pState.velocity.z += (desiredVz - pState.velocity.z) * blend;
      pState.slideIntensity *= Math.exp(-step * 6.5);
    }

    // Subtle Coriolis storm gust push when standing exposed on open dunes
    const storm = worldState.weatherWeights.coriolisStorm;
    const exposedStorm = storm * (pState.sheltered ? 0.12 : 1.0) * (pState.crouching ? 0.55 : 1.0);
    pState.stormExposure += (exposedStorm - pState.stormExposure) * Math.min(1, step * 3.0);
    if (exposedStorm > 0.25 && pState.grounded) {
      const push = (exposedStorm - 0.25) * 2.1 * step;
      pState.velocity.x += worldState.windDir.x * push;
      pState.velocity.z += worldState.windDir.y * push;
    }

    // Integrate horizontal position + smooth world bounds
    let nx = clamp(pState.feetPosition.x + pState.velocity.x * step, -168, 168);
    let nz = clamp(pState.feetPosition.z + pState.velocity.z * step, -198, 72);

    // Smooth circle-slide obstacle collision (Windtrap, Camp Brazier, Ornithopter wreck, etc.)
    const playerR = 0.52;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      const dx = nx - c.x;
      const dz = nz - c.z;
      const minD = c.r + playerR;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD * minD && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        nx = c.x + (dx / d) * minD;
        nz = c.z + (dz / d) * minD;
      }
    }

    pState.feetPosition.x = nx;
    pState.feetPosition.z = nz;

    // Vertical gravity & ground snap
    const floorY = getGroundHeight(nx, nz);
    const wasGrounded = pState.grounded;
    if (!pState.grounded) {
      pState.velocity.y -= GRAVITY * step;
      pState.feetPosition.y += pState.velocity.y * step;
      if (pState.feetPosition.y <= floorY) {
        const impactVel = -pState.velocity.y;
        pState.feetPosition.y = floorY;
        pState.velocity.y = 0;
        pState.grounded = true;
        if (!wasGrounded && impactVel > 2.2) {
          landingDip = clamp(impactVel * 0.032, 0.06, 0.24);
          soundscape?.playJumpLand?.(pState.surfaceType);
          if (pState.surfaceType === 'water') {
            sandTrails?.addWaterRipple?.(nx, nz, 1.35);
          } else if (pState.surfaceType === 'sand') {
            sandTrails?.stampCrater?.(nx, nz, 0.55, 0.85);
            for (let k = 0; k < 5; k++) {
              const a = (k / 5) * Math.PI * 2 + Math.random();
              atmosphereFX?.spawnSandPuff?.(nx, floorY + 0.08, nz, Math.cos(a) * 1.1, 0.7, Math.sin(a) * 1.1, 0.45);
            }
          }
        }
      }
    } else {
      // Follow smooth sand contours effortlessly; become airborne only if leaping off a steep drop
      if (floorY < pState.feetPosition.y - 0.32 && pState.speed > 5.0) {
        pState.grounded = false;
      } else {
        pState.feetPosition.y = floorY;
      }
    }

    pState.speed = Math.hypot(pState.velocity.x, pState.velocity.z);
    soundscape?.setSlideIntensity?.(pState.slideIntensity);

    // 2. Footprints, Sand-Slide Furrows, Water Ripples & Footstep Audio!
    if (pState.grounded && pState.speed > 0.22) {
      if (pState.sliding) {
        slideFurrowCooldown -= step;
        if (slideFurrowCooldown <= 0) {
          slideFurrowCooldown = 0.06;
          const slideYaw = Math.atan2(-pState.velocity.x, -pState.velocity.z);
          sandTrails?.stampSlideFurrow?.(nx, nz, slideYaw, pState.slideIntensity);
          atmosphereFX?.spawnSandPuff?.(
            nx + (Math.random() - 0.5) * 0.35,
            floorY + 0.14,
            nz + (Math.random() - 0.5) * 0.35,
            -pState.velocity.x * 0.18,
            0.55 + Math.random() * 0.45,
            -pState.velocity.z * 0.18,
            0.46 + pState.slideIntensity * 0.3
          );
        }
      } else {
        stepDistAccum += pState.speed * step;
        const bobFreq = pState.sandwalking ? 1.55 : pState.sprinting ? 2.45 : 1.95;
        headBobPhase += pState.speed * step * bobFreq;

        if (stepDistAccum >= nextStepInterval) {
          stepDistAccum = 0;
          leftFoot = !leftFoot;
          pState.footstepsCount += 1;

          // Authentic irregular Fremen Sandwalk step spacing vs rhythmic normal walking!
          if (pState.sandwalking) {
            nextStepInterval = 0.85 + Math.random() * 1.35;
          } else {
            nextStepInterval = pState.sprinting ? 1.65 : pState.crouching ? 1.12 : 1.38;
          }

          const latOff = leftFoot ? -0.17 : 0.17;
          const fx = nx + _right.x * latOff;
          const fz = nz + _right.z * latOff;
          const fIntensity = pState.sprinting ? 1.18 : pState.crouching ? 0.52 : pState.sandwalking ? 0.65 : 0.88;

          soundscape?.playFootstep?.(pState.surfaceType, fIntensity, pState.sandwalking);

          if (pState.surfaceType === 'water') {
            sandTrails?.addWaterRipple?.(fx, fz, 0.85 + (pState.sprinting ? 0.4 : 0));
          } else if (pState.surfaceType === 'sand' || pState.surfaceType === 'path') {
            const depth = pState.surfaceType === 'path' ? 0.48 : (pState.sprinting ? 1.18 : 0.92);
            sandTrails?.stampFootprint?.(fx, fz, pState.yaw, leftFoot, depth, pState.sandwalking);
            if (pState.sprinting || Math.random() < 0.45) {
              atmosphereFX?.spawnSandPuff?.(
                fx,
                floorY + 0.08,
                fz,
                -pState.velocity.x * 0.12 + (Math.random() - 0.5) * 0.4,
                0.32 + Math.random() * 0.25,
                -pState.velocity.z * 0.12 + (Math.random() - 0.5) * 0.4,
                pState.sprinting ? 0.36 : 0.22
              );
            }
          }

          // Seismic Wormsign Impulse on Open Erg!
          if (pState.onOpenErg) {
            const impulse = pState.sandwalking
              ? 0.025
              : pState.sprinting
                ? 0.18
                : pState.crouching
                  ? 0.05
                  : 0.105;
            pState.seismicPulse = Math.min(1.0, pState.seismicPulse + impulse * 2.4);
            if (!pState.sandwalking) {
              pState.wormThreat = Math.min(1.0, pState.wormThreat + impulse * 0.72);
            } else {
              pState.wormThreat = Math.max(0, pState.wormThreat - 0.02);
            }
          }
        }
      }

      // Continuous subtle wading ripples while moving through water
      if (pState.inWater) {
        waterRippleCooldown -= step;
        if (waterRippleCooldown <= 0) {
          waterRippleCooldown = 0.38;
          sandTrails?.addWaterRipple?.(nx, nz, 0.55);
        }
      }
    }

    // 3. Seismic Seismograph & Wormsign Logic
    pState.seismicPulse *= Math.exp(-step * 5.2);
    if (!pState.onOpenErg) {
      pState.wormThreat = Math.max(0, pState.wormThreat - step * 0.18);
    } else if (pState.speed < 0.2 || pState.sandwalking) {
      pState.wormThreat = Math.max(0, pState.wormThreat - step * (pState.sandwalking ? 0.085 : 0.055));
    } else if (pState.sliding) {
      // Loud sand-avalanche slide down an Erg dune attracts attention quickly!
      pState.wormThreat = Math.min(1.0, pState.wormThreat + step * 0.11);
      pState.seismicPulse = Math.max(pState.seismicPulse, 0.42 * pState.slideIntensity);
    }

    if (pState.wormThreat >= 0.88 && worldState.worm.phase === 'patrol' && worldState.worm.cooldown <= 0) {
      worldState.triggerWormHunt(nx, nz, 'player');
      worldState.pushToast(
        'WORMSIGN DETECTED!',
        'Rhythmic Steps Heard in the Deep Erg',
        'Press [C] to Sandwalk, plant a [T] Thumper decoy, or retreat to sandstone rock!'
      );
    }

    // Record live seismograph waveform buffer at 30Hz
    seismicSampleTimer += step;
    if (seismicSampleTimer >= 0.032) {
      seismicSampleTimer = 0;
      const wormSig = worldState.worm.tremor * (pState.onOpenErg ? 0.95 : 0.35);
      const thumpSig = worldState.thumper.pulseStrength * 0.65;
      const noiseAmp = pState.onOpenErg ? 0.03 : 0.01;
      const val =
        (pState.seismicPulse * 0.72 + wormSig * 0.55 + thumpSig * 0.48 + noiseAmp) *
        Math.sin(worldState.elapsed * 34.0 + pState.seismicCursor * 1.4);
      pState.seismicSamples[pState.seismicCursor] = clamp(val, -1, 1);
      pState.seismicCursor = (pState.seismicCursor + 1) % pState.seismicSamples.length;
    }

    // Very gentle realistic stillsuit hydration drain in hot midday sun (never punitive!)
    const heatFactor = Math.max(0.15, worldState.sunDir.y) * (pState.sprinting ? 2.0 : 1.0);
    pState.hydration = clamp(pState.hydration - step * 0.0008 * heatFactor, 0.25, 1.0);
    if (pState.inWater) {
      pState.hydration = clamp(pState.hydration + step * 0.08, 0, 1.0);
    }

    // 4. Camera Pose, Head Bob, Sand-Slide Bank & Worm Shake
    const targetEye = pState.crouching ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT;
    curEyeHeight += (targetEye - curEyeHeight) * Math.min(1, step * 10.0);
    landingDip *= Math.exp(-step * 11.0);

    const bobScale = pState.grounded && !pState.sliding ? clamp(pState.speed / 5.0, 0, 1.15) : 0;
    const bobY = Math.sin(headBobPhase * 2.0) * (pState.sandwalking ? 0.034 : 0.048) * bobScale;
    const bobX = Math.cos(headBobPhase) * (pState.sandwalking ? 0.042 : 0.024) * bobScale;

    // Subtle organic banking roll when sandwalking or surfing a slipface
    const targetRoll = pState.sliding
      ? clamp(-moveRight * 0.045, -0.06, 0.06)
      : pState.sandwalking && pState.speed > 0.3
        ? Math.sin(headBobPhase) * 0.022
        : 0;
    rollAngle += (targetRoll - rollAngle) * Math.min(1, step * 7.0);

    // Distance-weighted seismic camera tremor from Shai-Hulud / Thumper
    const distWorm = Math.hypot(nx - worldState.worm.position.x, nz - worldState.worm.position.z);
    const wormShake = worldState.worm.tremor * clamp(65.0 / (distWorm + 22.0), 0.1, 1.0) * 0.035;
    const totalShake = wormShake + pState.screenShake * 0.095;
    const shakeX = totalShake > 0.001 ? Math.sin(worldState.elapsed * 43.0) * totalShake : 0;
    const shakeY = totalShake > 0.001 ? Math.cos(worldState.elapsed * 51.0) * totalShake * 0.75 : 0;

    pState.position.set(
      nx + _right.x * bobX + shakeX,
      pState.feetPosition.y + curEyeHeight + bobY - landingDip + shakeY,
      nz + _right.z * bobX
    );

    camera.position.copy(pState.position);
    _euler.set(pState.pitch, pState.yaw, rollAngle, 'YXZ');
    camera.quaternion.setFromEuler(_euler);

    // 5. Electro-Optics Binoculars Smooth FOV Zoom & Live Target Scanner
    pState.opticsActive = rightMouseDown || opticsToggle;
    const targetZoom = pState.opticsActive ? opticsTargetZoom : 1.0;
    pState.opticsZoom += (targetZoom - pState.opticsZoom) * Math.min(1, step * 11.0);

    const sprintFovKick = pState.sprinting && !pState.opticsActive ? 4.2 : pState.sliding ? 5.5 : 0;
    const desiredFov = (48.0 + sprintFovKick) / pState.opticsZoom;
    if (Math.abs(camera.fov - desiredFov) > 0.04) {
      camera.fov += (desiredFov - camera.fov) * Math.min(1, step * 12.0);
      camera.updateProjectionMatrix();
    }

    if (pState.opticsActive) {
      evaluateOpticsScanner();
    } else {
      pState.opticsTarget = null;
    }

    // 6. Thumper Placement Aim Reticle Preview
    aimReticle.group.visible = pState.thumperAiming;
    if (pState.thumperAiming) {
      raycastAimSand();
      getGroundNormal(thumperAimPos.x, thumperAimPos.z, _groundNormal);
      aimReticle.group.position.copy(thumperAimPos);
      aimReticle.group.position.y += 0.06;
      aimReticle.group.quaternion.setFromUnitVectors(_up, _groundNormal);
      aimReticle.outerMat.color.setHex(thumperAimValid ? 0xffcb70 : 0xff4c38);
      const pulse = 1.0 + Math.sin(worldState.elapsed * 6.5) * 0.08;
      aimReticle.outerRing.scale.setScalar(pulse);
    }

    // 7. Landmark Proximity Discovery & Contextual [E] Interactables
    for (let i = 0; i < ARRAKIS_LANDMARKS.length; i++) {
      const lm = ARRAKIS_LANDMARKS[i];
      if (!pState.discoveredIds.has(lm.id)) {
        const d = Math.hypot(nx - lm.x, nz - lm.z);
        if (d < lm.radius) {
          if (worldState.markDiscovered(lm.id)) {
            soundscape?.playDiscoveryChime?.();
            onDiscovery?.(lm);
          }
        }
      }
    }

    camera.getWorldDirection(_lookDir);
    let bestInter = null;
    let bestScore = Infinity;
    for (let i = 0; i < interactables.length; i++) {
      const it = interactables[i];
      if (it.isAvailable && !it.isAvailable()) continue;
      const dist = Math.hypot(nx - it.position.x, nz - it.position.z);
      if (dist <= it.radius) {
        _tmpVec.copy(it.position).sub(camera.position).normalize();
        const align = _tmpVec.dot(_lookDir);
        if (align > 0.42 || dist < 2.2) {
          const score = dist - align * 2.0;
          if (score < bestScore) {
            bestScore = score;
            bestInter = it;
          }
        }
      }
    }
    // Also allow drinking anywhere around the Dew Cistern water shore!
    if (!bestInter && Math.hypot(nx - CISTERN_CENTER.x, nz - CISTERN_CENTER.z) < 7.8 && (pState.inWater || terrainInfo.moisture > 0.35)) {
      bestInter = interactables.find(it => it.id === 'cistern_drink') || null;
    }

    activeInteractable = bestInter;
    pState.nearbyPrompt = pState.thumperAiming
      ? (thumperAimValid ? '[Click / T] Drive Fremen Thumper into Sand · [RMB] Cancel' : 'Aim at open sand to plant Thumper · [RMB] Cancel')
      : bestInter
        ? bestInter.prompt
        : null;
  }

  function dispose() {
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  }

  return {
    enterWalkMode,
    exitWalkMode,
    requestPointerLock,
    toggleGlowglobe,
    plantThumperAt,
    triggerInteract,
    update,
    dispose
  };
}
