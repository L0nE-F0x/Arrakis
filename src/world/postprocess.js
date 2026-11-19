import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const _camForward = new THREE.Vector3();
const _horizonWorld = new THREE.Vector3();
const _sunWorld = new THREE.Vector3();
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
    uEclipse: { value: 0 },
    uSunScreenPos: { value: new THREE.Vector2(0.5, 0.5) },
    uSunShaftStrength: { value: 0.0 },
    uSunColor: { value: new THREE.Color(0xffcfa0) },
    uGodRaySamples: { value: 20.0 },
    uSpiceTrance: { value: 0.0 },
    uStormExposure: { value: 0.0 },
    uOptics: { value: 0.0 }
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
    uniform vec2 uSunScreenPos;
    uniform float uSunShaftStrength;
    uniform vec3 uSunColor;
    uniform float uGodRaySamples;
    uniform float uSpiceTrance;
    uniform float uStormExposure;
    uniform float uOptics;
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

      // 2. Subtle optical chromatic rim dispersion near frame edges (amplified slightly in spice trance / optics)
      vec2 centered = vUv - 0.5;
      float r2 = dot(centered, centered);
      float disp = (0.00085 + uStorm * 0.00065 + uMirage * 0.00035 + uSpiceTrance * 0.0018 + uOptics * 0.0009) * r2;

      vec2 uvR = clamp(sampleUv + centered * disp, vec2(0.0005), vec2(0.9995));
      vec2 uvB = clamp(sampleUv - centered * disp, vec2(0.0005), vec2(0.9995));

      float r = texture2D(tDiffuse, uvR).r;
      vec4 gTex = texture2D(tDiffuse, sampleUv);
      float b = texture2D(tDiffuse, uvB).b;
      vec3 color = vec3(r, gTex.g, b);

      // 3. Screen-Space Volumetric Crepuscular Sun Shafts (God Rays) streaming past Windtrap, Tamarisks & Yardangs!
      if (uSunShaftStrength > 0.004) {
        vec2 toSun = uSunScreenPos - sampleUv;
        float sunDist = length(toSun);
        float radialFalloff = exp(-sunDist * 1.12);
        if (radialFalloff > 0.01) {
          float jitter = hash12(gl_FragCoord.xy + fract(uTime * 7.3) * 19.0);
          int steps = int(clamp(uGodRaySamples, 8.0, 28.0));
          float fSteps = float(steps);
          vec2 deltaUv = (toSun / fSteps) * 0.78;
          vec2 rayUv = sampleUv + deltaUv * jitter;
          float illuminationDecay = 1.0;
          float accum = 0.0;
          float weightSum = 0.0001;

          for (int i = 0; i < 28; i++) {
            if (i >= steps) break;
            rayUv += deltaUv;
            if (rayUv.x >= 0.0 && rayUv.x <= 1.0 && rayUv.y >= 0.0 && rayUv.y <= 1.0) {
              vec3 sCol = texture2D(tDiffuse, rayUv).rgb;
              float sLuma = dot(sCol, vec3(0.2126, 0.7152, 0.0722));
              // Select luminous sky & sun-gap pixels while silhouettes (trees, windtrap, cliffs) cast real shafts!
              float skyGate = smoothstep(0.48, 1.05, sLuma);
              accum += skyGate * illuminationDecay;
              weightSum += illuminationDecay;
            }
            illuminationDecay *= 0.95;
          }

          float shaft = (accum / weightSum) * radialFalloff * uSunShaftStrength;
          vec3 rayTint = mix(
            mix(uSunColor, vec3(1.0, 0.76, 0.40), 0.40),
            vec3(0.55, 0.76, 1.05),
            uEclipse * 0.85
          );
          color += rayTint * shaft * 0.64;

          // Subtle cinematic anamorphic warm lens streak across Canopus at low golden elevation
          float anamY = exp(-abs(sampleUv.y - uSunScreenPos.y) * 52.0);
          float anamX = exp(-abs(sampleUv.x - uSunScreenPos.x) * 3.6);
          color += rayTint * anamY * anamX * uSunShaftStrength * 0.095 * (1.0 - uStorm * 0.85);
        }
      }

      // 4. Dry static lightning upper-atmosphere scatter tint during Coriolis Storm
      if (uLightning > 0.001) {
        float skyGrad = smoothstep(0.18, 0.94, vUv.y);
        color *= 1.0 + uLightning * 0.14;
        color += vec3(0.76, 0.85, 1.12) * uLightning * (0.07 + 0.15 * skyGrad);
      }

      // 5. Mélange Spice warmth + "Eyes of Ibad" Prescient Trance Rim Aura on harvest
      if (uSpice > 0.01) {
        color = mix(color, color * vec3(1.045, 0.965, 0.945), uSpice * 0.45);
      }
      if (uSpiceTrance > 0.005) {
        float edgeRing = smoothstep(0.22, 0.72, length(centered));
        vec3 ibadBlue = vec3(0.22, 0.68, 1.25);
        color += ibadBlue * edgeRing * uSpiceTrance * 0.14;
        // Subtle contrast & clarity pop during spice trance
        color = mix(color, color * vec3(1.04, 1.03, 1.09), uSpiceTrance * 0.35);
      }

      // 6. Coriolis Storm Visor Sand-Lash Haze when walking exposed in storm
      if (uStormExposure > 0.01) {
        float edgeSand = smoothstep(0.25, 0.78, length(centered));
        float streak = sin(vUv.y * 55.0 + uTime * 22.0 + vUv.x * 18.0) * 0.5 + 0.5;
        vec3 gritCol = vec3(0.56, 0.31, 0.15);
        color = mix(color, gritCol, edgeSand * uStormExposure * (0.28 + 0.14 * streak));
      }

      // 7. Subtle warm cinema vignette + Electro-Optics binocular dark border when zooming
      vec2 vigCoord = centered * vec2(1.0, 0.88);
      float vigDist = length(vigCoord);
      float vig = smoothstep(0.46, 1.05, vigDist) * (0.12 + uStorm * 0.14);
      vec3 vigTint = mix(vec3(1.0), vec3(0.78, 0.68, 0.60), vig);
      color *= vigTint;

      if (uOptics > 0.01) {
        float lensR = length(centered * vec2(1.18, 1.0));

        // 1. Subtle warm-amber / Ibad-blue spectral contrast separation on distant spice & worm plumes
        //    with gentle optical dehaze keeping the central aiming aperture crystal clear and legible
        vec3 dehazed = clamp((color - 0.016 * uOptics) / (1.0 - 0.016 * uOptics), vec3(0.0), vec3(8.0));
        dehazed = mix(color, pow(max(dehazed, vec3(1e-4)), vec3(1.05)) * 1.04, 0.52 * uOptics);

        float optLuma = dot(dehazed, vec3(0.2126, 0.7152, 0.0722));
        float warmth = dehazed.r - dehazed.b;
        float distPlumeZone = 0.42 + 0.58 * (
          smoothstep(uHorizonY - 0.28, uHorizonY + 0.05, vUv.y) *
          (1.0 - smoothstep(uHorizonY + 0.25, uHorizonY + 0.55, vUv.y))
        );
        float plumeWarmMask = smoothstep(0.025, 0.24, warmth)
                            * smoothstep(0.05, 0.30, optLuma)
                            * (1.0 - smoothstep(0.78, 1.25, optLuma));
        float coolShadowMask = (1.0 - smoothstep(-0.02, 0.17, warmth))
                             * smoothstep(0.012, 0.20, optLuma)
                             * (1.0 - smoothstep(0.34, 0.72, optLuma));
        float shadowCrevice = (1.0 - smoothstep(0.04, 0.22, optLuma)) * smoothstep(0.008, 0.055, optLuma);

        vec3 warmAmberGrade = dehazed * vec3(1.072, 0.995, 0.888) + vec3(0.012, 0.005, -0.003) * optLuma;
        vec3 ibadShadowGrade = dehazed * vec3(0.918, 0.986, 1.112) + vec3(-0.002, 0.004, 0.014);

        color = dehazed;
        color = mix(color, warmAmberGrade, plumeWarmMask * distPlumeZone * 0.42 * uOptics);
        color = mix(color, ibadShadowGrade, clamp(coolShadowMask + shadowCrevice * 0.5, 0.0, 1.0) * distPlumeZone * 0.34 * uOptics);

        // 2. Ultra-subtle optical rangefinder micro-grid, stadia rings & scanline lens texture near periphery ONLY
        //    (lensR < 0.24 central aiming aperture stays 100% untouched & crystal clear)
        float periphZone = smoothstep(0.24, 0.43, lensR) * (1.0 - smoothstep(0.49, 0.59, lensR));
        if (periphZone > 0.002) {
          float scanWave = sin(gl_FragCoord.y * 2.094) * 0.5 + 0.5;
          vec2 gridCell = abs(fract(gl_FragCoord.xy / 32.0 - 0.5) - 0.5) * 32.0;
          float microGrid = 1.0 - smoothstep(0.0, 1.15, min(gridCell.x, gridCell.y));
          float ringA = exp(-pow((lensR - 0.355) / 0.0020, 2.0));
          float ringB = exp(-pow((lensR - 0.435) / 0.0016, 2.0));
          float stadiaArcs = (ringA * 0.65 + ringB * 0.45) * (0.65 + 0.35 * smoothstep(0.05, 0.22, abs(centered.x)));

          color *= 1.0 - scanWave * 0.026 * periphZone * uOptics;
          vec3 lensCoatTint = mix(vec3(0.36, 0.76, 1.06), vec3(1.0, 0.80, 0.48), 0.44);
          color += lensCoatTint * (microGrid * 0.015 + stadiaArcs * 0.024) * periphZone * uOptics;
        }

        // 3. Dielectric oil-lens rim sheen & binocular housing border vignette
        float bezelGleam = exp(-pow((lensR - 0.465) / 0.016, 2.0)) * uOptics;
        color += vec3(0.14, 0.40, 0.68) * bezelGleam * 0.042;
        float opticMask = 1.0 - smoothstep(0.43, 0.59, lensR) * 0.88 * uOptics;
        color *= opticMask;
      }

      // 8. Subtle natural 35mm film grain + 8-bit sky/horizon dither (velvety-clean in darks, zero speckle)
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      float lumaWeight = smoothstep(0.03, 0.30, luma);
      float n = hash12(gl_FragCoord.xy + vec2(fract(uTime * 19.7) * 513.0, fract(uTime * 11.3) * 389.0));
      float dither = (hash12(gl_FragCoord.xy) - 0.5) * 0.0014 * mix(0.25, 1.0, lumaWeight);
      float darkScene = clamp(max(uNight, uEclipse), 0.0, 1.0);
      float baseAmp = mix(0.0085 + uStorm * 0.005, 0.0042 + uStorm * 0.003, darkScene);
      float grainAmp = baseAmp * mix(0.20, 1.0, lumaWeight);
      color = max(vec3(0.0), color + (n - 0.5) * grainAmp + dither);

      gl_FragColor = vec4(color, gTex.a);
    }
  `
};

export function createPostProcess(renderer, scene, camera, worldState) {
  renderer.info.autoReset = false;

  const composer = new EffectComposer(renderer);
  const qCfg = worldState?.getQualityConfig?.() || { pixelRatioCap: 2.0, godRaySamples: 20 };
  const pixelRatio = Math.min(window.devicePixelRatio || 1, qCfg.pixelRatioCap);
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
    const cap = worldState?.getQualityConfig?.().pixelRatioCap || 2.0;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
  }

  function applyQuality() {
    setSize(window.innerWidth, window.innerHeight);
  }

  function updateUniforms() {
    const u = atmoPass.uniforms;
    const q = worldState?.getQualityConfig?.() || { godRaySamples: 20 };
    u.uTime.value = worldState.elapsed;
    u.uGodRaySamples.value = q.godRaySamples;

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
    u.uSunColor.value.copy(worldState.sunColor);

    u.uSpiceTrance.value = worldState.player?.spiceTrance || 0;
    u.uStormExposure.value = worldState.player?.active ? (worldState.player.stormExposure || 0) : 0;
    u.uOptics.value = worldState.player?.active
      ? THREE.MathUtils.clamp((worldState.player.opticsZoom - 1.0) / 2.2, 0, 1)
      : 0;

    // Crisp selective bloom (slightly heightened during spice trance or lightning)
    const eclipse = worldState.eclipseStrength;
    bloomPass.strength =
      0.34 +
      worldState.lightningFlash * 0.07 +
      (worldState.player?.spiceTrance || 0) * 0.08 -
      eclipse * 0.14;
    bloomPass.radius = 0.45 - eclipse * 0.15;
    bloomPass.threshold = 0.88 + eclipse * 0.28;

    // Screen-space horizon Y & Canopus Sun Screen Projection for Volumetric Crepuscular God Rays
    camera.getWorldDirection(_camForward);
    _horizonWorld.set(_camForward.x, 0, _camForward.z);
    if (_horizonWorld.lengthSq() < 1e-4) {
      _horizonWorld.set(0, 0, -1);
    }
    _horizonWorld.normalize().multiplyScalar(500).add(camera.position);
    _horizonWorld.project(camera);
    u.uHorizonY.value = THREE.MathUtils.clamp(_horizonWorld.y * 0.5 + 0.5, -0.25, 1.25);

    const sunFacing = _camForward.dot(worldState.sunDir);
    const sunAbove = THREE.MathUtils.smoothstep(worldState.sunDir.y, -0.02, 0.08);
    // Low golden-hour & dawn angles cast the most dramatic volumetric crepuscular rays; softer at harsh high noon
    const lowSunDrama = 1.0 - THREE.MathUtils.smoothstep(worldState.sunDir.y, 0.28, 0.65) * 0.52;
    const stormAtten = 1.0 - worldState.weatherWeights.coriolisStorm * 0.88;
    const facingGate = THREE.MathUtils.smoothstep(sunFacing, 0.12, 0.68);
    const shaftStrength =
      facingGate *
      sunAbove *
      lowSunDrama *
      stormAtten *
      (0.55 + worldState.eclipseStrength * 0.22);

    if (shaftStrength > 0.002) {
      _sunWorld.copy(camera.position).addScaledVector(worldState.sunDir, 450);
      _sunWorld.project(camera);
      const sx = _sunWorld.x * 0.5 + 0.5;
      const sy = _sunWorld.y * 0.5 + 0.5;
      const offscreenFade =
        1.0 -
        THREE.MathUtils.smoothstep(
          Math.max(Math.abs(sx - 0.5), Math.abs(sy - 0.5)),
          0.48,
          1.05
        );
      u.uSunScreenPos.value.set(sx, sy);
      u.uSunShaftStrength.value = shaftStrength * offscreenFade;
    } else {
      u.uSunShaftStrength.value = 0.0;
    }
  }

  function render(dt = 0.016) {
    updateUniforms();
    renderer.info.reset();
    composer.render(dt);
  }

  return {
    composer,
    setSize,
    applyQuality,
    render
  };
}
