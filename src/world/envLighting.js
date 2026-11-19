import * as THREE from 'three';

/**
 * Procedural Real-Time PMREM Environment Map (IBL) for Arrakis.
 * Gives metallic surfaces (Windtrap brass, Thumper steel, Ornithopter hull & glass,
 * Fremen brazier, Glowglobe cage, wet sand, Muad'Dib's eyes) crisp, physically-accurate
 * reflections of Canopus, the desert sky dome, and warm sand bounce without external HDRIs.
 */
export function createEnvironmentIBL(renderer, scene, worldState) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const envScene = new THREE.Scene();

  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0.22, 0.14, -0.96) },
    uSunColor: { value: new THREE.Color(0xffcfa0) },
    uZenithColor: { value: new THREE.Color(0x4b6088) },
    uHorizonColor: { value: new THREE.Color(0xe6ac7c) },
    uGroundColor: { value: new THREE.Color(0x885c3a) },
    uSunIntensity: { value: 3.0 },
    uEclipse: { value: 0.0 },
    uStorm: { value: 0.0 }
  };

  const envMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uZenithColor;
      uniform vec3 uHorizonColor;
      uniform vec3 uGroundColor;
      uniform float uSunIntensity;
      uniform float uEclipse;
      uniform float uStorm;
      varying vec3 vDir;

      void main() {
        vec3 d = normalize(vDir);
        vec3 sunD = normalize(uSunDir);
        float up = clamp(d.y, 0.0, 1.0);
        float down = clamp(-d.y, 0.0, 1.0);

        vec3 sky = mix(uHorizonColor, uZenithColor, pow(up, 0.52));
        vec3 ground = mix(uHorizonColor * 0.52, uGroundColor * 0.72, pow(down, 0.42));
        vec3 col = mix(sky, ground, smoothstep(0.04, -0.08, d.y));

        // Canopus specular highlight lobe in IBL for crisp metallic sun-glints
        float sunDot = max(dot(d, sunD), 0.0);
        float sunUp = smoothstep(-0.04, 0.12, sunD.y);
        float sunGlow = pow(sunDot, 16.0) * 0.45 + pow(sunDot, 180.0) * 2.8;
        col += uSunColor * sunGlow * sunUp * (uSunIntensity * 0.36) * (1.0 - uEclipse * 0.85) * (1.0 - uStorm * 0.72);

        // Subtle cool moon/coronal highlight in night & eclipse reflections
        float nightBoost = max(1.0 - sunUp, uEclipse);
        vec3 moonDir = normalize(vec3(-0.11, 0.34, -0.93));
        float mDot = max(dot(d, moonDir), 0.0);
        col += vec3(0.42, 0.62, 0.96) * (pow(mDot, 64.0) * 0.65 + pow(mDot, 12.0) * 0.12) * nightBoost * (1.0 - uStorm * 0.6);

        gl_FragColor = vec4(max(col, vec3(0.004)), 1.0);
      }
    `
  });

  const dome = new THREE.Mesh(new THREE.SphereGeometry(20, 24, 16), envMat);
  envScene.add(dome);

  let currentRT = null;
  let lastKey = '';
  let cooldown = 0;

  function computeKey() {
    // Quantize key so PMREM rebuilds smoothly only when sky mood meaningfully shifts
    const sy = Math.round(worldState.sunDir.y * 28);
    const sx = Math.round(worldState.sunDir.x * 16);
    const ec = Math.round(worldState.eclipseStrength * 12);
    const st = Math.round(worldState.weatherWeights.coriolisStorm * 10);
    return `${sy}:${sx}:${ec}:${st}`;
  }

  function rebuild() {
    uniforms.uSunDir.value.copy(worldState.sunDir);
    uniforms.uSunColor.value.copy(worldState.sunColor);
    uniforms.uZenithColor.value.copy(worldState.skyZenithColor);
    uniforms.uHorizonColor.value.copy(worldState.skyHorizonColor);
    uniforms.uGroundColor.value.copy(worldState.ambientGroundColor);
    uniforms.uSunIntensity.value = worldState.sunIntensity;
    uniforms.uEclipse.value = worldState.eclipseStrength;
    uniforms.uStorm.value = worldState.weatherWeights.coriolisStorm;

    const nextRT = pmrem.fromScene(envScene, 0.035);
    scene.environment = nextRT.texture;
    // Keep subtle physical IBL contribution so night stays richly dark and daylight metals gleam
    const sunUp = THREE.MathUtils.smoothstep(worldState.sunDir.y, -0.10, 0.22);
    scene.environmentIntensity = THREE.MathUtils.lerp(0.42, 0.88, sunUp) * (1.0 - worldState.eclipseStrength * 0.35);

    if (currentRT) {
      currentRT.dispose();
    }
    currentRT = nextRT;
    lastKey = computeKey();
  }

  rebuild();

  function update(dt, force = false) {
    cooldown -= Math.max(0, dt || 0);
    const key = computeKey();
    if (force || (key !== lastKey && cooldown <= 0)) {
      rebuild();
      cooldown = 0.28;
    } else if (scene) {
      const sunUp = THREE.MathUtils.smoothstep(worldState.sunDir.y, -0.10, 0.22);
      scene.environmentIntensity = THREE.MathUtils.lerp(0.42, 0.88, sunUp) * (1.0 - worldState.eclipseStrength * 0.35);
    }
  }

  function dispose() {
    if (currentRT) currentRT.dispose();
    dome.geometry.dispose();
    envMat.dispose();
    pmrem.dispose();
  }

  return { update, rebuild, dispose };
}
