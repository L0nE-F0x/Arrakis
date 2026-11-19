import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { NOISE_GLSL } from '../shaders/noise.glsl.js';
import { getGroundHeight, getGroundNormal, WATER_LEVEL, CISTERN_CENTER, smoothstep } from './terrainMath.js';

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

function colorize(geom, hex, jitter = 0.0) {
  const g = geom.index ? geom.toNonIndexed() : geom.clone();
  if (!g.attributes.normal) g.computeVertexNormals();
  const count = g.attributes.position.count;
  const col = new THREE.Color(hex);
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const j = jitter > 0 ? 1.0 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * jitter : 1.0;
    arr[i * 3] = Math.min(1, Math.max(0, col.r * j));
    arr[i * 3 + 1] = Math.min(1, Math.max(0, col.g * j));
    arr[i * 3 + 2] = Math.min(1, Math.max(0, col.b * j));
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  return g;
}

function colorizeByFn(geom, fn) {
  const g = geom.index ? geom.toNonIndexed() : geom.clone();
  if (!g.attributes.normal) g.computeVertexNormals();
  const pos = g.attributes.position;
  const count = pos.count;
  const arr = new Float32Array(count * 3);
  const col = new THREE.Color();
  for (let i = 0; i < count; i++) {
    fn(pos.getX(i), pos.getY(i), pos.getZ(i), col, i);
    arr[i * 3] = Math.min(1, Math.max(0, col.r));
    arr[i * 3 + 1] = Math.min(1, Math.max(0, col.g));
    arr[i * 3 + 2] = Math.min(1, Math.max(0, col.b));
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  return g;
}

let _softGlowTex = null;
function getSoftGlowTexture() {
  if (_softGlowTex) return _softGlowTex;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 1, 32, 32, 31);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.28, 'rgba(255, 255, 255, 0.72)');
  grad.addColorStop(0.62, 'rgba(255, 255, 255, 0.18)');
  grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  _softGlowTex = new THREE.CanvasTexture(c);
  return _softGlowTex;
}

// ============================================================================
// 1. YARDANG SANCTUARY FREMEN CAMP (x: -14.5, z: 5.5)
//    Billowing wind-canopy, flickering spice-oil brazier with live PointLight
//    & ember sparks, clay water amphorae, fremkit chest & desert pennants.
// ============================================================================

