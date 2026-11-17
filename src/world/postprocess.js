import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const _camForward = new THREE.Vector3();
const _horizonWorld = new THREE.Vector3();
const _sizeVec = new THREE.Vector2();

const ArrakisAtmoShader = {
  name: 'ArrakisAtmoShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uMirage: { value: 0 },
    uStorm: { value: 0 },
    uSpice: { value: 0 },
    uLightning: { value: 0 },
    uHorizonY: { value: 0.48 },
    uNight: { value: 0 },
    uEclipse: { value: 0 }
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uMirage;
    uniform float uStorm;
    uniform float uSpice;
    uniform float uLightning;
    uniform float uHorizonY;
    uniform float uNight;
    uniform float uEclipse;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      // 1. Convective thermal heat shimmer rising from horizon when mirage is active
      vec2 sampleUv = vUv;
      if (uMirage > 0.005) {
        float hDelta = vUv.y - uHorizonY;
        float horizonBand = exp(-pow(hDelta / 0.115, 2.0));
        float groundMask = smoothstep(0.14, 0.34, vUv.y);
        float mirageMask = horizonBand * groundMask * uMirage;

        float w1 = sin(vUv.y * 145.0 - uTime * 5.6 + vUv.x * 26.0);
        float w2 = cos(vUv.y * 235.0 - uTime * 8.4 - vUv.x * 41.0);
        float w3 = sin((vUv.x * 18.0 + vUv.y * 78.0) - uTime * 3.8);

        vec2 shimmerOffset = vec2(
          (w1 * 0.58 + w2 * 0.42) * 0.0046,
          (w2 * 0.52 + w3 * 0.48) * 0.0024
        ) * mirageMask;

        sampleUv = clamp(sampleUv + shimmerOffset, vec2(0.0005), vec2(0.9995));
      }

      // 2. Subtle optical chromatic rim dispersion near frame edges
      vec2 centered = vUv - 0.5;
      float r2 = dot(centered, centered);
      float disp = (0.00085 + uStorm * 0.00065 + uMirage * 0.00035) * r2;

      vec2 uvR = clamp(sampleUv + centered * disp, vec2(0.0005), vec2(0.9995));
      vec2 uvB = clamp(sampleUv - centered * disp, vec2(0.0005), vec2(0.9995));

      float r = texture2D(tDiffuse, uvR).r;
      vec4 gTex = texture2D(tDiffuse, sampleUv);
      float b = texture2D(tDiffuse, uvB).b;
      vec3 color = vec3(r, gTex.g, b);

      // 3. Dry static lightning upper-atmosphere scatter tint during Coriolis Storm
      if (uLightning > 0.001) {
        float skyGrad = smoothstep(0.18, 0.94, vUv.y);
        color *= 1.0 + uLightning * 0.14;
        color += vec3(0.76, 0.85, 1.12) * uLightning * (0.07 + 0.15 * skyGrad);
      }

      // 4. Subtle Mélange spice atmospheric warmth & sheen
      if (uSpice > 0.01) {
        color = mix(color, color * vec3(1.045, 0.965, 0.945), uSpice * 0.45);
      }

      // 5. Subtle warm cinema vignette (preserves foreground shadow readability at dawn/night)
      vec2 vigCoord = centered * vec2(1.0, 0.88);
      float vigDist = length(vigCoord);
      float vig = smoothstep(0.46, 1.05, vigDist) * (0.12 + uStorm * 0.14);
      vec3 vigTint = mix(vec3(1.0), vec3(0.78, 0.68, 0.60), vig);
      color *= vigTint;

      // 6. Subtle natural 35mm film grain + 8-bit sky/horizon dither (velvety-clean in darks, zero speckle)
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      float lumaWeight = smoothstep(0.03, 0.30, luma);
      float n = hash12(gl_FragCoord.xy + vec2(fract(uTime * 19.7) * 513.0, fract(uTime * 11.3) * 389.0));
      float dither = (hash12(gl_FragCoord.xy) - 0.5) * 0.0014 * mix(0.25, 1.0, lumaWeight);
      float darkScene = clamp(max(uNight, uEclipse), 0.0, 1.0);
      float baseAmp = mix(0.009 + uStorm * 0.005, 0.0045 + uStorm * 0.003, darkScene);
      float grainAmp = baseAmp * mix(0.20, 1.0, lumaWeight);
      color = max(vec3(0.0), color + (n - 0.5) * grainAmp + dither);

      gl_FragColor = vec4(color, gTex.a);
    }
  `
};

export function createPostProcess(renderer, scene, camera, worldState) {
  renderer.info.autoReset = false;

  const composer = new EffectComposer(renderer);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  composer.setPixelRatio(pixelRatio);

  renderer.getSize(_sizeVec);
  composer.setSize(_sizeVec.width, _sizeVec.height);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(_sizeVec.width, _sizeVec.height),
    0.34,
    0.45,
    0.88
  );
  composer.addPass(bloomPass);

  const atmoPass = new ShaderPass(ArrakisAtmoShader);
  composer.addPass(atmoPass);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  function setSize(w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
  }

  function updateUniforms() {
    const u = atmoPass.uniforms;
    u.uTime.value = worldState.elapsed;

    // Combine explicit mirage weather with mild midday desert shimmer
    const noonSunHeat = THREE.MathUtils.clamp((worldState.sunDir.y - 0.45) * 0.7, 0, 0.35);
    u.uMirage.value = THREE.MathUtils.clamp(
      worldState.weatherWeights.mirage + noonSunHeat * (1.0 - worldState.weatherWeights.coriolisStorm),
      0,
      1.15
    );
    u.uStorm.value = worldState.weatherWeights.coriolisStorm;
    u.uSpice.value = worldState.weatherWeights.spiceBlow;
    u.uLightning.value = worldState.lightningFlash;
    u.uNight.value = 1.0 - THREE.MathUtils.smoothstep(worldState.sunDir.y, -0.14, 0.08);
    u.uEclipse.value = worldState.eclipseStrength;

    // Accent lightning & peak eclipse diamond/inner-limb radiance without painting a circular white bloom halo
    const eclipse = worldState.eclipseStrength;
    bloomPass.strength = 0.34 + worldState.lightningFlash * 0.07 - eclipse * 0.14;
    bloomPass.radius = 0.45 - eclipse * 0.15;
    bloomPass.threshold = 0.88 + eclipse * 0.28;

    // Compute exact screen-space horizon Y from camera orientation
    camera.getWorldDirection(_camForward);
    _horizonWorld.set(_camForward.x, 0, _camForward.z);
    if (_horizonWorld.lengthSq() < 1e-4) {
      _horizonWorld.set(0, 0, -1);
    }
    _horizonWorld.normalize().multiplyScalar(500).add(camera.position);
    _horizonWorld.project(camera);
    u.uHorizonY.value = THREE.MathUtils.clamp(_horizonWorld.y * 0.5 + 0.5, -0.25, 1.25);
  }

  function render(dt = 0.016) {
    updateUniforms();
    renderer.info.reset();
    composer.render(dt);
  }

  return {
    composer,
    setSize,
    render
  };
}
