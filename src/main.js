import * as THREE from 'three';
import { WorldState } from './state/worldState.js';
import { createEnvironmentIBL } from './world/envLighting.js';
import { createSandTrailsSystem } from './world/sandTrails.js';
import { createSkySystem } from './world/sky.js';
import { createTerrainSystem } from './world/terrain.js';
import { createGeologyAndProps } from './world/geology.js';
import { createLandmarksSystem } from './world/landmarks.js';
import { createFloraSystem } from './world/flora.js';
import { createFaunaSystem } from './world/fauna.js';
import { createAtmosphereFXSystem } from './world/atmosphereFX.js';
import { createPlayerController } from './world/player.js';
import { createCameraController } from './world/camera.js';
import { getGroundHeight } from './world/terrainMath.js';
import { createPostProcess } from './world/postprocess.js';
import { createSoundscape } from './audio/soundscape.js';
import { initHud } from './ui/hud.js';

const _sunPosDir = new THREE.Vector3();
const _moonPosDir = new THREE.Vector3();
const _tmpColor = new THREE.Color();
const _lightningTint = new THREE.Color(0xb8cfff);

function boot() {
  const container = document.getElementById('canvas-root');
  const loadingVeil = document.getElementById('loading-veil');
  const loadingStatus = document.getElementById('loading-status');
  const urlParams = new URLSearchParams(window.location.search);
  const isCleanCapture = urlParams.get('clean') === '1';

  const worldState = new WorldState();
  const initQ = worldState.getQualityConfig();

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, initQ.pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.04;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    48,
    window.innerWidth / Math.max(1, window.innerHeight),
    0.10,
    1200
  );

  scene.fog = new THREE.FogExp2(worldState.fogColor.getHex(), worldState.fogDensity);

  // Canopus Sun key directional light (dynamically follows player across the Erg with texel snapping!)
  const sunLight = new THREE.DirectionalLight(0xffcfa0, worldState.sunIntensity);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(initQ.shadowMapSize, initQ.shadowMapSize);
  sunLight.shadow.radius = initQ.shadowRadius;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 240;
  sunLight.shadow.camera.left = -62;
  sunLight.shadow.camera.right = 62;
  sunLight.shadow.camera.top = 62;
  sunLight.shadow.camera.bottom = -62;
  sunLight.shadow.camera.updateProjectionMatrix();
  sunLight.shadow.bias = -0.00028;
  sunLight.shadow.normalBias = 0.012;
  sunLight.target.position.set(-4, 1, -2);
  scene.add(sunLight);
  scene.add(sunLight.target);

  // Twin Moon fill directional light
  const moonLight = new THREE.DirectionalLight(0x8db2e8, worldState.moonIntensity);
  moonLight.target.position.set(0, 1, -8);
  scene.add(moonLight);
  scene.add(moonLight.target);

  // Atmospheric sky/ground bounce fill
  const hemiLight = new THREE.HemisphereLight(
    worldState.ambientSkyColor.getHex(),
    worldState.ambientGroundColor.getHex(),
    worldState.ambientIntensity
  );
  scene.add(hemiLight);

  // Dynamic dry-lightning sky flash inside Coriolis storm front
  const lightningLight = new THREE.PointLight(0xd4e4ff, 0, 360, 1.5);
  lightningLight.position.set(0, 38, -96);
  scene.add(lightningLight);

  function syncLightingAndFog() {
    const sunVis = THREE.MathUtils.smoothstep(worldState.sunDir.y, -0.02, 0.09);
    sunLight.intensity = worldState.sunIntensity * sunVis;
    sunLight.color.copy(worldState.sunColor);
    sunLight.castShadow = sunLight.intensity > 0.06;

    // Texel-snapped player/camera-following shadow cascade when exploring deep Erg!
    if (worldState.player.active) {
      const snap = 2.0;
      const fx = Math.round(worldState.player.feetPosition.x / snap) * snap;
      const fz = Math.round(worldState.player.feetPosition.z / snap) * snap;
      sunLight.target.position.set(fx, worldState.player.feetPosition.y, fz);
    } else if (worldState.cameraMode === 'free' || worldState.cameraMode === 'ornithopter') {
      const snap = 4.0;
      const fx = Math.round(camera.position.x / snap) * snap;
      const fz = Math.round((camera.position.z - 10) / snap) * snap;
      sunLight.target.position.set(fx, Math.max(0, camera.position.y - 4), fz);
    } else {
      sunLight.target.position.set(-4, 1, -2);
    }
    sunLight.target.updateMatrixWorld();

    _sunPosDir.set(
      worldState.sunDir.x,
      Math.max(worldState.sunDir.y, 0.08),
      worldState.sunDir.z
    ).normalize();
    sunLight.position.copy(sunLight.target.position).addScaledVector(_sunPosDir, 100);

    _moonPosDir.set(
      worldState.moonKrellnDir.x,
      Math.max(worldState.moonKrellnDir.y, 0.28),
      worldState.moonKrellnDir.z
    ).normalize();
    moonLight.position.copy(moonLight.target.position).addScaledVector(_moonPosDir, 90);
    moonLight.intensity = worldState.moonIntensity * 0.92;
    moonLight.color.setHex(0xd2e0f7).lerp(_tmpColor.setHex(0xd8a87e), worldState.eclipseStrength * 0.60);

    hemiLight.color.copy(worldState.ambientSkyColor);
    hemiLight.groundColor.copy(worldState.ambientGroundColor);
    hemiLight.intensity = worldState.ambientIntensity;

    lightningLight.position.set(Math.sin(worldState.elapsed * 2.3) * 28, 38, -96);
    lightningLight.intensity = worldState.lightningFlash * 380.0;

    scene.fog.color.copy(worldState.fogColor);
    if (worldState.lightningFlash > 0.01) {
      scene.fog.color.lerp(_lightningTint, Math.min(0.42, worldState.lightningFlash * 0.22));
    }
    scene.fog.density = worldState.fogDensity;

    renderer.toneMappingExposure = 1.04 + (worldState.exposure - 1.02);
  }

  if (loadingStatus) loadingStatus.textContent = 'Synthesizing Astral IBL, Erg Dunes, Fremen Outpost & Shai-Hulud…';

  const envIBL = createEnvironmentIBL(renderer, scene, worldState);
  const sandTrails = createSandTrailsSystem(worldState);
  const skySystem = createSkySystem(scene, worldState);
  const terrainSystem = createTerrainSystem(scene, worldState, sandTrails);
  const geologySystem = createGeologyAndProps(scene, worldState);
  const landmarksSystem = createLandmarksSystem(scene, worldState);
  const floraSystem = createFloraSystem(scene, worldState);
  const faunaSystem = createFaunaSystem(scene, worldState);
  const atmoFXSystem = createAtmosphereFXSystem(scene, worldState);
  const soundscape = createSoundscape(worldState);

  const allColliders = [
    ...(geologySystem.colliders || []),
    ...(landmarksSystem.colliders || [])
  ];

  const playerController = createPlayerController({
    camera,
    domElement: renderer.domElement,
    scene,
    worldState,
    sandTrails,
    atmosphereFX: atmoFXSystem,
    soundscape,
    colliders: allColliders,
    interactables: landmarksSystem.interactables
  });

  // Interactive users launch directly onto Arrakis in Walk mode; automated ?clean=1 capture starts in Director
  worldState.cameraMode = isCleanCapture ? 'director' : 'walk';

  const cameraController = createCameraController(camera, renderer.domElement, worldState, playerController);
  const postProcess = createPostProcess(renderer, scene, camera, worldState);

  function applyQualityTier(tier) {
    worldState.setQuality(tier);
    const q = worldState.getQualityConfig();
    if (sunLight.shadow.mapSize.width !== q.shadowMapSize) {
      sunLight.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      sunLight.shadow.map?.dispose();
      sunLight.shadow.map = null;
    }
    sunLight.shadow.radius = q.shadowRadius;
    terrainSystem.setWaterResolution?.(q.waterRes);
    postProcess.applyQuality?.();
  }

  const hud = initHud(worldState, cameraController, {
    onToggleAudio: () => soundscape.toggle(),
    isAudioEnabled: () => soundscape.isEnabled(),
    onThumper: () => {
      soundscape.playThumperPlant?.();
    },
    onToggleGlowglobe: () => {
      playerController.toggleGlowglobe();
    },
    onQualityChange: (tier) => {
      applyQualityTier(tier);
    },
    onEnterWalk: () => {
      soundscape.ensureStarted?.();
    }
  });

  if (isCleanCapture) {
    hud.setHudVisible(false);
  } else {
    // Start with the wide uncluttered cinema viewport while walking (Tab or Controls button opens deck!)
    hud.setDeckOpen(false);
  }

  function stepSimulation(dt) {
    worldState.update(dt);
    cameraController.update(dt);
    syncLightingAndFog();
    envIBL.update(dt);
    sandTrails.update(dt);
    skySystem?.update?.(dt, camera);
    terrainSystem?.update?.(dt, camera);
    geologySystem?.update?.(dt, camera);
    landmarksSystem?.update?.(dt, camera);
    floraSystem?.update?.(dt, camera);
    faunaSystem?.update?.(dt, camera);
    atmoFXSystem?.update?.(dt, camera);
    soundscape?.update?.(dt, camera);
    hud.update(dt);
  }

  if (loadingStatus) loadingStatus.textContent = 'Compiling WebGL2 Atmospheric & Volumetric Shaders…';
  syncLightingAndFog();
  stepSimulation(0.016);
  postProcess.render(0.016);
  if (isCleanCapture && loadingVeil) {
    loadingVeil.style.display = 'none';
  }
  loadingVeil?.classList.add('hidden');

  let steppingDeterministic = false;
  let lastFrameTime = performance.now();

  function animate(now) {
    requestAnimationFrame(animate);
    if (steppingDeterministic) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameTime) * 0.001));
    lastFrameTime = now;
    stepSimulation(dt);
    postProcess.render(dt);
  }
  requestAnimationFrame(animate);

  function handleResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w <= 0 || h <= 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    postProcess.setSize(w, h);
  }
  window.addEventListener('resize', handleResize);

  // Deterministic Gauntlet capture, interactive test & diagnostic API
  window.__ARRAKIS__ = {
    ready: true,
    state: worldState,
    player: playerController,
    sandTrails,
    camera,
    setQuality: applyQualityTier,
    applyShot(shot) {
      if (!shot) return;
      if (typeof shot.tod === 'number') {
        worldState.setTimeOfDay(shot.tod, Boolean(shot.eclipse));
      } else if (shot.eclipse !== undefined) {
        worldState.eclipseActive = Boolean(shot.eclipse);
      }
      worldState.autoTime = false;
      worldState.autoWeather = false;
      worldState.elapsed = 1.25;

      if (shot.weather) {
        worldState.setWeather(shot.weather);
      }
      if (shot.quality) {
        applyQualityTier(shot.quality);
      }
      worldState.update(0);

      if (shot.weather === 'coriolisStorm') {
        worldState.lightningSeed = 4.25;
        worldState.lightningFlash = 1.25;
      } else {
        worldState.lightningFlash = 0;
      }

      if (shot.thumper) {
        worldState.triggerThumper(8.5, -14.5, false);
      } else {
        worldState.thumper.active = false;
        worldState.thumper.timer = 0;
        worldState.thumper.pulseStrength = 0;
      }

      if (shot.breach) {
        worldState.triggerBreach(12, -106, 0.45);
      } else {
        worldState.worm.phase = 'patrol';
        worldState.worm.breachProgress = 0;
        worldState.worm.breachTimer = 16;
      }

      worldState.dustDevils[0].x = -35.0;
      worldState.dustDevils[0].z = -72;
      worldState.dustDevils[1].x = -9.5;
      worldState.dustDevils[1].z = -54;
      worldState.dustDevils[2].x = 2.5;
      worldState.dustDevils[2].z = -64;

      const targetCam = shot.walkPose ? 'walk' : (shot.cam || 'director');

      // Reset optional Wave 4 states cleanly by default
      worldState.player.spiceTrance = shot.spiceTrance ?? 0;
      if (!shot.footprints) {
        sandTrails.clearAll?.();
      }
      if (targetCam !== 'walk' && !shot.walkPose) {
        playerController.exitWalkMode?.();
        worldState.player.glowglobeOn = false;
        worldState.player.opticsActive = false;
        worldState.player.opticsZoom = 1.0;
        camera.fov = 48;
        camera.updateProjectionMatrix();
      }

      if (shot.footprints) {
        if (sandTrails.seedShowcaseTrail) {
          sandTrails.seedShowcaseTrail(3.4, -30.0, 0.28, 14, true);
        } else {
          sandTrails.clearAll?.();
          sandTrails.origin?.set?.(3.0, -30.0);
          const steps = 14;
          for (let i = 0; i < steps; i++) {
            const t = i / (steps - 1);
            const fx = 3.4 + (2.4 - 3.4) * t + (i % 2 === 0 ? -0.18 : 0.18);
            const fz = -27.0 + (-33.5 - -27.0) * t;
            sandTrails.stampFootprint?.(fx, fz, 0.28, i % 2 === 0, 1.15, true);
          }
        }
      }

      cameraController.setPreset(targetCam, true);

      if (shot.walkPose) {
        if (playerController.setPose) {
          playerController.setPose(shot.walkPose);
        } else {
          const pose = shot.walkPose;
          const p = worldState.player;
          const gx = pose.x ?? p.feetPosition.x;
          const gz = pose.z ?? p.feetPosition.z;
          const gy = getGroundHeight(gx, gz);
          p.active = true;
          p.feetPosition.set(gx, gy, gz);
          p.velocity.set(0, 0, 0);
          p.yaw = pose.yaw ?? 0;
          p.pitch = pose.pitch ?? 0;
          p.crouching = Boolean(pose.crouching);
          p.sandwalking = Boolean(pose.sandwalking);
          p.thumperAiming = Boolean(pose.thumperAiming);
          const wantGlow = Boolean(pose.glowglobe);
          if (p.glowglobeOn !== wantGlow) {
            playerController.toggleGlowglobe?.();
          }
          p.opticsActive = Boolean(pose.optics);
          p.opticsZoom = p.opticsActive ? (pose.opticsZoom || 2.6) : 1.0;
          const eyeY = gy + (p.crouching ? 0.94 : 1.66);
          p.position.set(gx, eyeY, gz);
          camera.position.copy(p.position);
          camera.rotation.order = 'YXZ';
          camera.rotation.set(p.pitch, p.yaw, 0);
          camera.fov = 48.0 / p.opticsZoom;
          camera.updateProjectionMatrix();
        }
        if (shot.hud) {
          hud.setHudVisible(true);
          hud.setDeckOpen(false);
        }
      } else if (shot.hud !== undefined) {
        hud.setHudVisible(Boolean(shot.hud));
        hud.setDeckOpen(Boolean(shot.hud) && targetCam !== 'walk');
      } else if (isCleanCapture) {
        hud.setHudVisible(false);
      }

      syncLightingAndFog();
      envIBL.update(0, true);
      sandTrails.update(0);
      skySystem?.update?.(0, camera);
      terrainSystem?.update?.(0, camera);
      geologySystem?.update?.(0, camera);
      landmarksSystem?.update?.(0, camera);
      floraSystem?.update?.(0, camera);
      faunaSystem?.update?.(0, camera);
      atmoFXSystem?.update?.(0, camera);
      hud.syncFromState();
    },
    async renderSteps(count = 1, dt = 0.016) {
      steppingDeterministic = true;
      try {
        const steps = Math.max(1, Math.floor(count));
        for (let i = 0; i < steps; i++) {
          stepSimulation(dt);
          if (worldState.targetWeather === 'coriolisStorm' && !worldState.autoWeather && worldState.lightningFlash > 0.2) {
            worldState.lightningFlash = Math.max(worldState.lightningFlash, 1.05);
          }
          postProcess.render(dt);
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
      } finally {
        steppingDeterministic = false;
        lastFrameTime = performance.now();
      }
    },
    getStats() {
      return {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        tod: Number(worldState.timeOfDay.toFixed(2)),
        weather: worldState.targetWeather,
        quality: worldState.quality,
        mode: worldState.cameraMode
      };
    }
  };
}

boot();