function buildFremenCamp(worldState, colliders, interactables) {
  const cx = -14.5;
  const cz = 5.5;
  const cy = getGroundHeight(cx, cz);
  const rotY = 0.42;
  const cosR = Math.cos(rotY);
  const sinR = Math.sin(rotY);

  // Convert camp-local (lx, lz) to exact local ground Y relative to camp origin cy
  const localGroundY = (lx, lz) => {
    const wx = cx + lx * cosR + lz * sinR;
    const wz = cz - lx * sinR + lz * cosR;
    return getGroundHeight(wx, wz) - cy;
  };

  const camp = new THREE.Group();
  camp.name = 'YardangSanctuaryCamp';
  camp.position.set(cx, cy, cz);
  camp.rotation.y = rotY;

  // Shared wind uniforms for billowing fabric canopy & banners
  const clothUniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindSpeed: { value: 0.45 }
  };

  // --- Canopy Posts (4 tilted composite desert-wood/brass poles + stone anchor collars) ---
  const postMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.78,
    metalness: 0.12
  });
  const poleParts = [];
  const postCoords = [
    [-2.05, -1.65, 2.55, 0.06, -0.04],
    [2.05, -1.65, 2.38, -0.05, -0.05],
    [-1.95, 1.65, 2.05, 0.05, 0.06],
    [1.95, 1.65, 1.95, -0.06, 0.05]
  ];
  for (const [px, pz, h, rx, rz] of postCoords) {
    const pgy = localGroundY(px, pz);
    const pole = new THREE.CylinderGeometry(0.042, 0.058, h + 0.65, 8);
    pole.translate(0, (h - 0.45) * 0.5, 0);
    pole.rotateX(rx);
    pole.rotateZ(rz);
    pole.translate(px, 0, pz);
    poleParts.push(colorize(pole, 0x5c3c24, 0.08));

    // Brass collar ring aligned tightly around tilted pole apex
    const ring = new THREE.CylinderGeometry(0.064, 0.064, 0.085, 10);
    ring.translate(0, h - 0.18, 0);
    ring.rotateX(rx);
    ring.rotateZ(rz);
    ring.translate(px, 0, pz);
    poleParts.push(colorize(ring, 0xc79248, 0.05));

    // Grounded sandstone anchor collar seated flush where each post meets the desert floor
    const collar = new THREE.CylinderGeometry(0.11, 0.21, 0.16, 7);
    collar.translate(px, pgy + 0.03, pz);
    poleParts.push(colorize(collar, 0x7c5838, 0.09));
  }
  const polesMesh = new THREE.Mesh(mergeGeometries(poleParts, false), postMat);
  polesMesh.castShadow = true;
  polesMesh.receiveShadow = true;
  camp.add(polesMesh);

  // --- Billowing Fremen Woven Desert Awning Canopy ---
  const canopyGeo = new THREE.PlaneGeometry(4.35, 3.55, 28, 22);
  canopyGeo.rotateX(-Math.PI * 0.5);
  const cPos = canopyGeo.attributes.position;
  const cColors = new Float32Array(cPos.count * 3);
  const cBase = new THREE.Color(0x9b5428);
  const cStripe = new THREE.Color(0x6e2f18);
  const cSand = new THREE.Color(0xc48b52);
  const cTmp = new THREE.Color();

  for (let i = 0; i < cPos.count; i++) {
    const x = cPos.getX(i);
    const z = cPos.getZ(i);
    const nx = x / 2.175; // -1..1
    const nz = z / 1.775; // -1..1
    // Natural catenary sag between 4 corner posts + slight rearward slope for runoff/shade
    const cornerAnchor = Math.pow(Math.max(Math.abs(nx), Math.abs(nz)), 2.2);
    const sag = (1.0 - cornerAnchor) * -0.34;
    const slopeY = 2.22 - nz * 0.24 - nx * 0.05;
    cPos.setY(i, slopeY + sag);

    // Woven Fremen ochre/terracotta stripes
    const band = Math.sin(z * 4.8) * 0.5 + 0.5;
    cTmp.copy(cBase).lerp(cStripe, smoothstep(0.68, 0.92, band) * 0.72);
    cTmp.lerp(cSand, smoothstep(0.65, 1.0, Math.abs(nx)) * 0.28);
    cColors[i * 3] = cTmp.r;
    cColors[i * 3 + 1] = cTmp.g;
    cColors[i * 3 + 2] = cTmp.b;
  }
  canopyGeo.setAttribute('color', new THREE.BufferAttribute(cColors, 3));
  canopyGeo.computeVertexNormals();

  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.0,
    side: THREE.DoubleSide
  });
  canopyMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = clothUniforms.uTime;
    shader.uniforms.uWindSpeed = clothUniforms.uWindSpeed;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWindSpeed;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float pinDist = min(min(length(transformed.xz - vec2(-2.05, -1.65)), length(transformed.xz - vec2(2.05, -1.65))),
                            min(length(transformed.xz - vec2(-1.95, 1.65)), length(transformed.xz - vec2(1.95, 1.65))));
        float flexC = smoothstep(0.18, 1.45, pinDist);
        float flap = sin(transformed.x * 2.4 + uTime * (2.6 + uWindSpeed * 3.8)) * 0.065
                   + cos(transformed.z * 3.2 - uTime * (3.9 + uWindSpeed * 4.6)) * 0.045;
        transformed.y += flap * flexC * (0.45 + uWindSpeed * 0.95);`
      );
  };
  const canopyMesh = new THREE.Mesh(canopyGeo, canopyMat);
  canopyMesh.castShadow = true;
  canopyMesh.receiveShadow = true;
  camp.add(canopyMesh);

  // --- Fluttering Saffron Fremen Pennant Banner beside camp entrance ---
  const pennantGy = localGroundY(2.45, 1.45);
  const pennantPole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.036, 3.45, 8),
    new THREE.MeshStandardMaterial({ color: 0x6b4728, roughness: 0.78 })
  );
  pennantPole.position.set(2.45, 1.42 + pennantGy * 0.5, 1.45);
  pennantPole.castShadow = true;
  camp.add(pennantPole);

  const flagGeo = new THREE.PlaneGeometry(1.15, 0.42, 16, 4);
  flagGeo.translate(0.575, 0, 0);
  // Taper pennant to twin swallow-tail tip
  const fPos = flagGeo.attributes.position;
  for (let i = 0; i < fPos.count; i++) {
    const u = fPos.getX(i) / 1.15;
    fPos.setY(i, fPos.getY(i) * (1.0 - u * 0.58));
  }
  flagGeo.computeVertexNormals();
  const flagMat = new THREE.MeshStandardMaterial({
    color: 0xd97d32,
    roughness: 0.85,
    side: THREE.DoubleSide
  });
  flagMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = clothUniforms.uTime;
    shader.uniforms.uWindSpeed = clothUniforms.uWindSpeed;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWindSpeed;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float u = clamp(transformed.x / 1.15, 0.0, 1.0);
        float wv = sin(u * 8.5 - uTime * (5.2 + uWindSpeed * 5.8)) * 0.14 * u * (0.4 + uWindSpeed * 0.85);
        transformed.z += wv;
        transformed.y -= (1.0 - min(1.0, uWindSpeed * 0.9)) * u * 0.18;`
      );
  };
  const flagMesh = new THREE.Mesh(flagGeo, flagMat);
  flagMesh.position.set(2.45, 2.86, 1.45);
  flagMesh.castShadow = true;
  camp.add(flagMesh);

  // --- Hammered Brass Spice-Oil Brazier + Animated Volumetric Flame + PointLight ---
  const brazierX = 0.05;
  const brazierZ = 0.25;
  const brazierGy = localGroundY(brazierX, brazierZ);
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.36,
    metalness: 0.82
  });
  const brazierParts = [];
  const bowl = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.01, 0.28),
      new THREE.Vector2(0.28, 0.32),
      new THREE.Vector2(0.46, 0.50),
      new THREE.Vector2(0.50, 0.62),
      new THREE.Vector2(0.42, 0.64),
      new THREE.Vector2(0.36, 0.44),
      new THREE.Vector2(0.01, 0.40)
    ],
    20
  );
  brazierParts.push(colorize(bowl, 0xb87f3e, 0.06));
  for (let leg = 0; leg < 3; leg++) {
    const a = (leg / 3) * Math.PI * 2;
    const legGeo = new THREE.CylinderGeometry(0.028, 0.036, 0.64, 7);
    legGeo.rotateZ(0.22);
    legGeo.rotateY(a);
    legGeo.translate(Math.cos(a) * 0.32, 0.20, Math.sin(a) * 0.32);
    brazierParts.push(colorize(legGeo, 0x4b3526, 0.04));
  }
  const brazierMesh = new THREE.Mesh(mergeGeometries(brazierParts, false), brassMat);
  brazierMesh.position.set(brazierX, brazierGy - 0.01, brazierZ);
  brazierMesh.castShadow = true;
  brazierMesh.receiveShadow = true;
  camp.add(brazierMesh);

  // Glowing spice-oil ember bed inside brazier (cracked glowing charcoal core — rich glow, zero bloom blowout!)
  const coalUniforms = { uTime: { value: 0 } };
  const coalMat = new THREE.MeshStandardMaterial({
    color: 0x261006,
    emissive: new THREE.Color(0xff4a10),
    emissiveIntensity: 1.45,
    roughness: 0.88
  });
  coalMat.customProgramCacheKey = () => 'arrakis-brazier-coal-v1';
  coalMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = coalUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCoalLocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCoalLocal = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}\nuniform float uTime;\nvarying vec3 vCoalLocal;`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float rCoal = length(vCoalLocal.xz) / 0.32;
        float crack = fbm2(vCoalLocal.xz * 14.0 + vec2(uTime * 0.15, -uTime * 0.10));
        float hotCore = (1.0 - smoothstep(0.15, 0.98, rCoal)) * smoothstep(0.26, 0.72, crack);
        vec3 emberHue = mix(vec3(0.75, 0.14, 0.02), vec3(1.15, 0.56, 0.12), hotCore);
        totalEmissiveRadiance *= emberHue * (0.38 + 0.82 * hotCore);`
      );
  };
  const coalMesh = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), coalMat);
  coalMesh.scale.set(1.0, 0.35, 1.0);
  coalMesh.position.set(brazierX, brazierGy + 0.48, brazierZ);
  camp.add(coalMesh);

  // Volumetric shader flame tongue (balanced filmic radiance so dusk/night glow stays rich without white clipping)
  const flameUniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindSpeed: { value: 0.45 }
  };
  const flameGeo = new THREE.ConeGeometry(0.26, 0.88, 16, 12, true);
  flameGeo.translate(0, 0.44, 0);
  const flameMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: flameUniforms,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uWindSpeed;
      varying vec2 vUv;
      varying vec3 vNormW;
      varying vec3 vWorldP;
      void main() {
        vUv = uv;
        vec3 p = position;
        float h = uv.y;
        p.x += sin(uTime * 11.0 + h * 6.0) * 0.055 * h + uWindSpeed * 0.13 * h * h;
        p.z += cos(uTime * 9.5 + h * 5.0) * 0.045 * h;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorldP = wp.xyz;
        vNormW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vNormW;
      varying vec3 vWorldP;
      void main() {
        float h = vUv.y;
        float n = fbm2(vec2(vUv.x * 4.5, h * 4.2 - uTime * 4.8));
        float shape = (1.0 - smoothstep(0.06, 0.96, h)) * smoothstep(0.0, 0.18, h);
        vec3 viewDir = normalize(cameraPosition - vWorldP);
        float edgeSoft = pow(abs(dot(normalize(vNormW), viewDir)), 0.55);
        float mask = smoothstep(0.30, 0.74, n + (1.0 - h) * 0.38) * shape * (0.35 + 0.65 * edgeSoft);
        if (mask < 0.02) discard;
        vec3 col = mix(vec3(0.95, 0.20, 0.03), vec3(1.0, 0.66, 0.18), smoothstep(0.22, 0.88, (1.0 - h) * n * 1.42));
        gl_FragColor = vec4(col * 1.12, mask * 0.64);
      }
    `
  });
  const flameMesh = new THREE.Mesh(flameGeo, flameMat);
  flameMesh.position.set(brazierX, brazierGy + 0.47, brazierZ);
  camp.add(flameMesh);

  // Live flickering fire PointLight (warm golden dusk/night pool without clipping bloom!)
  const fireLight = new THREE.PointLight(0xff8230, 5.0, 21.0, 1.65);
  fireLight.position.set(brazierX, brazierGy + 1.06, brazierZ);
  camp.add(fireLight);

  // Rising glowing ember sparks from brazier
  const EMBER_COUNT = 26;
  const emberPos = new Float32Array(EMBER_COUNT * 3);
  const emberSeed = new Float32Array(EMBER_COUNT);
  for (let i = 0; i < EMBER_COUNT; i++) {
    emberSeed[i] = Math.random();
    emberPos[i * 3] = brazierX;
    emberPos[i * 3 + 1] = brazierGy + 0.55;
    emberPos[i * 3 + 2] = brazierZ;
  }
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute('position', new THREE.BufferAttribute(emberPos, 3));
  const emberMat = new THREE.PointsMaterial({
    color: 0xffa43c,
    map: getSoftGlowTexture(),
    size: 0.105,
    transparent: true,
    opacity: 0.88,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const emberPoints = new THREE.Points(emberGeo, emberMat);
  camp.add(emberPoints);

  // --- Terrain-Conforming Woven Fremen Carpet Runners, Bolsters, Hearth Stones, Amphorae & Fremkit Chest ---
  const propsParts = [];

  // Helper: Build a terrain-conforming woven Fremen desert carpet runner with folded hem & braided end tassels
  function addWovenCarpetRunner(centerX, centerZ, width, depth, segX, segZ, mainAxis = 'x') {
    const plane = new THREE.PlaneGeometry(width, depth, segX, segZ);
    plane.rotateX(-Math.PI * 0.5);
    const pos = plane.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    const cMadder = new THREE.Color(0x6d2318);
    const cTerracotta = new THREE.Color(0x9a3d20);
    const cSaffron = new THREE.Color(0xc8823c);
    const cIndigo = new THREE.Color(0x281e1c);
    const cCream = new THREE.Color(0xd8bc92);
    const col = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const lx0 = pos.getX(i);
      const lz0 = pos.getZ(i);
      const lx = centerX + lx0;
      const lz = centerZ + lz0;
      const u = lx0 / (width * 0.5); // -1..1
      const v = lz0 / (depth * 0.5); // -1..1
      const edgeMax = Math.max(Math.abs(u), Math.abs(v));
      const gy = localGroundY(lx, lz);
      // Softly hug terrain contour with subtle textile undulation; tuck outer edge cleanly into sand (zero floating!)
      const edgeTuck = edgeMax > 0.94 ? -0.022 : 0.026 + Math.sin(lx * 7.0 + lz * 5.0) * 0.004;
      pos.setXYZ(i, lx, gy + edgeTuck, lz);

      // Authentic woven Fremen geometric desert pattern
      const along = mainAxis === 'x' ? u : v;
      const across = mainAxis === 'x' ? v : u;
      const borderBand = smoothstep(0.68, 0.78, Math.abs(across)) * (1.0 - smoothstep(0.88, 0.96, Math.abs(across)));
      const endBand = smoothstep(0.74, 0.84, Math.abs(along)) * (1.0 - smoothstep(0.92, 0.98, Math.abs(along)));
      // Repeating central diamond lozenges
      const cellA = Math.abs(((along * 3.5 + 4.0) % 1.0) - 0.5) * 2.0;
      const cellB = Math.abs(across * 2.2);
      const diamond = 1.0 - smoothstep(0.55, 0.72, cellA + cellB);
      const diamondRim = smoothstep(0.46, 0.58, cellA + cellB) * (1.0 - smoothstep(0.62, 0.74, cellA + cellB));
      const weaveTex = 0.92 + 0.08 * Math.sin(lx * 38.0) * Math.cos(lz * 38.0);

      col.copy(cMadder).lerp(cTerracotta, (Math.sin(across * 9.0) * 0.5 + 0.5) * 0.35);
      col.lerp(cSaffron, Math.max(borderBand, endBand) * 0.82);
      col.lerp(cIndigo, diamond * 0.68);
      col.lerp(cCream, diamondRim * 0.55);
      if (Math.abs(across) > 0.89 || Math.abs(along) > 0.91) {
        col.lerp(cIndigo, 0.55);
      }
      col.multiplyScalar(weaveTex);
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
    plane.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    plane.computeVertexNormals();
    propsParts.push(plane.index ? plane.toNonIndexed() : plane);

    // Braided warm-cream fringe tassels along both short ends of the runner
    const tasselCount = mainAxis === 'x' ? 9 : 7;
    for (const endSign of [-1, 1]) {
      for (let t = 0; t < tasselCount; t++) {
        const frac = (t / (tasselCount - 1) - 0.5) * 1.75;
        const tx = mainAxis === 'x' ? centerX + endSign * (width * 0.5 + 0.055) : centerX + frac * (width * 0.45);
        const tz = mainAxis === 'x' ? centerZ + frac * (depth * 0.45) : centerZ + endSign * (depth * 0.5 + 0.055);
        const tgy = localGroundY(tx, tz);
        const tassel = new THREE.BoxGeometry(mainAxis === 'x' ? 0.11 : 0.022, 0.016, mainAxis === 'x' ? 0.022 : 0.11);
        tassel.translate(tx, tgy + 0.012, tz);
        propsParts.push(colorize(tassel, 0xd0b384, 0.08));
      }
    }
  }

  // Main bivouac woven carpet under the awning + hearth-side ceremonial runner beside the brazier
  addWovenCarpetRunner(-0.28, -0.78, 2.55, 1.36, 20, 12, 'x');
  addWovenCarpetRunner(-0.82, 0.62, 1.12, 1.46, 10, 14, 'z');

  // Rolled woven Fremen seating bolsters resting on rear carpet
  for (const [bx, bz, byaw, bHex] of [[-0.92, -1.04, 0.22, 0x8a341d], [0.42, -1.08, -0.26, 0x7c4a26]]) {
    const bgy = localGroundY(bx, bz);
    const bolster = new THREE.CylinderGeometry(0.11, 0.11, 0.68, 10);
    bolster.rotateZ(Math.PI * 0.5);
    bolster.rotateY(byaw);
    bolster.translate(bx, bgy + 0.125, bz);
    propsParts.push(colorize(bolster, bHex, 0.08));
  }

  // Carved dark sandstone hearth stones anchoring the brazier tripod flush to the dune floor
  for (let s = 0; s < 8; s++) {
    const a = (s / 8) * Math.PI * 2 + 0.2;
    const sx = brazierX + Math.cos(a) * 0.44;
    const sz = brazierZ + Math.sin(a) * 0.44;
    const sgy = localGroundY(sx, sz);
    const stone = new THREE.DodecahedronGeometry(0.11, 0);
    stone.scale(1.15, 0.55, 0.85);
    stone.rotateY(a);
    stone.translate(sx, sgy + 0.02, sz);
    propsParts.push(colorize(stone, 0x4a392e, 0.09));
  }

  // Clay Water Amphorae grounded to exact local terrain height
  const amphoraProfile = [
    new THREE.Vector2(0.01, 0.0),
    new THREE.Vector2(0.14, 0.02),
    new THREE.Vector2(0.24, 0.28),
    new THREE.Vector2(0.20, 0.52),
    new THREE.Vector2(0.09, 0.68),
    new THREE.Vector2(0.13, 0.78),
    new THREE.Vector2(0.08, 0.79)
  ];
  for (const [ax, az, sc, tilt] of [[-1.50, -0.78, 1.05, 0.05], [-1.08, -1.26, 0.82, -0.06], [1.36, -0.70, 0.92, 0.03]]) {
    const agy = localGroundY(ax, az);
    const jar = new THREE.LatheGeometry(amphoraProfile, 16);
    jar.scale(sc, sc, sc);
    jar.rotateZ(tilt);
    jar.translate(ax, agy - 0.03, az);
    propsParts.push(colorize(jar, 0x9c5534, 0.08));
  }

  // Sealed Fremkit Supply Chest grounded cleanly to terrain slope
  const chestX = 1.18;
  const chestZ = 0.68;
  const chestGy = localGroundY(chestX, chestZ);
  const chest = new THREE.BoxGeometry(0.92, 0.44, 0.54);
  chest.rotateY(-0.28);
  chest.translate(chestX, chestGy + 0.19, chestZ);
  propsParts.push(colorize(chest, 0x4b3b2d, 0.06));

  const chestLid = new THREE.BoxGeometry(0.96, 0.08, 0.58);
  chestLid.rotateY(-0.28);
  chestLid.translate(chestX, chestGy + 0.44, chestZ);
  propsParts.push(colorize(chestLid, 0x7b5d3e, 0.06));

  const propsMesh = new THREE.Mesh(
    mergeGeometries(propsParts, false),
    new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.84, metalness: 0.06 })
  );
  propsMesh.castShadow = true;
  propsMesh.receiveShadow = true;
  camp.add(propsMesh);

  // --- Hammered Copper Spice-Coffee Dallah, Finjan Cups, Brass Tray, Chest Clasps & Fremen Water-Ring Tokens ---
  const metalParts = [];
  const trayX = -0.62;
  const trayZ = 0.56;
  const trayGy = localGroundY(trayX, trayZ) + 0.028;

  // Low circular hammered-brass serving tray resting on the woven hearth runner
  const trayGeo = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.01, 0.0),
      new THREE.Vector2(0.24, 0.0),
      new THREE.Vector2(0.275, 0.026),
      new THREE.Vector2(0.26, 0.030),
      new THREE.Vector2(0.23, 0.008),
      new THREE.Vector2(0.01, 0.008)
    ],
    22
  );
  trayGeo.translate(trayX, trayGy, trayZ);
  metalParts.push(colorize(trayGeo, 0xb88642, 0.05));

  // Iconic Fremen Copper Spice-Coffee Dallah (curved beak spout, bulbous body, domed finial lid, S-scroll handle)
  const dallahX = trayX - 0.05;
  const dallahZ = trayZ - 0.04;
  const dallahY = trayGy + 0.008;
  const dallahRotY = -0.35; // Orient crescent spout & handle crisply across the camera sightline

  const dallahBody = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.005, 0.0),
      new THREE.Vector2(0.064, 0.0),
      new THREE.Vector2(0.052, 0.035),
      new THREE.Vector2(0.088, 0.115),
      new THREE.Vector2(0.082, 0.175),
      new THREE.Vector2(0.046, 0.232),
      new THREE.Vector2(0.064, 0.275),
      new THREE.Vector2(0.055, 0.292),
      new THREE.Vector2(0.030, 0.335),
      new THREE.Vector2(0.010, 0.365),
      new THREE.Vector2(0.001, 0.382)
    ],
    18
  );
  dallahBody.translate(dallahX, dallahY, dallahZ);
  metalParts.push(colorize(dallahBody, 0xc86b3a, 0.04));

  // Decorative brass waist collar band on dallah
  const dallahCollar = new THREE.TorusGeometry(0.052, 0.007, 6, 16);
  dallahCollar.rotateX(Math.PI * 0.5);
  dallahCollar.translate(dallahX, dallahY + 0.232, dallahZ);
  metalParts.push(colorize(dallahCollar, 0xdca554, 0.04));

  // Crescent pouring beak spout
  const spoutCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.068, 0.145, 0),
    new THREE.Vector3(0.142, 0.205, 0),
    new THREE.Vector3(0.195, 0.275, 0),
    new THREE.Vector3(0.228, 0.298, 0)
  ]);
  const spoutGeo = new THREE.TubeGeometry(spoutCurve, 12, 0.015, 8, false);
  // Taper spout tip smoothly
  const spPos = spoutGeo.attributes.position;
  for (let i = 0; i < spPos.count; i++) {
    const sx = spPos.getX(i);
    const t = smoothstep(0.07, 0.23, sx);
    const cyMid = 0.145 + t * 0.153;
    spPos.setY(i, cyMid + (spPos.getY(i) - cyMid) * (1.0 - t * 0.55));
    spPos.setZ(i, spPos.getZ(i) * (1.0 - t * 0.58));
  }
  spoutGeo.computeVertexNormals();
  spoutGeo.rotateY(dallahRotY);
  spoutGeo.translate(dallahX, dallahY, dallahZ);
  metalParts.push(colorize(spoutGeo, 0xd17642, 0.04));

  // Swept S-scroll brass handle opposite the spout
  const handleCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.052, 0.268, 0),
    new THREE.Vector3(-0.135, 0.285, 0),
    new THREE.Vector3(-0.142, 0.185, 0),
    new THREE.Vector3(-0.082, 0.105, 0)
  ]);
  const handleGeo = new THREE.TubeGeometry(handleCurve, 12, 0.010, 7, false);
  handleGeo.rotateY(dallahRotY);
  handleGeo.translate(dallahX, dallahY, dallahZ);
  metalParts.push(colorize(handleGeo, 0xc89248, 0.04));

  // Two small Fremen spice-coffee finjan cups beside the dallah on the tray
  const cupProfile = [
    new THREE.Vector2(0.004, 0.0),
    new THREE.Vector2(0.022, 0.0),
    new THREE.Vector2(0.036, 0.052),
    new THREE.Vector2(0.032, 0.056),
    new THREE.Vector2(0.018, 0.012),
    new THREE.Vector2(0.004, 0.012)
  ];
  for (const [fx, fz] of [[trayX + 0.12, trayZ + 0.09], [trayX + 0.11, trayZ - 0.08]]) {
    const cup = new THREE.LatheGeometry(cupProfile, 12);
    cup.translate(fx, dallahY, fz);
    metalParts.push(colorize(cup, 0xd29c52, 0.05));
  }

  // Gleaming Fremen Water-Ring Tokens (sietch liter & dram rings resting beside the brazier & dallah)
  const waterRingDefs = [
    { x: -0.35, z: 0.78, r: 0.062, tube: 0.011, rx: Math.PI * 0.5, ry: 0.0, rz: 0.0, yOff: 0.012, hex: 0xdec896 },
    { x: -0.29, z: 0.74, r: 0.056, tube: 0.010, rx: Math.PI * 0.42, ry: 0.32, rz: 0.16, yOff: 0.028, hex: 0xd0b072 },
    { x: -0.42, z: 0.85, r: 0.048, tube: 0.0095, rx: Math.PI * 0.5, ry: 0.0, rz: 0.0, yOff: 0.011, hex: 0xe2d0a4 },
    { x: -0.36, z: 0.87, r: 0.044, tube: 0.009, rx: Math.PI * 0.36, ry: -0.45, rz: 0.28, yOff: 0.026, hex: 0xc9a05c },
    { x: -0.78, z: 0.82, r: 0.058, tube: 0.0105, rx: Math.PI * 0.5, ry: 0.0, rz: 0.0, yOff: 0.012, hex: 0xdcc48c },
    { x: -0.73, z: 0.79, r: 0.046, tube: 0.009, rx: Math.PI * 0.38, ry: 0.52, rz: -0.22, yOff: 0.025, hex: 0xe6d6ad }
  ];
  for (const wr of waterRingDefs) {
    const wgy = localGroundY(wr.x, wr.z) + 0.028;
    const ringGeo = new THREE.TorusGeometry(wr.r, wr.tube, 8, 20);
    ringGeo.rotateX(wr.rx);
    ringGeo.rotateY(wr.ry);
    ringGeo.rotateZ(wr.rz);
    ringGeo.translate(wr.x, wgy + wr.yOff, wr.z);
    metalParts.push(colorize(ringGeo, wr.hex, 0.03));
  }

  // Brass clasp & straps on the Fremkit supply chest
  for (const sOff of [-0.28, 0.28]) {
    const strap = new THREE.BoxGeometry(0.055, 0.47, 0.59);
    strap.translate(sOff, 0.22, 0);
    strap.rotateY(-0.28);
    strap.translate(chestX, chestGy, chestZ);
    metalParts.push(colorize(strap, 0xb88642, 0.05));
  }
  const latch = new THREE.BoxGeometry(0.11, 0.12, 0.04);
  latch.translate(0, 0.38, 0.295);
  latch.rotateY(-0.28);
  latch.translate(chestX, chestGy, chestZ);
  metalParts.push(colorize(latch, 0xd8a858, 0.04));

  const campMetalMesh = new THREE.Mesh(
    mergeGeometries(metalParts, false),
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.27,
      metalness: 0.88,
      clearcoat: 0.24,
      clearcoatRoughness: 0.24
    })
  );
  campMetalMesh.castShadow = true;
  campMetalMesh.receiveShadow = true;
  camp.add(campMetalMesh);

  // Register brazier collider & interactable
  const worldBrazier = new THREE.Vector3(brazierX, brazierGy + 0.6, brazierZ).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY).add(new THREE.Vector3(cx, cy, cz));
  colliders.push({ x: worldBrazier.x, z: worldBrazier.z, r: 0.72 });
  interactables.push({
    id: 'camp_brazier',
    type: 'inspect',
    landmarkId: 'camp',
    position: worldBrazier.clone(),
    radius: 3.4,
    prompt: '[E] Warm by Fremen Spice-Oil Brazier',
    onInteract: (state) => {
      state.markDiscovered('camp');
      state.pushToast('SIETCH SANCTUARY', 'Fremen Desert Bivouac', 'Spiced creosote smoke and melange coffee drift under the woven awning — shelter from Coriolis gusts.');
    }
  });

  function update(dt, state, camera = null) {
    const t = state.elapsed;
    clothUniforms.uTime.value = t;
    clothUniforms.uWindDir.value.copy(state.windDir);
    clothUniforms.uWindSpeed.value = state.windSpeed;
    flameUniforms.uTime.value = t;
    flameUniforms.uWindSpeed.value = state.windSpeed;
    coalUniforms.uTime.value = t;

    const nightFactor = 1.0 - smoothstep(-0.08, 0.20, state.sunDir.y);
    const flicker = 0.88 + 0.10 * Math.sin(t * 15.3) + 0.06 * Math.cos(t * 27.1);
    fireLight.intensity = (2.2 + nightFactor * 5.6 + state.eclipseStrength * 4.4) * flicker;
    const maxLightDist = nightFactor > 0.35 || state.eclipseStrength > 0.25 ? 38.0 : 15.0;
    fireLight.visible =
      fireLight.intensity > 0.02 &&
      (!camera || camera.position.distanceToSquared(worldBrazier) < maxLightDist * maxLightDist);
    coalMesh.material.emissiveIntensity = (1.05 + nightFactor * 0.92 + state.eclipseStrength * 0.65) * flicker;

    // Animate rising ember sparks
    const pos = emberGeo.attributes.position.array;
    for (let i = 0; i < EMBER_COUNT; i++) {
      const life = (t * (0.48 + emberSeed[i] * 0.45) + emberSeed[i] * 7.0) % 1.0;
      const ang = emberSeed[i] * Math.PI * 2 + t * 1.4;
      const drift = life * (0.18 + state.windSpeed * 0.45);
      pos[i * 3] = brazierX + Math.cos(ang) * 0.15 * (1.0 - life * 0.4) + state.windDir.x * drift;
      pos[i * 3 + 1] = brazierGy + 0.54 + life * 1.72;
      pos[i * 3 + 2] = brazierZ + Math.sin(ang) * 0.15 * (1.0 - life * 0.4) + state.windDir.y * drift;
    }
    emberGeo.attributes.position.needsUpdate = true;
  }

  return { group: camp, update, brazierPos: worldBrazier };
}

// ============================================================================
// 2. DOWNED OLD-EMPIRE ORNITHOPTER WRECKAGE (x: 26.0, z: -56.0)
//    Faceted dragonfly scout fuselage tilted into a sunlit Great Erg dune,
//    gleaming metallic canopy, four articulated broken insect wings & beacon.
// ============================================================================

function buildDownedOrnithopter(colliders, interactables) {
  const ox = 26.0;
  const oz = -56.0;
  const oy = getGroundHeight(ox, oz);

  const root = new THREE.Group();
  root.name = 'DownedOrnithopterRoot';

  const wreck = new THREE.Group();
  wreck.name = 'DownedOrnithopterWreck';
  wreck.position.set(ox, oy + 0.36, oz);
  wreck.rotation.set(0.14, -2.28, -0.26); // Dramatic canted impact pose half-claimed by dune sand
  wreck.updateMatrixWorld(true);
  root.add(wreck);

  const hullMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.44,
    metalness: 0.68,
    clearcoat: 0.18,
    clearcoatRoughness: 0.48
  });

  const hullParts = [];

  // Main faceted dragonfly thorax & tapered desert-khaki/titanium armored fuselage
  const thorax = new THREE.CylinderGeometry(1.18, 1.52, 4.1, 8);
  thorax.rotateX(Math.PI * 0.5);
  thorax.scale(1.04, 0.80, 1.0);
  hullParts.push(colorize(thorax, 0x847460, 0.08));

  // Armored dorsal rib bands along thorax
  for (const rz of [-1.2, -0.3, 0.6, 1.4]) {
    const rib = new THREE.CylinderGeometry(1.26, 1.32, 0.18, 8);
    rib.rotateX(Math.PI * 0.5);
    rib.scale(1.06, 0.84, 1.0);
    rib.translate(0, 0.04, rz);
    hullParts.push(colorize(rib, 0x5c5042, 0.05));
  }

  // Faceted forward nose cowling & sensor chin turret
  const nose = new THREE.ConeGeometry(1.18, 2.75, 8);
  nose.rotateX(Math.PI * 0.5);
  nose.scale(1.02, 0.72, 1.0);
  nose.translate(0, -0.06, 3.35);
  hullParts.push(colorize(nose, 0x6f6150, 0.07));

  const chinPod = new THREE.CylinderGeometry(0.28, 0.24, 0.75, 8);
  chinPod.rotateX(Math.PI * 0.5);
  chinPod.translate(0, -0.78, 2.45);
  hullParts.push(colorize(chinPod, 0x3b342d, 0.05));

  // Tapered armored tail boom rising sharply out of the dune sand
  const tailBoom = new THREE.CylinderGeometry(0.38, 1.05, 5.8, 7);
  tailBoom.rotateX(Math.PI * 0.5);
  tailBoom.scale(0.86, 0.68, 1.0);
  tailBoom.translate(0, 0.20, -4.55);
  hullParts.push(colorize(tailBoom, 0x766957, 0.08));

  // Heat-temper gradient palette for exhaust nozzle petals (bronze root -> temper straw -> violet-blue -> scorched cobalt tip)
  const cHeatRoot = new THREE.Color(0x52453a);
  const cHeatGold = new THREE.Color(0xb88442);
  const cHeatViolet = new THREE.Color(0x474a72);
  const cHeatBlue = new THREE.Color(0x2d446c);
  const cHeatTip = new THREE.Color(0x212938);

  function addHeatTemperedNozzle(nx, ny, nz, radius, length, petalCount = 12) {
    // Outer armored exhaust ring
    const collar = new THREE.CylinderGeometry(radius * 1.08, radius * 1.15, length * 0.36, 12);
    collar.rotateX(Math.PI * 0.5);
    collar.translate(nx, ny, nz + length * 0.16);
    hullParts.push(colorize(collar, 0x5c4d3e, 0.05));

    // Recessed dark exhaust throat core
    const throat = new THREE.CylinderGeometry(radius * 0.72, radius * 0.72, length * 0.65, 10);
    throat.rotateX(Math.PI * 0.5);
    throat.translate(nx, ny, nz - length * 0.12);
    hullParts.push(colorize(throat, 0x1e1a18, 0.04));

    // Internal radial stator vanes
    for (let v = 0; v < 6; v++) {
      const va = (v / 6) * Math.PI * 2;
      const stator = new THREE.BoxGeometry(0.022, radius * 1.32, length * 0.28);
      stator.rotateZ(va);
      stator.translate(nx, ny, nz - length * 0.16);
      hullParts.push(colorize(stator, 0x3b445c, 0.05));
    }

    // Overlapping heat-tempered variable-geometry exhaust nozzle petals / vanes
    const petalW = (Math.PI * 2 * radius * 0.94) / petalCount;
    for (let p = 0; p < petalCount; p++) {
      const a = (p / petalCount) * Math.PI * 2;
      const petal = new THREE.BoxGeometry(petalW, 0.026, length, 1, 1, 5);
      // Taper trailing edge slightly and curve inward like an articulated turbine petal
      const pPos = petal.attributes.position;
      for (let i = 0; i < pPos.count; i++) {
        const pz = pPos.getZ(i); // +length/2 at root, -length/2 at exhaust tip
        const uTip = (length * 0.5 - pz) / length; // 0 at root -> 1 at tip
        pPos.setX(i, pPos.getX(i) * (1.0 - uTip * 0.24));
        pPos.setY(i, pPos.getY(i) - uTip * uTip * radius * 0.24);
      }
      petal.computeVertexNormals();
      const coloredPetal = colorizeByFn(petal, (_px, _py, pz, outC) => {
        const uTip = Math.max(0, Math.min(1, (length * 0.5 - pz) / length));
        if (uTip < 0.28) {
          outC.copy(cHeatRoot).lerp(cHeatGold, uTip / 0.28);
        } else if (uTip < 0.62) {
          outC.copy(cHeatGold).lerp(cHeatViolet, (uTip - 0.28) / 0.34);
        } else if (uTip < 0.86) {
          outC.copy(cHeatViolet).lerp(cHeatBlue, (uTip - 0.62) / 0.24);
        } else {
          outC.copy(cHeatBlue).lerp(cHeatTip, (uTip - 0.86) / 0.14);
        }
      });
      coloredPetal.translate(0, radius * 0.96, -length * 0.42);
      coloredPetal.rotateZ(a);
      coloredPetal.translate(nx, ny, nz);
      hullParts.push(coloredPetal);
    }
  }

  // Split V-tail stabilizer fins + twin jet-turbine pods with heat-tempered nozzle vanes + landing skids
  for (const side of [-1, 1]) {
    const fin = new THREE.BoxGeometry(1.85, 0.075, 0.85);
    fin.rotateZ(side * 0.48);
    fin.rotateY(side * -0.18);
    fin.translate(side * 0.92, 0.68, -6.95);
    hullParts.push(colorize(fin, 0x52483c, 0.06));

    // Side jet-turbine nacelle + forward intake lip + compressor spinner
    const pod = new THREE.CylinderGeometry(0.36, 0.45, 2.55, 10);
    pod.rotateX(Math.PI * 0.5);
    pod.translate(side * 1.56, -0.06, -1.05);
    hullParts.push(colorize(pod, 0x453d34, 0.05));

    const intakeRing = new THREE.TorusGeometry(0.34, 0.045, 7, 14);
    intakeRing.translate(side * 1.56, -0.06, 0.24);
    hullParts.push(colorize(intakeRing, 0x9b7848, 0.05));

    const spinner = new THREE.ConeGeometry(0.12, 0.30, 8);
    spinner.rotateX(Math.PI * 0.5);
    spinner.translate(side * 1.56, -0.06, 0.22);
    hullParts.push(colorize(spinner, 0x7c6e5c, 0.04));

    // Heat-tempered segmented jet-turbine exhaust nozzle vanes
    addHeatTemperedNozzle(side * 1.56, -0.06, -2.36, 0.34, 0.58, 12);

    // Bent landing strut & skid
    const strut = new THREE.CylinderGeometry(0.065, 0.075, 1.25, 7);
    strut.rotateZ(side * 0.35);
    strut.translate(side * 1.15, -1.02, 0.45);
    hullParts.push(colorize(strut, 0x3b352f, 0.05));

    const skid = new THREE.BoxGeometry(0.18, 0.09, 3.2);
    skid.translate(side * 1.48, -1.52, 0.65);
    hullParts.push(colorize(skid, 0x4a4239, 0.05));
  }

  // Dorsal brass wing-hinge mechanical housing, auxiliary heat-tempered turbine vent & cockpit mullion frame
  const spine = new THREE.BoxGeometry(1.04, 0.62, 3.4);
  spine.translate(0, 0.94, -0.35);
  hullParts.push(colorize(spine, 0x987444, 0.06));

  addHeatTemperedNozzle(0, 0.88, -2.08, 0.22, 0.42, 10);

  // Dark cockpit interior bulkhead & instrument dash shroud beneath glass canopy
  const cockpitDash = new THREE.BoxGeometry(1.18, 0.36, 1.45);
  cockpitDash.translate(0, 0.44, 1.72);
  hullParts.push(colorize(cockpitDash, 0x1c1816, 0.04));

  for (const ang of [-0.36, 0, 0.36]) {
    const mullion = new THREE.BoxGeometry(0.075, 0.06, 2.2);
    mullion.rotateY(ang * 0.4);
    mullion.rotateX(0.24);
    mullion.translate(Math.sin(ang) * 0.85, 0.96, 1.55);
    hullParts.push(colorize(mullion, 0x433b32, 0.04));
  }

  const hullMesh = new THREE.Mesh(mergeGeometries(hullParts, false), hullMat);
  hullMesh.castShadow = true;
  hullMesh.receiveShadow = true;
  wreck.add(hullMesh);

  // Subtle Distress / Instrument Amber Glint inside the Fractured Cockpit Canopy
  const consoleParts = [];
  const mainScreen = new THREE.BoxGeometry(0.56, 0.15, 0.04);
  mainScreen.rotateX(-0.42);
  mainScreen.translate(0, 0.69, 2.12);
  consoleParts.push(colorize(mainScreen, 0xffaa38, 0.02));

  for (const side of [-1, 1]) {
    const sideGauge = new THREE.BoxGeometry(0.26, 0.11, 0.035);
    sideGauge.rotateY(side * -0.45);
    sideGauge.rotateX(-0.32);
    sideGauge.translate(side * 0.46, 0.65, 1.88);
    consoleParts.push(colorize(sideGauge, 0xff8624, 0.02));
  }
  const warnPip = new THREE.BoxGeometry(0.14, 0.045, 0.035);
  warnPip.rotateX(-0.35);
  warnPip.translate(0.12, 0.78, 1.98);
  consoleParts.push(colorize(warnPip, 0xff521c, 0.02));

  const cockpitGlintMat = new THREE.MeshStandardMaterial({
    color: 0x261408,
    vertexColors: true,
    emissive: new THREE.Color(0xff9224),
    emissiveIntensity: 0.75,
    roughness: 0.25
  });
  const cockpitConsoleMesh = new THREE.Mesh(mergeGeometries(consoleParts, false), cockpitGlintMat);
  wreck.add(cockpitConsoleMesh);

  const cockpitLight = new THREE.PointLight(0xff8c28, 0.0, 4.8, 2.0);
  cockpitLight.position.set(0.05, 0.78, 1.88);
  cockpitLight.visible = false;
  wreck.add(cockpitLight);

  // Gleaming fractured obsidian-amber cockpit glass canopy (PMREM reflection + translucent interior amber glint!)
  const glassGeo = new THREE.SphereGeometry(1.08, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.56);
  glassGeo.scale(0.88, 0.68, 1.88);
  glassGeo.translate(0, 0.48, 1.48);
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x16242e,
    roughness: 0.09,
    metalness: 0.26,
    reflectivity: 1.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    transparent: true,
    opacity: 0.70
  });
  const glassMesh = new THREE.Mesh(glassGeo, glassMat);
  glassMesh.castShadow = true;
  wreck.add(glassMesh);

  // Subtle fractured glass spiderweb stress lines hugging the forward-starboard canopy dome
  const crackParts = [];
  const crackOrigin = new THREE.Vector3(0.46, 0.88, 2.18);
  const crackDirs = [
    new THREE.Vector3(0.28, 0.14, -0.32),
    new THREE.Vector3(-0.34, 0.18, 0.22),
    new THREE.Vector3(0.18, -0.18, 0.42),
    new THREE.Vector3(-0.18, -0.14, -0.46),
    new THREE.Vector3(0.32, -0.06, 0.12)
  ];
  for (const cd of crackDirs) {
    const pMid = crackOrigin.clone().addScaledVector(cd, 0.52);
    const pEnd = crackOrigin.clone().add(cd);
    // Project onto canopy ellipsoid surface slightly proud (+0.015) so cracks glint cleanly
    for (const pt of [pMid, pEnd]) {
      const dx = pt.x / 0.96;
      const dy = (pt.y - 0.48) / 0.74;
      const dz = (pt.z - 1.48) / 2.04;
      const len = Math.hypot(dx, dy, dz) || 1;
      pt.set((dx / len) * 0.965, 0.48 + (dy / len) * 0.745, 1.48 + (dz / len) * 2.045);
    }
    const cCurve = new THREE.CatmullRomCurve3([crackOrigin.clone(), pMid, pEnd]);
    const cGeo = new THREE.TubeGeometry(cCurve, 6, 0.008, 4, false);
    crackParts.push(colorize(cGeo, 0xd8c9b0, 0.04));
  }
  const crackMesh = new THREE.Mesh(
    mergeGeometries(crackParts, false),
    new THREE.MeshStandardMaterial({
      color: 0xe6d7bf,
      emissive: new THREE.Color(0x523418),
      emissiveIntensity: 0.35,
      roughness: 0.16,
      metalness: 0.42,
      transparent: true,
      opacity: 0.62
    })
  );
  wreck.add(crackMesh);

  // Articulated Tapered Dragonfly Wings + Wind-Fluttering Torn Wing Membrane Ribbons!
  const membraneMat = new THREE.MeshPhysicalMaterial({
    color: 0x6e5a42,
    roughness: 0.38,
    metalness: 0.35,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide
  });

  const ribbonUniforms = {
    uTime: { value: 0 },
    uWindSpeed: { value: 0.45 }
  };
  const tornRibbonMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.42,
    metalness: 0.22,
    transparent: true,
    opacity: 0.78,
    side: THREE.DoubleSide
  });
  tornRibbonMat.customProgramCacheKey = () => 'arrakis-ornithopter-ribbons-v1';
  tornRibbonMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = ribbonUniforms.uTime;
    shader.uniforms.uWindSpeed = ribbonUniforms.uWindSpeed;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWindSpeed;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float uRip = clamp(uv.x, 0.0, 1.0);
        float phase = position.x * 2.7 + position.z * 3.1;
        float gust = 0.42 + uWindSpeed * 0.95;
        float whipY = sin(uRip * 10.5 - uTime * (6.2 + uWindSpeed * 7.8) + phase) * 0.14 * uRip * uRip * gust;
        float whipZ = cos(uRip * 8.2 - uTime * (4.8 + uWindSpeed * 6.4) + phase * 1.3) * 0.11 * uRip * uRip * gust;
        transformed.y += whipY - (1.0 - min(1.0, uWindSpeed * 0.85)) * uRip * uRip * 0.10;
        transformed.z += whipZ;`
      );
  };

  function makeWing(length, width, broken = false, seedOffset = 0) {
    const wGroup = new THREE.Group();
    const effLen = broken ? length * 0.62 : length;
    const sparParts = [];

    // Tapered leading-edge titanium spar
    const spar = new THREE.CylinderGeometry(0.032, 0.082, effLen, 6);
    spar.rotateZ(-Math.PI * 0.5);
    spar.translate(effLen * 0.5, 0.02, 0);
    sparParts.push(colorize(spar, 0x4b4338, 0.05));

    // Diagonal dragonfly cross-vein ribs along wing
    const ribCount = broken ? 4 : 7;
    for (let r = 0; r < ribCount; r++) {
      const u = (r + 0.6) / (ribCount + 0.5);
      const localW = width * (0.55 + 0.55 * Math.sin(u * Math.PI * 0.88));
      const rib = new THREE.BoxGeometry(0.045, 0.028, localW);
      rib.rotateY(-0.26);
      rib.translate(u * effLen, 0, -localW * 0.46);
      sparParts.push(colorize(rib, 0x8d6e44, 0.05));
    }

    const sparMesh = new THREE.Mesh(mergeGeometries(sparParts, false), hullMat);
    sparMesh.castShadow = true;
    sparMesh.receiveShadow = true;
    wGroup.add(sparMesh);

    // Tapered translucent dragonfly membrane blade
    const memGeo = new THREE.PlaneGeometry(effLen * 0.96, width, 12, 2);
    memGeo.rotateX(-Math.PI * 0.5);
    const mp = memGeo.attributes.position;
    for (let i = 0; i < mp.count; i++) {
      const u = Math.max(0, Math.min(1, mp.getX(i) / (effLen * 0.96) + 0.5)); // strictly clamped [0..1]
      const taper = 0.45 + 0.65 * Math.sin(Math.pow(u, 0.72) * Math.PI * 0.92);
      mp.setZ(i, mp.getZ(i) * taper - width * 0.44 * taper);
    }
    memGeo.translate(effLen * 0.5, 0, 0);
    memGeo.computeVertexNormals();
    const memMesh = new THREE.Mesh(memGeo, membraneMat);
    memMesh.castShadow = true;
    wGroup.add(memMesh);

    // Wind-fluttering torn wing membrane ribbons streaming from sheared tips & tattered trailing edges
    const ribbonParts = [];
    const ribbonSpecs = broken
      ? [
          { ax: effLen * 0.96, az: -0.06, len: 1.48, wid: 0.22, yaw: -0.18, droop: -0.08, hex: 0x9b794a },
          { ax: effLen * 0.92, az: -0.28, len: 1.24, wid: 0.18, yaw: -0.44, droop: -0.14, hex: 0x88673e },
          { ax: effLen * 0.78, az: -0.52, len: 1.05, wid: 0.16, yaw: -0.78, droop: -0.12, hex: 0xa48252 },
          { ax: effLen * 0.54, az: -width * 0.74, len: 0.84, wid: 0.14, yaw: -1.12, droop: -0.10, hex: 0x7e603a }
        ]
      : [
          { ax: effLen * 0.42, az: -width * 0.84, len: 0.88, wid: 0.16, yaw: -1.25 + seedOffset * 0.08, droop: -0.10, hex: 0x947346 },
          { ax: effLen * 0.68, az: -width * 0.80, len: 1.06, wid: 0.18, yaw: -1.12 - seedOffset * 0.06, droop: -0.08, hex: 0xa58352 },
          { ax: effLen * 0.88, az: -width * 0.58, len: 0.92, wid: 0.15, yaw: -0.82 + seedOffset * 0.05, droop: -0.06, hex: 0x8a6940 }
        ];

    for (const rs of ribbonSpecs) {
      const rGeo = new THREE.PlaneGeometry(rs.len, rs.wid, 10, 2);
      rGeo.rotateX(-Math.PI * 0.5);
      // Shift so u=0 (x=0) is pinned cleanly to wing anchor and u=1 (x=rs.len) whips freely
      rGeo.translate(rs.len * 0.5, 0, 0);
      const rp = rGeo.attributes.position;
      const ruv = rGeo.attributes.uv;
      for (let i = 0; i < rp.count; i++) {
        const u = Math.max(0, Math.min(1, rp.getX(i) / rs.len));
        ruv.setX(i, u);
        // Taper to jagged torn ribbon point
        const taper = (1.0 - u * 0.82) * (0.86 + 0.14 * Math.sin(u * 14.0 + rs.ax));
        rp.setZ(i, rp.getZ(i) * taper);
        rp.setY(i, rp.getY(i) + rs.droop * u * u);
      }
      rGeo.computeVertexNormals();
      rGeo.rotateY(rs.yaw);
      rGeo.translate(rs.ax, 0.01, rs.az);
      ribbonParts.push(colorize(rGeo, rs.hex, 0.07));
    }

    const ribbonsMesh = new THREE.Mesh(mergeGeometries(ribbonParts, false), tornRibbonMat);
    ribbonsMesh.castShadow = true;
    wGroup.add(ribbonsMesh);

    return wGroup;
  }

  const wingConfigs = [
    { side: 1, z: 0.72, len: 6.8, wid: 0.88, rz: 0.58, ry: -0.20, broken: false },
    { side: 1, z: -0.68, len: 6.2, wid: 0.78, rz: 0.36, ry: -0.44, broken: false },
    { side: -1, z: 0.72, len: 5.8, wid: 0.84, rz: -0.28, ry: 0.28, broken: true },
    { side: -1, z: -0.68, len: 5.2, wid: 0.74, rz: -0.18, ry: 0.48, broken: true }
  ];
  const windWings = [];
  for (let wi = 0; wi < wingConfigs.length; wi++) {
    const wc = wingConfigs[wi];
    const w = makeWing(wc.len, wc.wid, wc.broken, wi);
    w.scale.x = wc.side;
    w.position.set(wc.side * 0.48, 0.96, wc.z);
    w.rotation.set(0.08, wc.ry, wc.rz);
    wreck.add(w);
    if (!wc.broken) {
      windWings.push({ obj: w, baseRz: wc.rz });
    }
  }

  // Pulsing Amber-Red Distress Transponder Beacon on tail spine
  const beaconMat = new THREE.MeshStandardMaterial({
    color: 0xff3c20,
    emissive: new THREE.Color(0xff441c),
    emissiveIntensity: 3.2,
    roughness: 0.2
  });
  const beaconBulb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), beaconMat);
  beaconBulb.position.set(0, 1.24, -1.72);
  wreck.add(beaconBulb);

  const beaconLight = new THREE.PointLight(0xff4c24, 0.0, 26.0, 1.7);
  beaconLight.position.set(0, 1.48, -1.72);
  beaconLight.visible = false;
  wreck.add(beaconLight);

  // --- Wind-Scoured Eolian Sand-Drift Aprons Banking Smoothly Against Fuselage Nose & Skids ---
  // Extract exact horizontal fuselage axes from wreck quaternion so banks wrap hull & skids seamlessly
  const fwdAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(wreck.quaternion);
  fwdAxis.y = 0;
  fwdAxis.normalize();
  const rightAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(wreck.quaternion);
  rightAxis.y = 0;
  rightAxis.normalize();

  const apronGeo = new THREE.PlaneGeometry(15.0, 15.0, 52, 52);
  apronGeo.rotateX(-Math.PI * 0.5);
  const aPos = apronGeo.attributes.position;
  const aCol = new Float32Array(aPos.count * 3);
  // Linear RGB matching terrain.js Great Erg sand palette (sandMid / sandCrest / sandTrough) seamlessly!
  const cSandBase = new THREE.Color().setRGB(0.64, 0.42, 0.205);
  const cSandCrest = new THREE.Color().setRGB(0.80, 0.56, 0.295);
  const cSandShadow = new THREE.Color().setRGB(0.46, 0.27, 0.125);
  const aTmp = new THREE.Color();

  for (let i = 0; i < aPos.count; i++) {
    const lx = aPos.getX(i);
    const lz = aPos.getZ(i);
    const wx = ox + lx;
    const wz = oz + lz;
    const baseY = getGroundHeight(wx, wz);

    // Local coordinates aligned with fuselage: u (+fwd nose .. -aft tail), v (+starboard .. -port)
    const u = lx * fwdAxis.x + lz * fwdAxis.z;
    const v = lx * rightAxis.x + lz * rightAxis.z;

    // 1. Forward nose impact plow berm cradling chin turret & lower nose bevel (zero floating gap!)
    const noseBerm = 0.74 * Math.exp(-Math.pow((u - 2.55) / 2.25, 2.0) - Math.pow((v + 0.15) / 2.45, 2.0));
    // 2. Port landing skid & strut wind-drift apron banking up smoothly around skidL_fwd & skidL_mid
    const portSkidBank = 0.56 * Math.exp(-Math.pow((u - 1.35) / 2.55, 2.0) - Math.pow((v + 1.52) / 1.65, 2.0));
    // 3. Starboard camera-facing fuselage flank & buried skid smooth eolian ramp
    const stbdFlankBank = 0.48 * Math.exp(-Math.pow((u - 0.10) / 3.65, 2.0) - Math.pow((v - 1.55) / 2.35, 2.0));
    // 4. Wind-swept side dune shoulder streaming downwind along starboard flank
    const stbdDriftTail = 0.28 * Math.exp(-Math.pow((u + 1.65) / 3.10, 2.0) - Math.pow((v - 2.55) / 2.15, 2.0));
    // 5. Leeward tail-boom sand tail blending the buried tail boom into the dune crest
    const tailBank = 0.38 * Math.exp(-Math.pow((u + 3.85) / 3.45, 2.0) - Math.pow((v - 0.35) / 2.35, 2.0));

    // Gentle natural wind-scour ripple modulation across the drift apron
    const windScour =
      (Math.sin(u * 1.4 + v * 0.9) * 0.036 + Math.cos(u * 2.8 - v * 2.1) * 0.018) *
      smoothstep(0.08, 0.50, noseBerm + portSkidBank + stbdFlankBank);

    // Keep port turbine nozzle (u ≈ -2.4, v ≈ -1.56) clearly exposed above the sand
    const nozzleKeepClear = 1.0 - 0.76 * Math.exp(-Math.pow((u + 2.4) / 1.30, 2.0) - Math.pow((v + 1.55) / 1.20, 2.0));

    const radialDist = Math.hypot(lx, lz);
    const edgeFade = 1.0 - smoothstep(4.8, 7.2, radialDist);
    const rawDrift = Math.max(noseBerm, portSkidBank, stbdFlankBank, tailBank) + stbdDriftTail * 0.36;
    const driftH = Math.max(0, (rawDrift * nozzleKeepClear + windScour) * edgeFade);

    // Tuck perimeter smoothly below dune surface so apron emerges seamlessly with zero visible edge seam
    const edgeTuck = -0.10 * (1.0 - smoothstep(0.01, 0.16, driftH));
    aPos.setY(i, baseY + driftH + edgeTuck);

    // Match Great Erg dune sand palette (warm crest highlights + subtle shadow crease against hull)
    const hullCrease = Math.exp(-Math.pow((u - 0.4) / 3.6, 2.0) - Math.pow(v / 1.35, 2.0));
    aTmp.copy(cSandBase);
    aTmp.lerp(cSandCrest, smoothstep(0.16, 0.68, driftH) * 0.42);
    aTmp.lerp(cSandShadow, hullCrease * 0.20);
    aCol[i * 3] = aTmp.r;
    aCol[i * 3 + 1] = aTmp.g;
    aCol[i * 3 + 2] = aTmp.b;
  }
  apronGeo.setAttribute('color', new THREE.BufferAttribute(aCol, 3));
  apronGeo.computeVertexNormals();

  const apronUniforms = {
    uWindDir: { value: new THREE.Vector2(0.91, 0.41) }
  };
  const sandApronMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.0
  });
  sandApronMat.customProgramCacheKey = () => 'arrakis-ornithopter-sand-apron-v2';
  sandApronMat.onBeforeCompile = (shader) => {
    shader.uniforms.uWindDir = apronUniforms.uWindDir;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vApronWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvApronWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}\nuniform vec2 uWindDir;\nvarying vec3 vApronWorldPos;`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 wD = normalize(uWindDir);
        vec2 wP = vec2(-wD.y, wD.x);
        float aAlong = dot(vApronWorldPos.xz, wD);
        float aCross = dot(vApronWorldPos.xz, wP);
        float meander = (fbm2(vec2(aAlong * 0.14, aCross * 0.22)) - 0.5) * 0.8;
        float rip = sin((aAlong + meander) * 20.5) * 0.5 + 0.5;
        float grain = vnoise2(vApronWorldPos.xz * 26.0) * 0.55 + vnoise2(vApronWorldPos.xz * 58.0) * 0.45;
        diffuseColor.rgb *= (0.95 + 0.065 * rip + (grain - 0.5) * 0.08);`
      );
  };
  const sandApronMesh = new THREE.Mesh(apronGeo, sandApronMat);
  sandApronMesh.position.set(ox, 0, oz);
  sandApronMesh.castShadow = true;
  sandApronMesh.receiveShadow = true;
  root.add(sandApronMesh);

  const wreckWorldPos = new THREE.Vector3(ox, oy + 1.0, oz);
  colliders.push({ x: ox, z: oz, r: 3.4 });
  interactables.push({
    id: 'ornithopter_blackbox',
    type: 'inspect',
    landmarkId: 'ornithopter',
    position: new THREE.Vector3(ox, oy + 1.2, oz),
    radius: 6.2,
    prompt: '[E] Inspect Imperial Ornithopter Transponder',
    onInteract: (state) => {
      state.markDiscovered('ornithopter');
      state.pushToast(
        'BLACKBOX LOG · CORIOLIS LOSS',
        'Downed Imperial Ornithopter',
        'Last telemetry: "Wing servo sheared in 180 km/h sandstorm. Maker sign bearing 340°..."'
      );
    }
  });

  function update(_dt, state, camera = null) {
    const t = state.elapsed;
    ribbonUniforms.uTime.value = t;
    ribbonUniforms.uWindSpeed.value = state.windSpeed;
    apronUniforms.uWindDir.value.copy(state.windDir);

    // Double-pulse distress beacon rhythm + dynamic PointLight visibility gating
    const cycle = t % 2.4;
    const pulse =
      Math.exp(-Math.pow((cycle - 0.18) / 0.07, 2)) +
      Math.exp(-Math.pow((cycle - 0.42) / 0.08, 2)) * 0.72;
    beaconMat.emissiveIntensity = 0.25 + pulse * 5.2;
    beaconLight.intensity = pulse * 10.5;
    beaconLight.visible =
      beaconLight.intensity > 0.02 &&
      (!camera || camera.position.distanceToSquared(wreckWorldPos) < 55.0 * 55.0);

    // Subtle distress/instrument amber glint inside fractured cockpit canopy (PointLight gated off in bright daytime!)
    const duskNight = 1.0 - smoothstep(-0.08, 0.30, state.sunDir.y);
    const glintLvl = Math.min(1.0, duskNight + state.eclipseStrength * 0.85);
    const avionicsHum = 0.88 + 0.08 * Math.sin(t * 7.3) + 0.04 * Math.sin(t * 23.1);
    cockpitGlintMat.emissiveIntensity = (0.55 + glintLvl * 1.95) * avionicsHum;

    const nightCockpit = Math.min(1.0, (1.0 - smoothstep(-0.08, 0.06, state.sunDir.y)) + state.eclipseStrength * 0.85);
    cockpitLight.intensity = nightCockpit > 0.02 ? nightCockpit * 1.65 * avionicsHum : 0.0;
    cockpitLight.visible =
      cockpitLight.intensity > 0.02 &&
      (!camera || camera.position.distanceToSquared(wreckWorldPos) < 38.0 * 38.0);

    // Subtle wind shudder on intact skyward wings
    for (let i = 0; i < windWings.length; i++) {
      const ww = windWings[i];
      ww.obj.rotation.z =
        ww.baseRz + Math.sin(t * (2.6 + i * 0.7) + i) * 0.014 * (0.4 + state.windSpeed * 0.9);
    }
  }

  return { group: root, update };
}

