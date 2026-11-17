import * as THREE from 'three';
import { WorldState } from './state/worldState.js';
import { createSkySystem } from './world/sky.js';
import { createTerrainSystem } from './world/terrain.js';
import { createGeologyAndProps } from './world/geology.js';
import { createFloraSystem } from './world/flora.js';
import { createFaunaSystem } from './world/fauna.js';
import { createAtmosphereFXSystem } from './world/atmosphereFX.js';
import { createCameraController } from './world/camera.js';
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

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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

  const worldState = new WorldState();
  scene.fog = new THREE.FogExp2(worldState.fogColor.getHex(), worldState.fogDensity);

  // Canopus Sun key directional light (2048x2048 shadow frustum over entire focal basin, xerophytes & western Yardangs)
  const sunLight = new THREE.DirectionalLight(0xffcfa0, worldState.sunIntensity);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.radius = 1.7;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 220;
  sunLight.shadow.camera.left = -58;
  sunLight.shadow.camera.right = 58;
  sunLight.shadow.camera.top = 58;
  sunLight.shadow.camera.bottom = -58;
  sunLight.shadow.camera.updateProjectionMatrix();
  sunLight.shadow.bias = -0.0003;
  sunLight.shadow.normalBias = 0.010;
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

    _sunPosDir.set(
      worldState.sunDir.x,
      Math.max(worldState.sunDir.y, 0.08),
      worldState.sunDir.z
    ).normalize();
    sunLight.position.copy(sunLight.target.position).addScaledVector(_sunPosDir, 95);

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

  if (loadingStatus) loadingStatus.textContent = 'Synthesizing Astral Sky, Oasis Flora & Shai-Hulud…';

  const skySystem = createSkySystem(scene, worldState);
  const terrainSystem = createTerrainSystem(scene, worldState);
  const geologySystem = createGeologyAndProps(scene, worldState);
  const floraSystem = createFloraSystem(scene, worldState);
  const faunaSystem = createFaunaSystem(scene, worldState);
  const atmoFXSystem = createAtmosphereFXSystem(scene, worldState);
  const cameraController = createCameraController(camera, renderer.domElement, worldState);
  const postProcess = createPostProcess(renderer, scene, camera, worldState);
  const soundscape = createSoundscape(worldState);

  const hud = initHud(worldState, cameraController, {
    onToggleAudio: () => soundscape.toggle(),
    onThumper: () => {}
  });

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('clean') === '1') {
    hud.setHudVisible(false);
  }

  function stepSimulation(dt) {
    worldState.update(dt);
    syncLightingAndFog();
    cameraController.update(dt);
    skySystem?.update?.(dt, camera);
    terrainSystem?.update?.(dt, camera);
    geologySystem?.update?.(dt, camera);
    floraSystem?.update?.(dt, camera);
    faunaSystem?.update?.(dt, camera);
    atmoFXSystem?.update?.(dt, camera);
    soundscape?.update?.(dt);
    hud.update(dt);
  }

  if (loadingStatus) loadingStatus.textContent = 'Compiling WebGL2 Atmospheric Shaders…';
  syncLightingAndFog();
  stepSimulation(0.016);
  postProcess.render(0.016);
  if (urlParams.get('clean') === '1' && loadingVeil) {
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

  // Deterministic Gauntlet capture & diagnostic API
  window.__ARRAKIS__ = {
    ready: true,
    state: worldState,
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
      worldState.update(0);

      if (shot.weather === 'coriolisStorm') {
        worldState.lightningSeed = 4.25;
        worldState.lightningFlash = 1.25;
      } else {
        worldState.lightningFlash = 0;
      }

      if (shot.thumper) {
        worldState.triggerThumper();
      } else {
        worldState.thumper.active = false;
        worldState.thumper.timer = 0;
        worldState.thumper.pulseStrength = 0;
      }

      if (shot.breach) {
        // Position Shai-Hulud at peak awe-inspiring mid-air breach arc during deterministic capture!
        worldState.triggerBreach(12, -106, 0.45);
      } else {
        worldState.worm.phase = 'patrol';
        worldState.worm.breachProgress = 0;
        worldState.worm.breachTimer = 16;
      }

      // Reset deterministic dust devil showcase coordinates (visible in both 06_spice_blow & 08_hud_overview!)
      worldState.dustDevils[0].x = -35.0;
      worldState.dustDevils[0].z = -72;
      worldState.dustDevils[1].x = -9.5;
      worldState.dustDevils[1].z = -54;
      worldState.dustDevils[2].x = 2.5;
      worldState.dustDevils[2].z = -64;

      cameraController.setPreset(shot.cam || 'director', true);

      if (shot.hud !== undefined) {
        hud.setHudVisible(Boolean(shot.hud));
      }

      syncLightingAndFog();
      skySystem?.update?.(0, camera);
      terrainSystem?.update?.(0, camera);
      geologySystem?.update?.(0, camera);
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
        weather: worldState.targetWeather
      };
    }
  };
}

boot();
