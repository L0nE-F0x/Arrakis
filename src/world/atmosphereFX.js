import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { NOISE_GLSL } from '../shaders/noise.glsl.js';
import { CISTERN_CENTER, WATER_LEVEL, getGroundHeight, smoothstep } from './terrainMath.js';

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// 1. CISTERN DAWN & NIGHT CONDENSATION MIST (Seamless Horizontal Vapor Veils)
//    Note: Uses grazing view-normal fade + world-height envelope (NO surface length(vLocalPos) bug!)
// ============================================================================

function buildCisternMistSystem() {
  const MIST_COUNT = 44;
  const geo = new THREE.IcosahedronGeometry(1.0, 2);

  const uniforms = {
    uTime: { value: 0 },
    uOpacity: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.20, 0.12, -0.96) },
    uSunColor: { value: new THREE.Color(0xffcfa0) },
    uHorizonColor: { value: new THREE.Color(0xe6ac7c) },
    uZenithColor: { value: new THREE.Color(0x4b6088) },
    uWindDir: { value: new THREE.Vector2(1, 0) }
  };

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      void main() {
        vec4 wp = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          mat3 im = mat3(instanceMatrix);
          vec3 invScale2 = 1.0 / max(vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2])), vec3(1e-4));
          vNormalW = normalize(mat3(modelMatrix) * (im * (normal * invScale2)));
        #else
          vNormalW = normalize(mat3(modelMatrix) * normal);
        #endif
        wp = modelMatrix * wp;
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uTime;
      uniform float uOpacity;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uHorizonColor;
      uniform vec3 uZenithColor;
      uniform vec2 uWindDir;

      varying vec3 vWorldPos;
      varying vec3 vNormalW;

      void main() {
        if (uOpacity <= 0.002) discard;

        vec3 N = normalize(vNormalW);
        vec3 viewDelta = cameraPosition - vWorldPos;
        float dist = length(viewDelta);
        vec3 V = viewDelta / max(dist, 1e-4);

        // Soft 3D ellipsoidal grazing falloff + smooth water-surface & vertical height envelope
        float grazingSoft = pow(clamp(abs(dot(N, V)), 0.0, 1.0), 2.15);
        float waterFloor = smoothstep(${(WATER_LEVEL - 0.04).toFixed(2)}, ${(WATER_LEVEL + 0.16).toFixed(2)}, vWorldPos.y);
        float upperCeil = 1.0 - smoothstep(${(WATER_LEVEL + 0.65).toFixed(2)}, ${(WATER_LEVEL + 1.55).toFixed(2)}, vWorldPos.y);
        float camSoft = smoothstep(1.4, 4.4, dist);

        vec3 driftCoord = vec3(
          vWorldPos.x * 0.28 - uWindDir.x * uTime * 0.16,
          vWorldPos.y * 1.35,
          vWorldPos.z * 0.28 - uWindDir.y * uTime * 0.16
        );
        float wisp = fbm3(driftCoord) * 0.66 + vnoise3(driftCoord * 2.4 + vec3(3.1, -1.7, 2.4)) * 0.34;
        float vapor = smoothstep(0.36, 0.80, wisp);

        float alpha = grazingSoft * waterFloor * upperCeil * camSoft * vapor * uOpacity;
        if (alpha < 0.002) discard;

        vec3 sunD = normalize(uSunDir);
        float sunUp = smoothstep(-0.06, 0.16, sunD.y);
        float mie = pow(max(dot(-V, sunD), 0.0), 3.2) * sunUp;

        vec3 nightMist = mix(vec3(0.08, 0.13, 0.24), vec3(0.16, 0.24, 0.38), 0.48);
        vec3 dayMist = mix(uHorizonColor, vec3(1.0, 0.90, 0.76), 0.36) + uSunColor * (0.38 * mie);
        vec3 mistCol = mix(nightMist, dayMist, sunUp);

        gl_FragColor = vec4(mistCol, clamp(alpha, 0.0, 0.24));
      }
    `
  });

  const mistIM = new THREE.InstancedMesh(geo, mat, MIST_COUNT);
  mistIM.frustumCulled = false;
  mistIM.renderOrder = 4;

  const rand = mulberry32(1907);
  const specs = [];
  for (let i = 0; i < MIST_COUNT; i++) {
    // Drifting morning/night vapor ribbons hovering across the Dew Cistern & beneath overhanging Tamarisk boughs
    const ang = -Math.PI * 0.98 + (i / MIST_COUNT) * Math.PI * 1.96 + (rand() - 0.5) * 0.24;
    const rad = 1.2 + rand() * 7.4;
    specs.push({
      x: CISTERN_CENTER.x + Math.cos(ang) * rad,
      y: WATER_LEVEL + 0.26 + rand() * 0.68,
      z: CISTERN_CENTER.z - 1.4 + Math.sin(ang) * rad * 0.92,
      rx: 2.6 + rand() * 3.2,
      ry: 0.36 + rand() * 0.38,
      rz: 2.0 + rand() * 2.6,
      phase: rand() * Math.PI * 2
    });
  }

  const dummy = new THREE.Object3D();
  function update(_dt, worldState) {
    if (!worldState) return;
    const t = worldState.elapsed;
    const sy = worldState.sunDir.y;

    const dawnDusk = Math.exp(-Math.pow((sy - 0.10) / 0.17, 2.0));
    const nightMist = 1.0 - smoothstep(-0.12, 0.06, sy);
    const windScatter = 1.0 - smoothstep(0.75, 1.45, worldState.windSpeed) * 0.72;
    const mistStrength = clamp(Math.max(dawnDusk * 1.0, nightMist * 0.20) * windScatter, 0, 1);

    uniforms.uTime.value = t;
    uniforms.uOpacity.value = mistStrength * 0.24;
    uniforms.uSunDir.value.copy(worldState.sunDir);
    uniforms.uSunColor.value.copy(worldState.sunColor);
    uniforms.uHorizonColor.value.copy(worldState.skyHorizonColor);
    uniforms.uZenithColor.value.copy(worldState.skyZenithColor);
    uniforms.uWindDir.value.copy(worldState.windDir);

    mistIM.visible = mistStrength > 0.01;
    if (!mistIM.visible) return;

    for (let i = 0; i < MIST_COUNT; i++) {
      const s = specs[i];
      const driftX = Math.sin(t * 0.18 + s.phase) * 0.65;
      const driftZ = Math.cos(t * 0.15 + s.phase) * 0.55;
      dummy.position.set(s.x + driftX, s.y + Math.sin(t * 0.35 + s.phase) * 0.05, s.z + driftZ);
      dummy.rotation.set(0, s.phase + t * 0.03, 0);
      dummy.scale.set(s.rx, s.ry, s.rz);
      dummy.updateMatrix();
      mistIM.setMatrixAt(i, dummy.matrix);
    }
    mistIM.instanceMatrix.needsUpdate = true;
  }

  return { group: mistIM, update };
}

// ============================================================================
// 2. SWIRLING 3D DUST DEVIL VORTEX FUNNELS (Smooth Single-Shell FBM Helical Columns — Zero Polygon Cone Ribs!)
// ============================================================================

function createDustDevilFunnelGeometry() {
  const cyl = new THREE.CylinderGeometry(2.35, 0.58, 1.0, 48, 32, true);
  cyl.translate(0, 0.5, 0);
  return cyl;
}

function buildDustDevilsSystem(worldState) {
  const devilsRoot = new THREE.Group();
  devilsRoot.name = 'ArrakisDustDevils';

  const funnelGeo = createDustDevilFunnelGeometry();
  const count = worldState?.dustDevils?.length || 3;

  const devilMeshes = [];
  for (let i = 0; i < count; i++) {
    const uniforms = {
      uTime: { value: 0 },
      uSpin: { value: 4.5 },
      uStrength: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.3, 0.5, -0.8) },
      uSunColor: { value: new THREE.Color(0xffcfa0) },
      uHorizonColor: { value: new THREE.Color(0xe6ac7c) },
      uSeed: { value: i * 3.7 + 1.1 }
    };

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      uniforms,
      vertexShader: /* glsl */ `
        ${NOISE_GLSL}
        uniform float uTime;
        uniform float uSpin;
        uniform float uSeed;
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        varying vec3 vWorldPos;

        void main() {
          vUv = uv;
          float h = clamp(uv.y, 0.0, 1.0);
          vec3 p = position;
          // Organic wind-sheared S-curve lean + subtle 3D FBM silhouette breakup (zero geometric cone lines!)
          float wobble = sin(uTime * 1.6 + uSeed + h * 3.4) * 0.34 * h;
          float fbmOut = (fbm3(p * 1.8 + vec3(0.0, -uTime * 1.4, uSeed)) - 0.5) * 0.42;
          p.xz *= (1.0 + fbmOut + pow(1.0 - h, 3.0) * 0.65);
          p.x += pow(h, 1.45) * 1.45 + wobble;
          p.z += sin(h * 2.6 + uSeed) * 0.48;

          vec4 wp = modelMatrix * vec4(p, 1.0);
          vWorldPos = wp.xyz;
          // Use strictly horizontal radial outward normal so non-uniform Y-scale (28m height) NEVER tilts normals downward!
          vec3 horizRadial = normalize(vec3(position.x, 0.0, position.z));
          vNormalW = normalize(vec3((modelMatrix * vec4(horizRadial, 0.0)).x, 0.0, (modelMatrix * vec4(horizRadial, 0.0)).z));
          vViewDir = normalize(vec3(cameraPosition.x - wp.x, 0.0, cameraPosition.z - wp.z));
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        ${NOISE_GLSL}
        uniform float uTime;
        uniform float uSpin;
        uniform float uStrength;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uHorizonColor;
        uniform float uSeed;

        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        varying vec3 vWorldPos;

        void main() {
          if (uStrength <= 0.005) discard;
          float h = vUv.y;

          // Smooth horizontal radial centerline falloff: 1.0 at vortex core, 0.0 at grazing edges (zero cone ribs!)
          float cylFacing = pow(clamp(dot(normalize(vNormalW), normalize(vViewDir)), 0.0, 1.0), 1.85);
          float vertEnv = smoothstep(0.0, 0.14, h) * (1.0 - smoothstep(0.52, 0.98, h));

          float ang = vUv.x * 6.2831853;
          float twist = ang * 2.0 + h * 12.5 - uTime * uSpin;
          vec2 swirlUv = vec2(cos(twist) * 1.4 + sin(twist) * 0.4, h * 5.0 - uTime * 1.5 + uSeed);
          float dustBand = fbm2(swirlUv * 1.8) * 0.62 + vnoise2(swirlUv * 4.0) * 0.38;
          float worldCloud = fbm3(vWorldPos * 0.28 + vec3(0.0, -uTime * 2.2, uSeed));

          float baseKick = (1.0 - smoothstep(0.0, 0.36, h)) * 0.68;
          float density = (smoothstep(0.22, 0.76, dustBand * 0.65 + worldCloud * 0.35) * 1.12 + baseKick) * cylFacing * vertEnv * uStrength;
          if (density < 0.006) discard;

          float sunLit = clamp(dot(normalize(vNormalW), normalize(vec3(uSunDir.x, 0.25, uSunDir.z))) * 0.5 + 0.5, 0.0, 1.0);
          float sunUp = smoothstep(-0.06, 0.18, uSunDir.y);
          vec3 shadowDust = mix(vec3(0.14, 0.10, 0.16), vec3(0.52, 0.31, 0.16), sunUp);
          vec3 litDust = mix(uHorizonColor * 0.95, mix(vec3(0.95, 0.70, 0.42), uSunColor, 0.32), sunUp);
          vec3 col = mix(shadowDust, litDust, smoothstep(0.16, 0.86, sunLit));

          gl_FragColor = vec4(col, clamp(density * 0.78, 0.0, 0.80));
        }
      `
    });

    const mesh = new THREE.Mesh(funnelGeo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    devilsRoot.add(mesh);
    devilMeshes.push({ mesh, uniforms });
  }

  function update(_dt, state) {
    if (!state || !state.dustDevils) return;
    for (let i = 0; i < devilMeshes.length; i++) {
      const d = state.dustDevils[i];
      const dm = devilMeshes[i];
      if (!d) continue;
      dm.mesh.visible = d.strength > 0.01;
      if (!dm.mesh.visible) continue;

      const gy = getGroundHeight(d.x, d.z) - 0.35;
      dm.mesh.position.set(d.x, gy, d.z);
      dm.mesh.scale.set(d.radius * 0.66, d.height, d.radius * 0.66);

      dm.uniforms.uTime.value = state.elapsed;
      dm.uniforms.uSpin.value = d.spin;
      dm.uniforms.uStrength.value = d.strength;
      dm.uniforms.uSunDir.value.copy(state.sunDir);
      dm.uniforms.uSunColor.value.copy(state.sunColor);
      dm.uniforms.uHorizonColor.value.copy(state.skyHorizonColor);
    }
  }

  return { group: devilsRoot, update };
}

// ============================================================================
// 3. MÉLANGE SPICE BLOW PLINIAN GEYSER & PYROCLASTIC CAULIFLOWER CLOUD
//    (3D vertex-displaced + high-freq ridged billows + basal sand-jet column; ZERO smooth bubblegum spheres!)
// ============================================================================

function buildSpiceBlowSystem() {
  const spiceRoot = new THREE.Group();
  spiceRoot.name = 'ArrakisMelangeSpiceBlow';

  // A) Smooth FrontSide FBM-dissolved basal geyser eruption column (zero cylinder ribs or flat rectangles!)
  const jetGeo = new THREE.CylinderGeometry(5.6, 2.4, 15.0, 40, 20, true);
  jetGeo.translate(0, 7.5, 0);
  const jetUniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.4, 0.6, -0.6) },
    uSunColor: { value: new THREE.Color(0xffcfa0) }
  };
  const jetMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    uniforms: jetUniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vWorldPos;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uTime;
      uniform float uIntensity;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vWorldPos;

      void main() {
        if (uIntensity <= 0.01) discard;
        float facing = pow(clamp(dot(normalize(vNormalW), normalize(vViewDir)), 0.0, 1.0), 2.2);
        float envY = smoothstep(0.0, 0.16, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));

        vec3 q = vWorldPos * vec3(0.32, 0.16, 0.32) - vec3(0.0, uTime * 2.8, 0.0);
        float streaks = fbm3(q) * 0.6 + vnoise3(q * 2.6) * 0.4;
        float alpha = smoothstep(0.28, 0.80, streaks) * facing * envY * uIntensity * 0.85;
        if (alpha < 0.01) discard;

        float sunLit = clamp(dot(normalize(vNormalW), normalize(uSunDir)) * 0.5 + 0.5, 0.0, 1.0);
        vec3 darkSand = vec3(0.30, 0.11, 0.042);
        vec3 brightJet = mix(vec3(0.84, 0.44, 0.16), uSunColor, 0.32);
        vec3 col = mix(darkSand, brightJet, smoothstep(0.16, 0.84, sunLit));
        col += vec3(0.18, 0.62, 1.10) * pow(1.0 - vUv.y, 2.8) * smoothstep(0.58, 0.94, streaks) * 0.55;

        gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.82));
      }
    `
  });
  const jetMesh = new THREE.Mesh(jetGeo, jetMat);
  jetMesh.frustumCulled = false;
  jetMesh.renderOrder = 5;
  spiceRoot.add(jetMesh);

  // B) 76 Vertex-Displaced Pyroclastic Cauliflower Mélange Lobes (subdiv 3 + 3D FBM craggy displacement!)
  const LOBE_COUNT = 76;
  const lobeGeo = new THREE.IcosahedronGeometry(1.0, 3);
  const uniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.4, 0.6, -0.6) },
    uSunColor: { value: new THREE.Color(0xffcfa0) }
  };

  const lobeMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms,
    vertexShader: /* glsl */ `
      ${NOISE_GLSL}
      attribute float aHeightFrac;
      attribute float aLobeSeed;
      uniform float uTime;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vWorldP;
      varying float vHFrac;
      varying float vDisp;
      void main() {
        vHFrac = aHeightFrac;
        // Craggy 3D FBM cauliflower vertex displacement breaks any spherical silhouette completely!
        float n1 = fbm3(position * 2.35 + vec3(aLobeSeed * 3.1, -uTime * 0.65, aLobeSeed * 1.7));
        float n2 = vnoise3(position * 5.2 + vec3(-aLobeSeed * 2.3, -uTime * 1.1, 1.9));
        float disp = (n1 - 0.46) * 0.52 + (n2 - 0.5) * 0.22;
        vDisp = n1;
        vec3 displaced = position + normal * disp;
        vec3 pertN = normalize(normal + (vec3(n1, n2, 1.0 - n1) - 0.5) * 0.55);

        vec4 wp = vec4(displaced, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * pertN);
        #else
          vNormalW = normalize(mat3(modelMatrix) * pertN);
        #endif
        wp = modelMatrix * wp;
        vWorldP = wp.xyz;
        vViewDir = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uTime;
      uniform float uIntensity;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vWorldP;
      varying float vHFrac;
      varying float vDisp;

      void main() {
        if (uIntensity <= 0.005) discard;
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(vViewDir);
        float rim = clamp(dot(N, V), 0.0, 1.0);

        // Multi-octave world-space domain-warped pyroclastic dust turbulence (zero caustic web loops or bluish sky fringe!)
        vec3 q = vWorldP * 0.22 + vec3(0.0, -uTime * 0.85, uTime * 0.25);
        vec3 warp = vec3(fbm3(q), fbm3(q + vec3(4.2, 1.7, -2.9)), fbm3(q + vec3(-3.1, 5.4, 2.2))) - 0.5;
        float coarse = fbm3(q * 1.6 + warp * 1.4);
        float fineBillow = fbm3(q * 3.8 + warp * 1.6);
        float turb = coarse * 0.64 + fineBillow * 0.36;

        float edgeMask = pow(rim, 2.10) * smoothstep(0.26, 0.76, turb + rim * 0.30);
        if (edgeMask < 0.012) discard;

        // Warm desert sand-and-cinnamon Mélange palette (warm russet-ochre shadows eliminate bluish sky fringe!)
        vec3 deepShadow = vec3(0.36, 0.15, 0.065);
        vec3 richCinnamon = vec3(0.66, 0.28, 0.10);
        vec3 sunlitOchre = mix(vec3(0.94, 0.62, 0.28), uSunColor, 0.34);

        vec3 billowN = normalize(N + (warp * 1.35));
        float sunLit = clamp(dot(billowN, normalize(uSunDir)) * 0.5 + 0.5, 0.0, 1.0);
        float foldShade = clamp(sunLit * (0.68 + 0.52 * turb), 0.0, 1.0);

        vec3 col = mix(deepShadow, richCinnamon, smoothstep(0.10, 0.58, foldShade));
        col = mix(col, sunlitOchre, smoothstep(0.52, 0.92, foldShade) * (0.45 + 0.55 * vHFrac));

        // Subtle warm-amber & localized spice-blue glint pockets (zero web-like 1-abs caustic loops!)
        float spark = pow(smoothstep(0.64, 0.90, fineBillow * coarse * 1.35), 2.6) * (1.0 - smoothstep(0.0, 0.42, vHFrac));
        col += vec3(0.22, 0.58, 0.95) * spark * 0.38;

        gl_FragColor = vec4(col, clamp(edgeMask * uIntensity * 0.88, 0.0, 0.90));
      }
    `
  });

  const lobeIM = new THREE.InstancedMesh(lobeGeo, lobeMat, LOBE_COUNT);
  const hFracArr = new Float32Array(LOBE_COUNT);
  const seedArr = new Float32Array(LOBE_COUNT);
  const rand = mulberry32(8088);
  const lobeSpecs = [];
  for (let i = 0; i < LOBE_COUNT; i++) {
    const u = i / (LOBE_COUNT - 1);
    hFracArr[i] = u;
    seedArr[i] = rand() * 10.0;
    lobeSpecs.push({
      u,
      ang: rand() * Math.PI * 2,
      radJitter: 0.45 + rand() * 0.85,
      scale: 1.8 + Math.pow(u, 0.82) * 5.2 + rand() * 1.6,
      speed: 0.42 + rand() * 0.35
    });
  }
  lobeGeo.setAttribute('aHeightFrac', new THREE.InstancedBufferAttribute(hFracArr, 1));
  lobeGeo.setAttribute('aLobeSeed', new THREE.InstancedBufferAttribute(seedArr, 1));
  lobeIM.frustumCulled = false;
  lobeIM.renderOrder = 5;
  spiceRoot.add(lobeIM);

  const dummy = new THREE.Object3D();

  function update(_dt, worldState) {
    if (!worldState) return;
    const intensity = worldState.spiceBlow.intensity;
    spiceRoot.visible = intensity > 0.01;
    if (!spiceRoot.visible) return;

    const t = worldState.elapsed;
    const ox = worldState.spiceBlow.origin.x;
    const oz = worldState.spiceBlow.origin.z;
    const oy = getGroundHeight(ox, oz);

    jetMesh.position.set(ox, oy - 1.2, oz);
    jetMesh.scale.set(1.0, intensity, 1.0);
    jetUniforms.uTime.value = t;
    jetUniforms.uIntensity.value = intensity;
    jetUniforms.uSunDir.value.copy(worldState.sunDir);
    jetUniforms.uSunColor.value.copy(worldState.sunColor);

    uniforms.uTime.value = t;
    uniforms.uIntensity.value = intensity;
    uniforms.uSunDir.value.copy(worldState.sunDir);
    uniforms.uSunColor.value.copy(worldState.sunColor);

    for (let i = 0; i < LOBE_COUNT; i++) {
      const s = lobeSpecs[i];
      const cycleU = (s.u + t * 0.08 * s.speed) % 1.0;
      const h = Math.pow(cycleU, 0.86) * 35.0 * intensity;
      const funnelSpread = cycleU < 0.42 ? mix(1.6, 4.4, cycleU / 0.42) : mix(4.4, 14.8, (cycleU - 0.42) / 0.58);
      const r = funnelSpread * s.radJitter;
      const swirlA = s.ang + t * (0.85 - cycleU * 0.45);
      const windDriftX = worldState.windDir.x * Math.pow(cycleU, 1.5) * 13.5;
      const windDriftZ = worldState.windDir.y * Math.pow(cycleU, 1.5) * 13.5;

      dummy.position.set(
        ox + Math.cos(swirlA) * r + windDriftX,
        oy + 0.2 + h,
        oz + Math.sin(swirlA) * r + windDriftZ
      );
      dummy.rotation.set(t * 0.22 + i, swirlA, i * 0.7);
      const sc = s.scale * (0.45 + 0.55 * intensity) * (1.0 - smoothstep(0.84, 1.0, cycleU) * 0.38);
      dummy.scale.set(sc * 1.16, sc * 0.90, sc * 1.16);
      dummy.updateMatrix();
      lobeIM.setMatrixAt(i, dummy.matrix);
    }
    lobeIM.instanceMatrix.needsUpdate = true;
  }

  return { group: spiceRoot, update };
}