// ============================================================================
// 3. FREMEN QANAT TRAIL LANTERNS & DEW-COLLECTOR WIND HARPS
//    Fully batched via mergeGeometries + dynamic PointLight visibility gating.
// ============================================================================

function buildLanternsAndHarps(colliders) {
  const root = new THREE.Group();
  root.name = 'FremenLanternsAndHarps';

  const lanternPositions = [
    { x: -5.8, z: 11.8 },
    { x: -7.8, z: 4.2 },
    { x: -9.5, z: -3.2 },
    { x: -13.9, z: -11.4 },
    { x: -17.6, z: -18.8 }
  ];

  const basaltMat = new THREE.MeshStandardMaterial({ color: 0x3b312a, roughness: 0.88, metalness: 0.08 });
  const brassMat = new THREE.MeshStandardMaterial({ color: 0xb98544, roughness: 0.38, metalness: 0.78 });
  const flameCoreMat = new THREE.MeshStandardMaterial({
    color: 0xffd28a,
    emissive: new THREE.Color(0xff9234),
    emissiveIntensity: 0.1,
    roughness: 0.2
  });

  const postParts = [];
  const crownParts = [];
  const coreParts = [];
  const lanternLights = [];

  for (let i = 0; i < lanternPositions.length; i++) {
    const lp = lanternPositions[i];
    const gy = getGroundHeight(lp.x, lp.z) - 0.06;

    // Carved tapered basalt pedestal
    const post = new THREE.CylinderGeometry(0.065, 0.12, 1.38, 6);
    post.translate(lp.x, gy + 0.69, lp.z);
    postParts.push(post.index ? post.toNonIndexed() : post);

    // Pierced brass lantern crown & rim
    const cap = new THREE.ConeGeometry(0.18, 0.24, 6);
    cap.translate(lp.x, gy + 1.66, lp.z);
    crownParts.push(cap.index ? cap.toNonIndexed() : cap);

    const rim = new THREE.CylinderGeometry(0.13, 0.10, 0.06, 6);
    rim.translate(lp.x, gy + 1.38, lp.z);
    crownParts.push(rim.index ? rim.toNonIndexed() : rim);

    // Warm flame/glowglobe bulb inside
    const core = new THREE.OctahedronGeometry(0.095, 1);
    core.translate(lp.x, gy + 1.50, lp.z);
    coreParts.push(core.index ? core.toNonIndexed() : core);

    // Real PointLights on alternate key lanterns so dusk/night trail pools with warm amber glow
    if (i === 0 || i === 2 || i === 4) {
      const pt = new THREE.PointLight(0xff9b48, 0, 14.0, 1.8);
      const worldPos = new THREE.Vector3(lp.x, gy + 1.56, lp.z);
      pt.position.copy(worldPos);
      pt.visible = false;
      root.add(pt);
      lanternLights.push({ light: pt, phase: i * 2.1, worldPos });
    }

    colliders.push({ x: lp.x, z: lp.z, r: 0.32 });
  }

  const postsMesh = new THREE.Mesh(mergeGeometries(postParts, false), basaltMat);
  postsMesh.castShadow = true;
  postsMesh.receiveShadow = true;
  root.add(postsMesh);

  const crownsMesh = new THREE.Mesh(mergeGeometries(crownParts, false), brassMat);
  crownsMesh.castShadow = true;
  root.add(crownsMesh);

  const coresMesh = new THREE.Mesh(mergeGeometries(coreParts, false), flameCoreMat);
  root.add(coresMesh);

  // Dew-Collector Wind Harps along rocky canyon shoulders (batched into 1 frame mesh + 1 net mesh!)
  const harpCoords = [
    { x: 11.6, z: 2.2, yaw: -0.4 },
    { x: 12.2, z: -5.2, yaw: -0.7 },
    { x: 10.8, z: -12.4, yaw: -0.2 },
    { x: -11.4, z: 15.2, yaw: 0.6 }
  ];
  const harpFrameParts = [];
  const harpNetParts = [];
  for (const hc of harpCoords) {
    const gy = getGroundHeight(hc.x, hc.z) - 0.1;

    const frameL = new THREE.CylinderGeometry(0.025, 0.035, 3.1, 6);
    frameL.rotateZ(0.10);
    frameL.translate(-0.42, 1.48, 0);
    frameL.rotateY(hc.yaw);
    frameL.translate(hc.x, gy, hc.z);
    harpFrameParts.push(colorize(frameL, 0x8e6b40));

    const frameR = new THREE.CylinderGeometry(0.025, 0.035, 3.1, 6);
    frameR.rotateZ(-0.10);
    frameR.translate(0.42, 1.48, 0);
    frameR.rotateY(hc.yaw);
    frameR.translate(hc.x, gy, hc.z);
    harpFrameParts.push(colorize(frameR, 0x8e6b40));

    const barTop = new THREE.CylinderGeometry(0.022, 0.022, 0.62, 6);
    barTop.rotateZ(Math.PI * 0.5);
    barTop.translate(0, 2.95, 0);
    barTop.rotateY(hc.yaw);
    barTop.translate(hc.x, gy, hc.z);
    harpFrameParts.push(colorize(barTop, 0xb88c52));

    const netGeo = new THREE.PlaneGeometry(0.68, 2.35);
    netGeo.translate(0, 1.65, 0);
    netGeo.rotateY(hc.yaw);
    netGeo.translate(hc.x, gy, hc.z);
    harpNetParts.push(netGeo.index ? netGeo.toNonIndexed() : netGeo);
  }

  const harpFrameMesh = new THREE.Mesh(
    mergeGeometries(harpFrameParts, false),
    new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.38, metalness: 0.78 })
  );
  harpFrameMesh.castShadow = true;
  root.add(harpFrameMesh);

  const harpNetMesh = new THREE.Mesh(
    mergeGeometries(harpNetParts, false),
    new THREE.MeshPhysicalMaterial({
      color: 0xdbe6ef,
      roughness: 0.25,
      metalness: 0.35,
      transparent: true,
      opacity: 0.26,
      side: THREE.DoubleSide
    })
  );
  root.add(harpNetMesh);

  function update(_dt, state, camera = null) {
    const t = state.elapsed;
    const nightAmt = Math.max(1.0 - smoothstep(-0.10, 0.08, state.sunDir.y), state.eclipseStrength * 0.85);
    flameCoreMat.emissiveIntensity = 0.08 + nightAmt * 2.85;
    for (let i = 0; i < lanternLights.length; i++) {
      const l = lanternLights[i];
      const flk = 0.90 + 0.10 * Math.sin(t * 11.4 + l.phase);
      l.light.intensity = nightAmt * 6.2 * flk;
      l.light.visible =
        l.light.intensity > 0.02 &&
        (!camera || camera.position.distanceToSquared(l.worldPos) < 42.0 * 42.0);
    }
  }

  return { group: root, update };
}