// ============================================================================
// 4. CORIOLIS HABOOB SANDSTORM WALL, UNFOGGED HDR LIGHTNING & WIND-STREAK SALTATION
// ============================================================================

function buildCoriolisHaboobSystem() {
  const haboobRoot = new THREE.Group();
  haboobRoot.name = 'CoriolisHaboobWall';

  const CELL_COUNT = 132;
  const cellGeo = new THREE.IcosahedronGeometry(1.0, 3);
  const uniforms = {
    uTime: { value: 0 },
    uStorm: { value: 0 },
    uSunDir: { value: new THREE.Vector3(-0.4, 0.2, -0.9) },
    uSunColor: { value: new THREE.Color(0xffb878) },
    uHorizonColor: { value: new THREE.Color(0xa66335) },
    uLightning: { value: 0 },
    uLightningPos: { value: new THREE.Vector3(6, 30, -102) }
  };

  const cellMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms,
    vertexShader: /* glsl */ `
      ${NOISE_GLSL}
      attribute float aCellSeed;
      uniform float uTime;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      void main() {
        // Craggy 3D FBM shelf-cloud vertex displacement kills any smooth spherical pillow silhouette!
        float disp = (fbm3(position * 2.5 + vec3(aCellSeed * 2.7, -uTime * 0.35, aCellSeed)) - 0.45) * 0.48;
        vec3 p = position + normal * disp;
        vec4 wp = vec4(p, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        #else
          vNormalW = normalize(mat3(modelMatrix) * normal);
        #endif
        wp = modelMatrix * wp;
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uTime;
      uniform float uStorm;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uHorizonColor;
      uniform float uLightning;
      uniform vec3 uLightningPos;

      varying vec3 vWorldPos;
      varying vec3 vNormalW;

      void main() {
        if (uStorm <= 0.01) discard;
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vWorldPos);
        float rim = clamp(dot(N, V), 0.0, 1.0);

        // Multi-scale world-space domain-warped FBM haboob shelf-cloud turbulence (zero wormy 1-abs loops, zero horizon sky slits!)
        vec3 wq = vWorldPos * vec3(0.065, 0.095, 0.085) + vec3(uTime * 0.18, -uTime * 0.28, uTime * 0.14);
        vec3 warp = vec3(fbm3(wq), fbm3(wq + vec3(5.2, -2.4, 3.1)), fbm3(wq + vec3(-3.7, 4.1, -1.8))) - 0.5;
        float boilMacro = fbm3(wq * 1.85 + warp * 1.55);
        float boilMid = fbm3(wq * 4.2 + warp * 1.9);
        float boilFine = vnoise3(vWorldPos * 0.36 + warp * 3.0);
        float boil = boilMacro * 0.52 + boilMid * 0.32 + boilFine * 0.16;

        float groundFeather = smoothstep(-6.0, 2.0, vWorldPos.y);
        float soft = pow(rim, 2.35) * smoothstep(0.22, 0.74, boil + rim * 0.28) * groundFeather;
        if (soft < 0.012) discard;

        float hNorm = clamp(vWorldPos.y / 62.0, 0.0, 1.0);
        vec3 turbN = normalize(N + warp * 1.45);
        float sunLit = clamp(dot(turbN, normalize(uSunDir)) * 0.5 + 0.5, 0.0, 1.0);
        float foldLit = clamp(sunLit * (0.62 + 0.58 * boil), 0.0, 1.0);

        // Deep brooding chocolate-umber storm belly contrasting dramatically against the incandescent lightning bolt!
        vec3 abyssBelly = vec3(0.032, 0.015, 0.008);
        vec3 ochreWall  = vec3(0.32, 0.16, 0.075);
        vec3 sunlitAnvil = mix(uHorizonColor, uSunColor, 0.25) * 0.65;

        vec3 col = mix(abyssBelly, ochreWall, smoothstep(0.28, 0.80, foldLit * 0.65 + hNorm * 0.38));
        col = mix(col, sunlitAnvil, smoothstep(0.68, 0.98, foldLit) * hNorm * 0.55);

        // Tight internal volumetric illumination right along the lightning channel inside the dark haboob!
        if (uLightning > 0.01) {
          float dBolt = length(vWorldPos - uLightningPos);
          float glow = exp(-dBolt * 0.078) * (0.45 + 0.75 * boilMid);
          col += mix(vec3(1.45, 0.82, 0.38), vec3(1.05, 0.98, 1.95), exp(-dBolt * 0.095)) * uLightning * glow * 1.05;
        }

        gl_FragColor = vec4(col, clamp(soft * uStorm * 0.88, 0.0, 0.90));
      }
    `
  });

  const cellIM = new THREE.InstancedMesh(cellGeo, cellMat, CELL_COUNT);
  const rand = mulberry32(4409);
  const cellSeeds = new Float32Array(CELL_COUNT);
  const cellSpecs = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    cellSeeds[i] = rand() * 12.0;
    const tier = i % 3;
    const x = (rand() - 0.5) * 320.0;
    const arcZ = -102.0 - Math.abs(x) * 0.13 - tier * 14.0 + (rand() - 0.5) * 14.0;
    const yBase = tier === 0 ? 3.5 + rand() * 11.0 : tier === 1 ? 18.0 + rand() * 18.0 : 35.0 + rand() * 22.0;
    const radius = (tier === 0 ? 13.5 : tier === 1 ? 18.5 : 23.0) + rand() * 7.5;
    cellSpecs.push({ x, z: arcZ, y: yBase, r: radius, phase: rand() * Math.PI * 2 });
  }
  cellGeo.setAttribute('aCellSeed', new THREE.InstancedBufferAttribute(cellSeeds, 1));
  cellIM.frustumCulled = false;
  cellIM.renderOrder = 4;
  haboobRoot.add(cellIM);

  // Jagged Branching 3D Triboelectric Static Lightning Bolt Group (fog: false so FogExp2 NEVER washes out HDR bolt!)
  const boltGroup = new THREE.Group();
  boltGroup.renderOrder = 9;
  haboobRoot.add(boltGroup);

  const boltCoreMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false
  });
  const boltHaloMat = new THREE.MeshBasicMaterial({
    color: 0x8e7cff,
    transparent: true,
    opacity: 0.72,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false
  });

  let boltCoreMesh = null;
  let boltHaloMesh = null;
  let lastBuiltSeed = -999;

  function rebuildLightningBolt(seedVal) {
    const bRand = mulberry32(Math.floor(Math.abs(seedVal) * 1000) + 77);
    const startX = -6.0 + (bRand() - 0.5) * 22.0; // Framed cleanly in ridge storm vista!
    const startY = 58.0 + bRand() * 6.0;
    const startZ = -98.0 - bRand() * 10.0;

    uniforms.uLightningPos.value.set(startX, 30.0, startZ);

    const coreParts = [];
    const haloParts = [];

    const addJaggedBranch = (p0, p1, depthSubdiv, rCore, rHalo) => {
      let pts = [p0.clone(), p1.clone()];
      let disp = p0.distanceTo(p1) * 0.18;
      for (let iter = 0; iter < depthSubdiv; iter++) {
        const next = [pts[0]];
        for (let k = 0; k < pts.length - 1; k++) {
          const a = pts[k];
          const b = pts[k + 1];
          const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
          mid.x += (bRand() - 0.5) * disp * 1.55;
          mid.y += (bRand() - 0.5) * disp * 0.38;
          mid.z += (bRand() - 0.5) * disp * 0.65;
          next.push(mid, b);
        }
        pts = next;
        disp *= 0.52;
      }
      // Piecewise linear jagged electrical segments via tension 0.02!
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.02);
      coreParts.push(new THREE.TubeGeometry(curve, pts.length * 2, rCore, 5, false));
      haloParts.push(new THREE.TubeGeometry(curve, pts.length * 2, rHalo, 5, false));
      return pts;
    };

    const endX = startX + (bRand() - 0.5) * 16.0;
    const endZ = startZ + 4.0 + (bRand() - 0.5) * 8.0;
    const endY = getGroundHeight(endX, endZ) - 1.0; // Strikes all the way into the Erg dunes!
    const trunkPts = addJaggedBranch(
      new THREE.Vector3(startX, startY, startZ),
      new THREE.Vector3(endX, endY, endZ),
      5,
      0.068,
      0.24
    );

    // 7 razor-crisp secondary & tertiary triboelectric leaders!
    for (let f = 0; f < 7; f++) {
      const pick = 3 + Math.floor(bRand() * (trunkPts.length - 8));
      const rootPt = trunkPts[pick];
      const side = f % 2 === 0 ? 1 : -1;
      const forkEnd = new THREE.Vector3(
        rootPt.x + side * (6.0 + bRand() * 14.0),
        Math.max(endY + 2.0, rootPt.y - (8.0 + bRand() * 16.0)),
        rootPt.z + (bRand() - 0.5) * 6.0
      );
      const subPts = addJaggedBranch(rootPt, forkEnd, 4, 0.034, 0.12);
      if (f < 3 && subPts.length > 4) {
        const subRoot = subPts[Math.floor(subPts.length * 0.5)];
        addJaggedBranch(
          subRoot,
          new THREE.Vector3(subRoot.x + side * 5.5, subRoot.y - 6.5, subRoot.z),
          3,
          0.020,
          0.075
        );
      }
    }

    if (boltCoreMesh) {
      boltCoreMesh.geometry.dispose();
      boltHaloMesh.geometry.dispose();
      boltGroup.remove(boltCoreMesh);
      boltGroup.remove(boltHaloMesh);
    }
    boltCoreMesh = new THREE.Mesh(mergeGeometries(coreParts, false), boltCoreMat);
    boltHaloMesh = new THREE.Mesh(mergeGeometries(haloParts, false), boltHaloMat);
    boltCoreMesh.frustumCulled = false;
    boltHaloMesh.frustumCulled = false;
    boltGroup.add(boltCoreMesh);
    boltGroup.add(boltHaloMesh);
  }

  rebuildLightningBolt(4.25);

  // Soft 3D Volumetric FBM Crest-Skimming Sand-Drift Veils (zero 1px white dots AND zero flat geometric laser bars!)
  const STREAK_COUNT = 36;
  const streakGeo = new THREE.IcosahedronGeometry(1.0, 2);
  const streakUniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uSunDir: { value: new THREE.Vector3(-0.5, 0.2, -0.8) },
    uSunColor: { value: new THREE.Color(0xffcfa0) },
    uHorizonColor: { value: new THREE.Color(0xe6ac7c) },
    uOpacity: { value: 0.0 }
  };
  const streakMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: streakUniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      void main() {
        vec4 wp = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          mat3 im = mat3(instanceMatrix);
          vec3 invScale2 = 1.0 / max(vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2])), vec3(1e-4));
          vNormalW = normalize(mat3(modelMatrix) * (im * (normal * invScale2)));
        #else
          vNormalW = normalize(mat3(modelMatrix) * normal);
        #endif
        wp = modelMatrix * wp;
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uTime;
      uniform vec2 uWindDir;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uHorizonColor;
      uniform float uOpacity;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      void main() {
        if (uOpacity <= 0.004) discard;
        vec3 V = normalize(cameraPosition - vWorldPos);
        float grazing = pow(clamp(abs(dot(normalize(vNormalW), V)), 0.0, 1.0), 2.35);
        vec3 sc = vec3(vWorldPos.x * 0.22 - uWindDir.x * uTime * 2.2, vWorldPos.y * 1.4, vWorldPos.z * 0.22 - uWindDir.y * uTime * 2.2);
        float wisp = smoothstep(0.36, 0.82, fbm3(sc) * 0.65 + vnoise3(sc * 2.5) * 0.35);
        float alpha = grazing * wisp * uOpacity;
        if (alpha < 0.004) discard;

        float forwardGlow = pow(max(dot(-V, normalize(uSunDir)), 0.0), 2.4);
        vec3 sandTint = mix(uHorizonColor * 0.62, mix(vec3(0.88, 0.62, 0.34), uSunColor, 0.40), 0.25 + 0.75 * forwardGlow);
        gl_FragColor = vec4(sandTint, clamp(alpha, 0.0, 0.22));
      }
    `
  });
  const saltStreaksIM = new THREE.InstancedMesh(streakGeo, streakMat, STREAK_COUNT);
  saltStreaksIM.frustumCulled = false;
  saltStreaksIM.renderOrder = 6;

  const saltSeeds = [];
  for (let i = 0; i < STREAK_COUNT; i++) {
    saltSeeds.push({
      s0: rand(),
      s1: rand(),
      s2: rand(),
      scale: 0.65 + rand() * 0.95
    });
  }

  const dummy = new THREE.Object3D();

  function update(_dt, worldState, camera) {
    if (!worldState) return;
    const storm = worldState.weatherWeights.coriolisStorm;
    const salt = worldState.weatherWeights.saltation;
    const t = worldState.elapsed;

    haboobRoot.visible = storm > 0.015;
    if (haboobRoot.visible) {
      uniforms.uTime.value = t;
      uniforms.uStorm.value = storm;
      uniforms.uSunDir.value.copy(worldState.sunDir);
      uniforms.uSunColor.value.copy(worldState.sunColor);
      uniforms.uHorizonColor.value.copy(worldState.skyHorizonColor);
      uniforms.uLightning.value = worldState.lightningFlash;

      for (let i = 0; i < CELL_COUNT; i++) {
        const c = cellSpecs[i];
        const rollX = Math.sin(t * 0.24 + c.phase) * 3.5;
        const surgeZ = Math.cos(t * 0.18 + c.phase) * 2.5;
        dummy.position.set(c.x + rollX, c.y * (0.48 + 0.52 * storm), c.z + surgeZ);
        dummy.rotation.set(t * 0.07 + c.phase, c.phase, 0);
        dummy.scale.set(c.r * 1.48, c.r * 0.92, c.r * 1.18);
        dummy.updateMatrix();
        cellIM.setMatrixAt(i, dummy.matrix);
      }
      cellIM.instanceMatrix.needsUpdate = true;

      if (worldState.lightningFlash > 0.06) {
        if (Math.abs(worldState.lightningSeed - lastBuiltSeed) > 0.001) {
          lastBuiltSeed = worldState.lightningSeed;
          rebuildLightningBolt(lastBuiltSeed);
        }
        boltGroup.visible = true;
        const flashAlpha = clamp(worldState.lightningFlash * 1.25, 0, 1);
        boltCoreMat.opacity = flashAlpha;
        boltHaloMat.opacity = flashAlpha * 0.78;
        boltCoreMat.color.setRGB(5.2 * flashAlpha, 4.6 * flashAlpha, 7.2 * flashAlpha);
        boltHaloMat.color.setRGB(1.35 * flashAlpha, 1.15 * flashAlpha, 2.85 * flashAlpha);
      } else {
        boltGroup.visible = false;
      }
    }

    const activeSalt = smoothstep(0.45, 0.95, Math.max(salt, storm));
    saltStreaksIM.visible = activeSalt > 0.02;
    if (saltStreaksIM.visible && camera) {
      const sunUp = smoothstep(-0.04, 0.18, worldState.sunDir.y);
      streakUniforms.uTime.value = t;
      streakUniforms.uWindDir.value.copy(worldState.windDir);
      streakUniforms.uSunDir.value.copy(worldState.sunDir);
      streakUniforms.uSunColor.value.copy(worldState.sunColor);
      streakUniforms.uHorizonColor.value.copy(worldState.skyHorizonColor);
      streakUniforms.uOpacity.value = activeSalt * 0.24 * (0.35 + 0.65 * sunUp);

      const cx = camera.position.x;
      const cz = camera.position.z;
      const wx = worldState.windDir.x;
      const wz = worldState.windDir.y;
      const windYaw = Math.atan2(-wz, wx);
      const speed = 4.5 + worldState.windSpeed * 6.5;

      for (let i = 0; i < STREAK_COUNT; i++) {
        const sd = saltSeeds[i];
        const span = 84.0;
        const dx = (((sd.s0 * span + wx * t * speed * (0.7 + 0.6 * sd.s2)) % span) + span) % span - span * 0.5;
        const dz = (((sd.s1 * span + wz * t * speed * (0.7 + 0.6 * sd.s2)) % span) + span) % span - span * 0.5;
        const px = cx + dx;
        const pz = cz - 42.0 + dz;
        const gy = getGroundHeight(px, pz);
        dummy.position.set(px, gy + 0.65 + sd.s2 * 1.4, pz);
        dummy.rotation.set(0.0, windYaw, 0.0);
        dummy.scale.set(6.5 * sd.scale, 0.75 * sd.scale, 3.2 * sd.scale);
        dummy.updateMatrix();
        saltStreaksIM.setMatrixAt(i, dummy.matrix);
      }
      saltStreaksIM.instanceMatrix.needsUpdate = true;
    }
  }

  const container = new THREE.Group();
  container.add(haboobRoot);
  container.add(saltStreaksIM);
  return { group: container, update };
}

// ============================================================================
// 5. GPU-ANIMATED BLOWING SALTATION SAND & SUNLIT OASIS DUST MOTES
//    Wraps seamlessly around camera in 3D space so walking/flying feels alive!
// ============================================================================

function buildBlowingSandAndMotes() {
  const MAX_PARTICLES = 1800;
  const rand = mulberry32(4242);
  const positions = new Float32Array(MAX_PARTICLES * 3);
  const seeds = new Float32Array(MAX_PARTICLES * 3);

  for (let i = 0; i < MAX_PARTICLES; i++) {
    positions[i * 3] = (rand() - 0.5) * 34.0;
    positions[i * 3 + 1] = rand() * 8.5;
    positions[i * 3 + 2] = (rand() - 0.5) * 34.0;
    seeds[i * 3] = rand();
    seeds[i * 3 + 1] = rand();
    seeds[i * 3 + 2] = rand();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));

  const uniforms = {
    uTime: { value: 0 },
    uCamPos: { value: new THREE.Vector3(0, 2, 14) },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindSpeed: { value: 0.45 },
    uStorm: { value: 0 },
    uSpice: { value: 0 },
    uSunColor: { value: new THREE.Color(0xffcfa0) },
    uSunUp: { value: 0.5 },
    uDensity: { value: 1.0 }
  };

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms,
    vertexShader: /* glsl */ `
      attribute vec3 aSeed;
      uniform float uTime;
      uniform vec3 uCamPos;
      uniform vec2 uWindDir;
      uniform float uWindSpeed;
      uniform float uStorm;
      uniform float uDensity;

      varying float vAlpha;
      varying float vSeed;

      void main() {
        vSeed = aSeed.x;
        // Thin out smoothly on lower quality tiers
        float activeGate = step(aSeed.z, clamp(uDensity, 0.0, 1.0));
        float span = 34.0;
        float hSpan = 8.5;

        float driftRate = mix(0.45, 7.2, clamp(uWindSpeed * 0.55 + uStorm * 0.85, 0.0, 1.3));
        vec2 windFlow = uWindDir * (uTime * driftRate * (0.65 + 0.7 * aSeed.y));
        float bob = sin(uTime * (0.9 + aSeed.x * 1.6) + aSeed.y * 6.283) * (0.28 - uStorm * 0.16);

        vec3 rel;
        rel.x = mod(position.x + windFlow.x - uCamPos.x + span * 0.5, span) - span * 0.5;
        rel.z = mod(position.z + windFlow.y - uCamPos.z + span * 0.5, span) - span * 0.5;
        rel.y = mod(position.y + bob - (uCamPos.y - 2.2) + hSpan, hSpan) - 2.2;

        vec3 wp = uCamPos + rel;
        vec4 mvPos = viewMatrix * vec4(wp, 1.0);
        float dist = length(mvPos.xyz);

        float edgeFade = smoothstep(17.0, 10.0, length(rel.xz)) * smoothstep(0.65, 2.2, dist);
        float visStrength = mix(0.24, 0.78, clamp(uStorm * 0.85 + (uWindSpeed - 0.35) * 0.45, 0.0, 1.0));
        vAlpha = edgeFade * visStrength * activeGate * (0.55 + 0.45 * sin(uTime * 2.1 + aSeed.x * 20.0));

        float baseSize = mix(14.0, 26.0, aSeed.y) * mix(1.0, 1.55, uStorm);
        gl_PointSize = clamp(baseSize / max(dist, 0.6), 1.2, 10.0);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunColor;
      uniform float uSunUp;
      uniform float uStorm;
      uniform float uSpice;
      varying float vAlpha;
      varying float vSeed;

      void main() {
        if (vAlpha < 0.01) discard;
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;
        float soft = exp(-r2 * 15.0);

        vec3 goldenMote = mix(vec3(0.95, 0.72, 0.44), uSunColor * 1.15, 0.55);
        vec3 stormGrit = vec3(0.76, 0.46, 0.24);
        vec3 nightMote = vec3(0.45, 0.66, 0.94);
        vec3 col = mix(nightMote, goldenMote, uSunUp);
        col = mix(col, stormGrit, uStorm * 0.75);
        if (uSpice > 0.05 && vSeed > 0.68) {
          col = mix(col, vec3(0.32, 0.74, 1.15), uSpice * 0.7);
        }

        gl_FragColor = vec4(col, soft * vAlpha * 0.62);
      }
    `
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 7;

  function update(_dt, state, camera) {
    if (!state || !camera) return;
    const q = state.getQualityConfig?.();
    uniforms.uTime.value = state.elapsed;
    uniforms.uCamPos.value.copy(camera.position);
    uniforms.uWindDir.value.copy(state.windDir);
    uniforms.uWindSpeed.value = state.windSpeed;
    uniforms.uStorm.value = state.weatherWeights.coriolisStorm;
    uniforms.uSpice.value = Math.max(state.weatherWeights.spiceBlow, state.player?.spiceTrance || 0);
    uniforms.uSunColor.value.copy(state.sunColor);
    uniforms.uSunUp.value = smoothstep(-0.08, 0.18, state.sunDir.y) * (1.0 - state.eclipseStrength * 0.7);
    uniforms.uDensity.value = Math.min(1.0, (q?.particleScale ?? 1.0) * 0.85);
  }

  return { group: points, update };
}

// ============================================================================
// 6. INTERACTIVE FOOTSTEP, SAND-SLIDE, THUMPER & SPICE HARVEST DUST PUFFS
// ============================================================================

function buildInteractiveSandPuffs() {
  const POOL_SIZE = 56;
  const geo = new THREE.IcosahedronGeometry(0.42, 1);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xdca46e,
    transparent: true,
    opacity: 0.44,
    depthWrite: false
  });
  const im = new THREE.InstancedMesh(geo, mat, POOL_SIZE);
  im.frustumCulled = false;
  im.renderOrder = 6;

  const pool = Array.from({ length: POOL_SIZE }, () => ({
    active: false,
    x: 0,
    y: -100,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    age: 0,
    life: 1,
    baseScale: 0.5,
    color: new THREE.Color(0xd9a16b)
  }));
  let cursor = 0;
  const dummy = new THREE.Object3D();

  // Initialize hidden
  for (let i = 0; i < POOL_SIZE; i++) {
    dummy.position.set(0, -100, 0);
    dummy.scale.setScalar(0.0001);
    dummy.updateMatrix();
    im.setMatrixAt(i, dummy.matrix);
    im.setColorAt(i, pool[i].color);
  }
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;

  function spawnSandPuff(x, y, z, vx = 0, vy = 0.6, vz = 0, scale = 0.55, hexColor = 0xd9a16b) {
    const p = pool[cursor];
    cursor = (cursor + 1) % POOL_SIZE;
    p.active = true;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.age = 0;
    p.life = 0.65 + Math.random() * 0.55;
    p.baseScale = scale;
    p.color.setHex(hexColor);
    im.setColorAt(cursor === 0 ? POOL_SIZE - 1 : cursor - 1, p.color);
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }

  function spawnSpiceBurst(x, y, z) {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + Math.random() * 0.4;
      const spd = 0.6 + Math.random() * 1.4;
      spawnSandPuff(
        x + Math.cos(a) * 0.25,
        y + 0.15,
        z + Math.sin(a) * 0.25,
        Math.cos(a) * spd,
        1.1 + Math.random() * 1.6,
        Math.sin(a) * spd,
        0.42 + Math.random() * 0.35,
        i % 3 === 0 ? 0x4caaff : 0xd46a2c
      );
    }
  }

  function update(dt, state) {
    const step = clamp(dt || 0, 0, 0.1);
    let anyDirty = false;
    const wx = state ? state.windDir.x * state.windSpeed * 2.2 : 0;
    const wz = state ? state.windDir.y * state.windSpeed * 2.2 : 0;
    const sunUp = state ? smoothstep(-0.08, 0.20, state.sunDir.y) : 0.6;
    mat.opacity = mix(0.18, 0.42, sunUp);

    for (let i = 0; i < POOL_SIZE; i++) {
      const p = pool[i];
      if (!p.active) continue;
      anyDirty = true;
      p.age += step;
      if (p.age >= p.life) {
        p.active = false;
        dummy.position.set(0, -100, 0);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        continue;
      }
      const u = p.age / p.life;
      p.x += (p.vx + wx * 0.4) * step;
      p.y += p.vy * step;
      p.z += (p.vz + wz * 0.4) * step;
      p.vx *= Math.exp(-step * 2.2);
      p.vz *= Math.exp(-step * 2.2);
      p.vy -= 1.2 * step;

      const s = p.baseScale * (0.45 + u * 1.75) * Math.sin((1.0 - u) * Math.PI * 0.5);
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(u * 2.2 + i, u * 1.7, i * 0.7);
      dummy.scale.set(s * 1.25, s * 0.82, s * 1.25);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    }
    if (anyDirty) {
      im.instanceMatrix.needsUpdate = true;
    }
  }

  return { group: im, spawnSandPuff, spawnSpiceBurst, update };
}

export function createAtmosphereFXSystem(scene, worldState) {
  const group = new THREE.Group();
  group.name = 'ArrakisAtmosphereFXSystem';

  const cisternMist = buildCisternMistSystem();
  const dustDevils = buildDustDevilsSystem(worldState);
  const spiceBlow = buildSpiceBlowSystem();
  const coriolisHaboob = buildCoriolisHaboobSystem();
  const blowingSand = buildBlowingSandAndMotes();
  const sandPuffs = buildInteractiveSandPuffs();

  group.add(cisternMist.group);
  group.add(dustDevils.group);
  group.add(spiceBlow.group);
  group.add(coriolisHaboob.group);
  group.add(blowingSand.group);
  group.add(sandPuffs.group);

  if (scene) {
    scene.add(group);
  }

  function update(dt, camera) {
    cisternMist.update(dt, worldState);
    dustDevils.update(dt, worldState);
    spiceBlow.update(dt, worldState);
    coriolisHaboob.update(dt, worldState, camera);
    blowingSand.update(dt, worldState, camera);
    sandPuffs.update(dt, worldState);
  }

  return {
    group,
    spawnSandPuff: sandPuffs.spawnSandPuff,
    spawnSpiceBurst: sandPuffs.spawnSpiceBurst,
    update
  };
}