// ============================================================================
// 4. HARVESTABLE MÉLANGE SPICE SEAMS
//    Batched crystal veins per node + Hero Pre-Spice Blow Crater rim crust.
// ============================================================================

function buildSpiceNodes(interactables) {
  const root = new THREE.Group();
  root.name = 'MelangeSpiceNodes';

  const nodeDefs = [
    { id: 'spice_ridge', x: 8.8, z: -31.5, name: 'Erg Margin Spice Seam', landmarkId: null },
    { id: 'spice_east', x: 15.2, z: -45.5, name: 'Leeward Slipface Mélange', landmarkId: null },
    { id: 'spice_wreck', x: 24.2, z: -52.2, name: 'Scattered Cargo Mélange', landmarkId: 'ornithopter' },
    { id: 'spice_mid', x: -14.5, z: -51.5, name: 'Deep Trough Cinnamon Vein', landmarkId: null },
    { id: 'spice_crater', x: -21.0, z: -68.0, name: 'Pre-Spice Blow Core', landmarkId: 'spice' }
  ];

  const nodes = [];
  const rand = mulberry32(4219);
  const _unitScale = new THREE.Vector3(1, 1, 1);
  const _harvestScale = new THREE.Vector3(0.25, 0.25, 0.25);

  for (let i = 0; i < nodeDefs.length; i++) {
    const def = nodeDefs[i];
    const isCrater = def.id === 'spice_crater';
    const gy = getGroundHeight(def.x, def.z);
    const gNorm = getGroundNormal(def.x, def.z, new THREE.Vector3());

    const g = new THREE.Group();
    if (isCrater) {
      // Hero crater stays world-aligned at (def.x, gy, def.z) so every rim crystal & vein conforms directly to crater terrain!
      g.position.set(def.x, gy, def.z);
    } else {
      g.position.set(def.x, gy + 0.02, def.z);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), gNorm);
    }

    // Natural cinnamon-amber mélange mineral veins (hero crater adds cobalt-blue mélange shimmer!)
    const mat = new THREE.MeshStandardMaterial({
      color: isCrater ? 0xffffff : 0x7a2e10,
      vertexColors: isCrater,
      emissive: new THREE.Color(isCrater ? 0x6c3214 : 0x9e4214),
      emissiveIntensity: isCrater ? 0.34 : 0.10,
      roughness: isCrater ? 0.44 : 0.62,
      metalness: isCrater ? 0.26 : 0.12
    });

    const shardParts = [];
    if (isCrater) {
      // Inner deposit shards + outer concentric crater-rim mélange crystal crust (r = 3.2..6.8m outside central geyser!)
      const cCinn = new THREE.Color(0x883210);
      const cAmber = new THREE.Color(0xc46020);
      const cIbad = new THREE.Color(0x3a72c8);
      const tmpC = new THREE.Color();

      const rimCount = 34;
      for (let k = 0; k < rimCount; k++) {
        const ring = k < 10 ? 0 : k < 24 ? 1 : 2;
        const a =
          ring === 0
            ? (k / 10) * Math.PI * 2 + 0.15
            : ring === 1
              ? ((k - 10) / 14) * Math.PI * 2 + 0.32
              : ((k - 24) / 10) * Math.PI * 2 + 0.68;
        const r =
          ring === 0
            ? 3.1 + rand() * 0.95
            : ring === 1
              ? 4.2 + rand() * 1.45
              : 5.5 + rand() * 1.45;
        const lx = Math.cos(a) * r;
        const lz = Math.sin(a) * r;
        const ly = getGroundHeight(def.x + lx, def.z + lz) - gy;

        // Multi-crystal cluster per rim seam (2-3 clustered tilted mineral prisms)
        const subCount = ring === 1 ? 3 : 2;
        for (let s = 0; s < subCount; s++) {
          const sx = lx + (rand() - 0.5) * 0.55;
          const sz = lz + (rand() - 0.5) * 0.55;
          const sy = getGroundHeight(def.x + sx, def.z + sz) - gy;
          const rad = (s === 0 ? 0.32 : 0.20) + rand() * 0.24;
          const hScale = (s === 0 ? 0.48 : 0.36) + rand() * 0.28;
          const shard = new THREE.OctahedronGeometry(rad, 0);
          shard.scale(1.15, hScale, 0.85);
          shard.rotateX((rand() - 0.5) * 0.45);
          shard.rotateY(a + s * 1.1);
          shard.rotateZ((rand() - 0.5) * 0.42);
          // Rich burnt-cinnamon base with subtle amber & rare Ibad-blue mineral tip glint
          const isBlueVein = (k + s) % 5 === 0;
          const coloredShard = colorizeByFn(shard, (_px, py, _pz, outC) => {
            const tip = smoothstep(-rad * 0.1, rad * hScale * 0.85, py);
            tmpC.copy(cCinn).lerp(isBlueVein ? cIbad : cAmber, tip * (isBlueVein ? 0.68 : 0.74));
            outC.copy(tmpC);
          });
          coloredShard.translate(sx, sy + rad * hScale * 0.25, sz);
          shardParts.push(coloredShard);
        }
      }
    } else {
      // Compact natural flattened cinnamon-amber mineral cluster merged into 1 draw call
      for (let k = 0; k < 9; k++) {
        const shard = new THREE.OctahedronGeometry(0.15, 0);
        shard.scale(1.0, 0.24, 0.88);
        const a = (k / 9) * Math.PI * 2 + i * 1.3;
        const r = k === 0 ? 0.04 : 0.20 + (k % 3) * 0.24;
        const sc = k === 0 ? 1.08 : 0.42 + (k % 3) * 0.17;
        shard.scale(sc, sc, sc);
        shard.rotateX((k % 2) * 0.16);
        shard.rotateY(a);
        shard.rotateZ(0.08);
        shard.translate(Math.cos(a) * r, -0.01, Math.sin(a) * r);
        shardParts.push(shard.index ? shard.toNonIndexed() : shard);
      }
    }

    const cluster = new THREE.Mesh(mergeGeometries(shardParts, false), mat);
    cluster.receiveShadow = true;
    g.add(cluster);

    // Organic feathered wind-drifted spice stain & shimmer (terrain-conforming wide rim stain for hero crater!)
    const haloUniforms = {
      uTime: { value: 0 },
      uStrength: { value: isCrater ? 0.92 : 0.42 },
      uSeed: { value: i * 4.3 + 1.2 },
      uIsCrater: { value: isCrater ? 1.0 : 0.0 }
    };
    const haloMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: haloUniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${NOISE_GLSL}
        uniform float uTime;
        uniform float uStrength;
        uniform float uSeed;
        uniform float uIsCrater;
        varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float r = length(p);
          if (r > 1.0) discard;
          float n = fbm2(p * (uIsCrater > 0.5 ? 3.8 : 2.6) + vec2(uSeed, -uTime * 0.10));
          float radialVein = fbm2(vec2(atan(p.y, p.x) * 3.0 + uSeed, r * 4.2 - uTime * 0.08));
          float outerMask = smoothstep(0.96, 0.18, r + (n - 0.5) * 0.52);
          float craterRim = uIsCrater > 0.5
            ? smoothstep(0.24, 0.52, r + (n - 0.5) * 0.20) * (1.0 - smoothstep(0.68, 0.96, r + (radialVein - 0.5) * 0.24))
            : 0.0;
          float mask = max(outerMask * (uIsCrater > 0.5 ? 0.55 : 1.0), craterRim * 1.15);
          float spark = pow(vnoise2(p * (uIsCrater > 0.5 ? 28.0 : 18.0) + uSeed) * vnoise2(p.yx * (uIsCrater > 0.5 ? 40.0 : 26.0) - uSeed), 5.0);
          float twinkle = 0.58 + 0.42 * sin(uTime * 3.8 + n * 16.0);
          vec3 cinnamon = mix(vec3(0.48, 0.17, 0.05), vec3(0.68, 0.25, 0.07), radialVein);
          vec3 sparkAmber = vec3(1.15, 0.56, 0.16) * spark * twinkle * 2.8;
          vec3 sparkIbad = vec3(0.32, 0.74, 1.38) * spark * twinkle * (uIsCrater > 0.5 ? 5.6 : 0.75);
          vec3 col = cinnamon + sparkAmber + sparkIbad;
          float alpha = mask * (0.44 + craterRim * 0.26 + spark * 0.55) * uStrength;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(col, clamp(alpha, 0.0, uIsCrater > 0.5 ? 0.78 : 0.56));
        }
      `
    });

    let haloGeo;
    if (isCrater) {
      haloGeo = new THREE.PlaneGeometry(16.4, 16.4, 30, 30);
      haloGeo.rotateX(-Math.PI * 0.5);
      const hp = haloGeo.attributes.position;
      for (let vi = 0; vi < hp.count; vi++) {
        const hx = hp.getX(vi);
        const hz = hp.getZ(vi);
        hp.setY(vi, getGroundHeight(def.x + hx, def.z + hz) - gy + 0.045);
      }
      haloGeo.computeVertexNormals();
    } else {
      haloGeo = new THREE.PlaneGeometry(2.3, 2.3);
      haloGeo.rotateX(-Math.PI * 0.5);
      haloGeo.translate(0, 0.02, 0);
    }
    const halo = new THREE.Mesh(haloGeo, haloMat);
    g.add(halo);

    root.add(g);

    const nodeState = {
      def,
      isCrater,
      group: g,
      cluster,
      mat,
      halo,
      haloUniforms,
      harvested: false,
      regenTimer: 0
    };
    nodes.push(nodeState);

    interactables.push({
      id: def.id,
      type: 'spice',
      landmarkId: def.landmarkId,
      position: new THREE.Vector3(def.x, gy + 0.35, def.z),
      radius: isCrater ? 7.5 : 3.4,
      isAvailable: () => !nodeState.harvested,
      prompt: `[E] Harvest ${def.name}`,
      onInteract: (state, hooks) => {
        if (nodeState.harvested) return;
        nodeState.harvested = true;
        nodeState.regenTimer = 60.0;
        state.player.spiceCollected += 1;
        state.player.spiceTrance = Math.min(1.0, state.player.spiceTrance + 0.92);
        if (def.landmarkId) state.markDiscovered(def.landmarkId);
        hooks?.onSpiceHarvest?.(def.x, gy + 0.3, def.z);
        state.pushToast(
          `MÉLANGE HARVESTED · ${state.player.spiceCollected} POUCH${state.player.spiceCollected === 1 ? '' : 'ES'}`,
          def.name,
          'Cinnamon-ozone clarity sharpens the horizon — blue-within-blue prescience stirs.'
        );
      }
    });
  }

  function update(dt, state) {
    const t = state.elapsed;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      n.haloUniforms.uTime.value = t;
      if (n.harvested) {
        n.regenTimer -= dt;
        n.cluster.scale.lerp(_harvestScale, Math.min(1, dt * 6));
        n.haloUniforms.uStrength.value = Math.max(0, n.haloUniforms.uStrength.value - dt * 1.2);
        if (n.regenTimer <= 0) n.harvested = false;
      } else {
        n.cluster.scale.lerp(_unitScale, Math.min(1, dt * 2.5));
        const pulse = 0.55 + 0.45 * Math.sin(t * 2.4 + i * 1.7);
        if (n.isCrater) {
          n.mat.emissiveIntensity = 0.24 + pulse * 0.26 + state.spiceBlow.intensity * 0.42;
          n.haloUniforms.uStrength.value = 0.85 + pulse * 0.15 + state.spiceBlow.intensity * 0.18;
        } else {
          n.mat.emissiveIntensity = 0.07 + pulse * 0.12 + state.spiceBlow.intensity * 0.28;
          n.haloUniforms.uStrength.value = 0.46 + pulse * 0.14;
        }
      }
    }
  }

  return { group: root, update };
}

// ============================================================================
// 5. LIVING ARRAKIS MICRO-FAUNA & PATROLLING DISTANT ORNITHOPTER
// ============================================================================

function buildLivingMicroWorld() {
  const root = new THREE.Group();
  root.name = 'ArrakisLivingMicroWorld';

  // --- A) High-Altitude Patrolling Imperial Ornithopter ---
  const thopter = new THREE.Group();
  thopter.name = 'PatrollingOrnithopter';
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3b3530, roughness: 0.38, metalness: 0.78 });
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.28, 2.2, 6), bodyMat);
  body.rotation.x = Math.PI * 0.5;
  thopter.add(body);

  const wingMat = new THREE.MeshStandardMaterial({
    color: 0x7e7262,
    roughness: 0.35,
    metalness: 0.65,
    side: THREE.DoubleSide
  });
  const thopterWings = [];
  for (const side of [-1, 1]) {
    for (const zOff of [0.22, -0.22]) {
      const piv = new THREE.Group();
      piv.position.set(side * 0.18, 0.12, zOff);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.03, 0.24), wingMat);
      blade.position.x = side * 1.18;
      piv.add(blade);
      thopter.add(piv);
      thopterWings.push({ piv, side, phase: zOff > 0 ? 0 : 1.1 });
    }
  }
  thopter.scale.setScalar(1.35);
  root.add(thopter);

  // --- B) Delicate Nocturnal Bioluminescent Spores / Moths Strictly Over Cistern Water & Reeds ---
  const MOTH_COUNT = 84;
  const mothPos = new Float32Array(MOTH_COUNT * 3);
  const mothCol = new Float32Array(MOTH_COUNT * 3);
  const mothSeeds = [];
  const rand = mulberry32(8842);
  const cBlue = new THREE.Color(0x52c8ff);
  const cGold = new THREE.Color(0xffc966);
  const cViolet = new THREE.Color(0xb478ff);
  const tmpC = new THREE.Color();

  for (let i = 0; i < MOTH_COUNT; i++) {
    const a = rand() * Math.PI * 2;
    const r = 1.5 + rand() * 4.3; // Constrained tightly to r = 1.5..5.8m cistern & reed margin!
    const bx = CISTERN_CENTER.x + Math.cos(a) * r;
    const bz = CISTERN_CENTER.z + Math.sin(a) * r;
    const by = WATER_LEVEL + 0.18 + rand() * 0.77; // Low over water & reeds (0.18..0.95m), never in sky or camp!
    mothSeeds.push({ bx, by, bz, sp: 0.55 + rand() * 0.95, ph: rand() * Math.PI * 2, rad: 0.18 + rand() * 0.36 });
    mothPos[i * 3] = bx;
    mothPos[i * 3 + 1] = by;
    mothPos[i * 3 + 2] = bz;

    const pick = rand();
    tmpC.copy(pick < 0.55 ? cBlue : pick < 0.82 ? cGold : cViolet);
    mothCol[i * 3] = tmpC.r;
    mothCol[i * 3 + 1] = tmpC.g;
    mothCol[i * 3 + 2] = tmpC.b;
  }

  const mothGeo = new THREE.BufferGeometry();
  mothGeo.setAttribute('position', new THREE.BufferAttribute(mothPos, 3));
  mothGeo.setAttribute('color', new THREE.BufferAttribute(mothCol, 3));
  const mothMat = new THREE.PointsMaterial({
    size: 0.055,
    map: getSoftGlowTexture(),
    vertexColors: true,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const mothPoints = new THREE.Points(mothGeo, mothMat);
  mothPoints.frustumCulled = false;
  root.add(mothPoints);

  // --- C) 10 Iridescent Desert Scarab Beetles scuttling over sand ripples ---
  const SCARAB_COUNT = 10;
  const scarabGeo = new THREE.SphereGeometry(0.042, 10, 8);
  scarabGeo.scale(0.75, 0.52, 1.25);
  const scarabMat = new THREE.MeshPhysicalMaterial({
    color: 0x263248,
    roughness: 0.16,
    metalness: 0.85,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08
  });
  const scarabIM = new THREE.InstancedMesh(scarabGeo, scarabMat, SCARAB_COUNT);
  scarabIM.castShadow = true;
  const scarabs = [];
  for (let i = 0; i < SCARAB_COUNT; i++) {
    const a = (i / SCARAB_COUNT) * Math.PI * 2 + 0.3;
    const r = 7.4 + rand() * 5.2;
    scarabs.push({
      cx: CISTERN_CENTER.x + Math.cos(a) * r,
      cz: CISTERN_CENTER.z + Math.sin(a) * r,
      radius: 0.7 + rand() * 1.1,
      speed: 0.35 + rand() * 0.45,
      phase: rand() * Math.PI * 2
    });
  }
  root.add(scarabIM);

  const dummy = new THREE.Object3D();

  function update(_dt, state) {
    const t = state.elapsed;
    const stormHide = state.weatherWeights.coriolisStorm;

    // 1. Patrolling Ornithopter high across the northern Erg
    const thopterVis = state.sunDir.y > -0.02 && stormHide < 0.7;
    thopter.visible = thopterVis;
    if (thopterVis) {
      const a = t * 0.055 + 0.85;
      const px = Math.sin(a) * 115.0 + 18.0;
      const pz = -135.0 - Math.cos(a * 0.7) * 42.0;
      const py = 46.0 + Math.sin(a * 1.8) * 6.0;
      const vx = Math.cos(a) * 115.0 * 0.055;
      const vz = Math.sin(a * 0.7) * 42.0 * 0.055 * 0.7;
      thopter.position.set(px, py, pz);
      thopter.rotation.set(0.04 * Math.cos(a * 2), Math.atan2(vx, vz), -0.18 * Math.cos(a));
      for (let i = 0; i < thopterWings.length; i++) {
        const w = thopterWings[i];
        w.piv.rotation.z = w.side * Math.sin(t * 28.0 + w.phase) * 0.28;
      }
    }

    // 2. Nocturnal bioluminescent moths/spores (strictly deep night over cistern water, hidden at dusk!)
    const nightVis = (1.0 - smoothstep(-0.26, -0.13, state.sunDir.y)) * (1.0 - stormHide * 0.85);
    mothPoints.visible = nightVis > 0.02;
    if (mothPoints.visible) {
      mothMat.opacity = nightVis * 0.68;
      const arr = mothGeo.attributes.position.array;
      for (let i = 0; i < MOTH_COUNT; i++) {
        const s = mothSeeds[i];
        arr[i * 3] = s.bx + Math.sin(t * s.sp + s.ph) * s.rad;
        arr[i * 3 + 1] = s.by + Math.sin(t * s.sp * 1.4 + s.ph) * 0.14;
        arr[i * 3 + 2] = s.bz + Math.cos(t * s.sp * 0.9 + s.ph) * s.rad;
      }
      mothGeo.attributes.position.needsUpdate = true;
    }

    // 3. Desert scarabs scuttling on sunlit sand
    const scarabVis = state.sunDir.y > -0.05 && stormHide < 0.5;
    scarabIM.visible = scarabVis;
    if (scarabVis) {
      for (let i = 0; i < SCARAB_COUNT; i++) {
        const sc = scarabs[i];
        // Intermittent scuttle-pause rhythm
        const rawT = t * sc.speed + sc.phase;
        const stepPhase = rawT + Math.sin(rawT * 3.0) * 0.22;
        const sx = sc.cx + Math.cos(stepPhase) * sc.radius;
        const sz = sc.cz + Math.sin(stepPhase * 1.2) * sc.radius * 0.85;
        const sy = getGroundHeight(sx, sz);
        if (sy <= WATER_LEVEL + 0.05) {
          dummy.scale.setScalar(0.0001);
        } else {
          const vx = -Math.sin(stepPhase) * sc.radius;
          const vz = Math.cos(stepPhase * 1.2) * sc.radius * 0.85 * 1.2;
          dummy.position.set(sx, sy + 0.024, sz);
          dummy.rotation.set(0, Math.atan2(vx, vz), 0);
          dummy.scale.setScalar(1.0);
        }
        dummy.updateMatrix();
        scarabIM.setMatrixAt(i, dummy.matrix);
      }
      scarabIM.instanceMatrix.needsUpdate = true;
    }
  }

  return { group: root, update };
}

export function createLandmarksSystem(scene, worldState) {
  const group = new THREE.Group();
  group.name = 'ArrakisLandmarksSystem';

  const colliders = [
    // Windtrap Spire foundation plinth collider
    { x: -21.0, z: -25.0, r: 4.9 }
  ];
  const interactables = [
    {
      id: 'cistern_drink',
      type: 'water',
      landmarkId: 'cistern',
      position: new THREE.Vector3(CISTERN_CENTER.x, WATER_LEVEL + 0.15, CISTERN_CENTER.z + 5.2),
      radius: 4.5,
      prompt: '[E] Drink & Refill Stillsuit Catchpocket',
      onInteract: (state, hooks) => {
        state.player.hydration = 1.0;
        state.markDiscovered('cistern');
        hooks?.onWaterDrink?.(state.player.feetPosition.x, state.player.feetPosition.z);
        state.pushToast('WATER DISCIPLINE', 'Stillsuit Catchpocket Full', 'Cool qanat spring water restores hydration to 100%.');
      }
    },
    {
      id: 'windtrap_inspect',
      type: 'inspect',
      landmarkId: 'windtrap',
      position: new THREE.Vector3(-21.0, getGroundHeight(-21.0, -25.0) + 1.5, -25.0),
      radius: 7.4,
      prompt: '[E] Inspect Fremen Badgir Windtrap',
      onInteract: (state) => {
        state.markDiscovered('windtrap');
        state.pushToast('MOISTURE HARVEST', 'Fremen Badgir Windtrap', 'Internal cooling precipitators channel 40 liters of desert dew per night down to the cistern.');
      }
    },
    {
      id: 'yardang_arch',
      type: 'inspect',
      landmarkId: 'arch',
      position: new THREE.Vector3(-24.5, getGroundHeight(-24.5, -1.5) + 1.4, -1.5),
      radius: 6.5,
      prompt: '[E] Inspect Carved Sandstone Wind Arch',
      onInteract: (state) => {
        state.markDiscovered('arch');
        state.pushToast('EOLIAN CARVING', 'Sandstone Wind Arch', 'Ancient Fremen wind-marks etched beneath the span point true north toward the Great Erg.');
      }
    },
    {
      id: 'muaddib_feed',
      type: 'fauna',
      landmarkId: 'muaddib',
      position: new THREE.Vector3(3.16, getGroundHeight(3.16, 8.92) + 0.25, 8.92),
      radius: 3.1,
      prompt: "[E] Offer Dew-Seed to Muad'Dib",
      onInteract: (state, hooks) => {
        state.player.muadDibFed = true;
        state.markDiscovered('muaddib');
        hooks?.onFeedMuadDib?.();
        state.pushToast('DESERT KINSHIP', "Muad'Dib Accepts Seed", 'The desert mouse twitches its translucent ears and hops closer, unafraid.');
      }
    }
  ];

  const camp = buildFremenCamp(worldState, colliders, interactables);
  const ornithopter = buildDownedOrnithopter(colliders, interactables);
  const lanterns = buildLanternsAndHarps(colliders);
  const spiceNodes = buildSpiceNodes(interactables);
  const microWorld = buildLivingMicroWorld();

  group.add(camp.group);
  group.add(ornithopter.group);
  group.add(lanterns.group);
  group.add(spiceNodes.group);
  group.add(microWorld.group);

  if (scene) scene.add(group);

  function update(dt, camera = null) {
    if (!worldState) return;
    camp.update(dt, worldState, camera);
    ornithopter.update(dt, worldState, camera);
    lanterns.update(dt, worldState, camera);
    spiceNodes.update(dt, worldState);
    microWorld.update(dt, worldState);
  }

  return {
    group,
    colliders,
    interactables,
    brazierPos: camp.brazierPos,
    update
  };
}
