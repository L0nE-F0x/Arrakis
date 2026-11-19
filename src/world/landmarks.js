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

  const camp = new THREE.Group();
  camp.name = 'YardangSanctuaryCamp';
  camp.position.set(cx, cy, cz);
  camp.rotation.y = 0.42;

  // Shared wind uniforms for billowing fabric canopy & banners
  const clothUniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindSpeed: { value: 0.45 }
  };

  // --- Canopy Posts (4 tilted composite desert-wood/brass poles) ---
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
    const pole = new THREE.CylinderGeometry(0.042, 0.058, h + 0.5, 8);
    pole.translate(0, (h - 0.5) * 0.5, 0);
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
  const pennantPole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.036, 3.35, 8),
    new THREE.MeshStandardMaterial({ color: 0x6b4728, roughness: 0.78 })
  );
  pennantPole.position.set(2.45, 1.45, 1.45);
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
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xb68142,
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
    const legGeo = new THREE.CylinderGeometry(0.028, 0.036, 0.56, 7);
    legGeo.rotateZ(0.22);
    legGeo.rotateY(a);
    legGeo.translate(Math.cos(a) * 0.32, 0.24, Math.sin(a) * 0.32);
    brazierParts.push(colorize(legGeo, 0x4b3526, 0.04));
  }
  const brazierMesh = new THREE.Mesh(mergeGeometries(brazierParts, false), brassMat);
  brazierMesh.position.set(brazierX, -0.05, brazierZ);
  brazierMesh.castShadow = true;
  brazierMesh.receiveShadow = true;
  camp.add(brazierMesh);

  // Glowing ember bed inside brazier
  const coalMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 14, 10),
    new THREE.MeshStandardMaterial({
      color: 0x2a1208,
      emissive: new THREE.Color(0xff5212),
      emissiveIntensity: 2.2,
      roughness: 0.85
    })
  );
  coalMesh.scale.set(1.0, 0.35, 1.0);
  coalMesh.position.set(brazierX, 0.46, brazierZ);
  camp.add(coalMesh);

  // Volumetric shader flame tongue
  const flameUniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindSpeed: { value: 0.45 }
  };
  const flameGeo = new THREE.ConeGeometry(0.28, 0.92, 16, 12, true);
  flameGeo.translate(0, 0.46, 0);
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
      void main() {
        vUv = uv;
        vec3 p = position;
        float h = uv.y;
        p.x += sin(uTime * 11.0 + h * 6.0) * 0.06 * h + uWindSpeed * 0.14 * h * h;
        p.z += cos(uTime * 9.5 + h * 5.0) * 0.05 * h;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        float h = vUv.y;
        float n = fbm2(vec2(vUv.x * 4.5, h * 4.2 - uTime * 4.8));
        float shape = (1.0 - smoothstep(0.05, 0.98, h)) * smoothstep(0.0, 0.16, h);
        float mask = smoothstep(0.28, 0.72, n + (1.0 - h) * 0.42) * shape;
        if (mask < 0.02) discard;
        vec3 col = mix(vec3(1.0, 0.24, 0.04), vec3(1.0, 0.78, 0.28), smoothstep(0.2, 0.85, (1.0 - h) * n * 1.45));
        gl_FragColor = vec4(col * 1.65, mask * 0.85);
      }
    `
  });
  const flameMesh = new THREE.Mesh(flameGeo, flameMat);
  flameMesh.position.set(brazierX, 0.45, brazierZ);
  camp.add(flameMesh);

  // Live flickering fire PointLight (stronger at dusk/night, cozy glow in daylight)
  const fireLight = new THREE.PointLight(0xff8a38, 6.0, 22.0, 1.7);
  fireLight.position.set(brazierX, 1.12, brazierZ);
  camp.add(fireLight);

  // Rising glowing ember sparks from brazier
  const EMBER_COUNT = 26;
  const emberPos = new Float32Array(EMBER_COUNT * 3);
  const emberSeed = new Float32Array(EMBER_COUNT);
  for (let i = 0; i < EMBER_COUNT; i++) {
    emberSeed[i] = Math.random();
    emberPos[i * 3] = brazierX;
    emberPos[i * 3 + 1] = 0.55;
    emberPos[i * 3 + 2] = brazierZ;
  }
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute('position', new THREE.BufferAttribute(emberPos, 3));
  const emberMat = new THREE.PointsMaterial({
    color: 0xffb24c,
    map: getSoftGlowTexture(),
    size: 0.13,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const emberPoints = new THREE.Points(emberGeo, emberMat);
  camp.add(emberPoints);

  // --- Clay Water Amphorae, Sealed Fremkit Chest & Desert Rug ---
  const propsParts = [];
  const amphoraProfile = [
    new THREE.Vector2(0.01, 0.0),
    new THREE.Vector2(0.14, 0.02),
    new THREE.Vector2(0.24, 0.28),
    new THREE.Vector2(0.20, 0.52),
    new THREE.Vector2(0.09, 0.68),
    new THREE.Vector2(0.13, 0.78),
    new THREE.Vector2(0.08, 0.79)
  ];
  for (const [ax, az, sc, tilt] of [[-1.35, -0.75, 1.05, 0.05], [-0.92, -0.95, 0.82, -0.06], [1.32, -0.68, 0.92, 0.03]]) {
    const jar = new THREE.LatheGeometry(amphoraProfile, 16);
    jar.scale(sc, sc, sc);
    jar.rotateZ(tilt);
    jar.translate(ax, -0.04, az);
    propsParts.push(colorize(jar, 0x9c5534, 0.08));
  }

  // Sealed Fremkit Supply Chest
  const chest = new THREE.BoxGeometry(0.92, 0.44, 0.54);
  chest.rotateY(-0.28);
  chest.translate(1.15, 0.19, 0.65);
  propsParts.push(colorize(chest, 0x4b3b2d, 0.06));

  const chestLid = new THREE.BoxGeometry(0.96, 0.08, 0.58);
  chestLid.rotateY(-0.28);
  chestLid.translate(1.15, 0.44, 0.65);
  propsParts.push(colorize(chestLid, 0x7b5d3e, 0.06));

  // Woven Fremen seating carpet beneath canopy
  const rug = new THREE.BoxGeometry(2.6, 0.035, 1.85);
  rug.translate(-0.15, 0.01, -0.52);
  propsParts.push(colorize(rug, 0x6b281c, 0.09));

  const propsMesh = new THREE.Mesh(
    mergeGeometries(propsParts, false),
    new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.82, metalness: 0.08 })
  );
  propsMesh.castShadow = true;
  propsMesh.receiveShadow = true;
  camp.add(propsMesh);

  // Register brazier collider & interactable
  const worldBrazier = new THREE.Vector3(brazierX, 0.6, brazierZ).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.42).add(new THREE.Vector3(cx, cy, cz));
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
      state.pushToast('SIETCH SANCTUARY', 'Fremen Desert Bivouac', 'Spiced creosote smoke drifts under the sandstone arch — shelter from Coriolis gusts.');
    }
  });

  function update(dt, state) {
    const t = state.elapsed;
    clothUniforms.uTime.value = t;
    clothUniforms.uWindDir.value.copy(state.windDir);
    clothUniforms.uWindSpeed.value = state.windSpeed;
    flameUniforms.uTime.value = t;
    flameUniforms.uWindSpeed.value = state.windSpeed;

    const nightFactor = 1.0 - smoothstep(-0.08, 0.20, state.sunDir.y);
    const flicker = 0.84 + 0.16 * Math.sin(t * 15.3) + 0.09 * Math.cos(t * 27.1);
    fireLight.intensity = (2.8 + nightFactor * 9.5 + state.eclipseStrength * 7.0) * flicker;
    coalMesh.material.emissiveIntensity = (1.6 + nightFactor * 1.8) * flicker;

    // Animate rising ember sparks
    const pos = emberGeo.attributes.position.array;
    for (let i = 0; i < EMBER_COUNT; i++) {
      const life = (t * (0.48 + emberSeed[i] * 0.45) + emberSeed[i] * 7.0) % 1.0;
      const ang = emberSeed[i] * Math.PI * 2 + t * 1.4;
      const drift = life * (0.18 + state.windSpeed * 0.45);
      pos[i * 3] = brazierX + Math.cos(ang) * 0.16 * (1.0 - life * 0.4) + state.windDir.x * drift;
      pos[i * 3 + 1] = 0.54 + life * 1.75;
      pos[i * 3 + 2] = brazierZ + Math.sin(ang) * 0.16 * (1.0 - life * 0.4) + state.windDir.y * drift;
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

  const wreck = new THREE.Group();
  wreck.name = 'DownedOrnithopterWreck';
  wreck.position.set(ox, oy + 0.36, oz);
  wreck.rotation.set(0.14, -2.28, -0.26); // Dramatic canted impact pose half-claimed by dune sand

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

  // Split V-tail stabilizer fins + twin jet-turbine pods + landing skids
  for (const side of [-1, 1]) {
    const fin = new THREE.BoxGeometry(1.85, 0.075, 0.85);
    fin.rotateZ(side * 0.48);
    fin.rotateY(side * -0.18);
    fin.translate(side * 0.92, 0.68, -6.95);
    hullParts.push(colorize(fin, 0x52483c, 0.06));

    // Side jet-turbine nacelle + brass exhaust nozzle
    const pod = new THREE.CylinderGeometry(0.34, 0.45, 2.55, 10);
    pod.rotateX(Math.PI * 0.5);
    pod.translate(side * 1.56, -0.06, -1.05);
    hullParts.push(colorize(pod, 0x453d34, 0.05));

    const nozzle = new THREE.CylinderGeometry(0.26, 0.34, 0.42, 10);
    nozzle.rotateX(Math.PI * 0.5);
    nozzle.translate(side * 1.56, -0.06, -2.42);
    hullParts.push(colorize(nozzle, 0x9c723e, 0.05));

    // Bent landing strut & skid
    const strut = new THREE.CylinderGeometry(0.065, 0.075, 1.25, 7);
    strut.rotateZ(side * 0.35);
    strut.translate(side * 1.15, -1.02, 0.45);
    hullParts.push(colorize(strut, 0x3b352f, 0.05));

    const skid = new THREE.BoxGeometry(0.18, 0.09, 3.2);
    skid.translate(side * 1.48, -1.52, 0.65);
    hullParts.push(colorize(skid, 0x4a4239, 0.05));
  }

  // Dorsal brass wing-hinge mechanical housing & cockpit mullion frame
  const spine = new THREE.BoxGeometry(1.04, 0.62, 3.4);
  spine.translate(0, 0.94, -0.35);
  hullParts.push(colorize(spine, 0x987444, 0.06));

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

  // Gleaming fractured obsidian-amber cockpit glass canopy (catches PMREM sky reflection!)
  const glassGeo = new THREE.SphereGeometry(1.08, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.56);
  glassGeo.scale(0.88, 0.68, 1.88);
  glassGeo.translate(0, 0.48, 1.48);
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x1c2a36,
    roughness: 0.12,
    metalness: 0.28,
    reflectivity: 1.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06
  });
  const glassMesh = new THREE.Mesh(glassGeo, glassMat);
  glassMesh.castShadow = true;
  wreck.add(glassMesh);

  // Articulated Tapered Dragonfly Wings (carbon-titanium leading spar + cross-ribs + translucent golden-smoke membrane!)
  const membraneMat = new THREE.MeshPhysicalMaterial({
    color: 0x6e5a42,
    roughness: 0.38,
    metalness: 0.35,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide
  });

  function makeWing(length, width, broken = false) {
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

    return wGroup;
  }

  const wingConfigs = [
    { side: 1, z: 0.72, len: 6.8, wid: 0.88, rz: 0.58, ry: -0.20, broken: false },
    { side: 1, z: -0.68, len: 6.2, wid: 0.78, rz: 0.36, ry: -0.44, broken: false },
    { side: -1, z: 0.72, len: 5.8, wid: 0.84, rz: -0.28, ry: 0.28, broken: true },
    { side: -1, z: -0.68, len: 5.2, wid: 0.74, rz: -0.18, ry: 0.48, broken: true }
  ];
  const windWings = [];
  for (const wc of wingConfigs) {
    const w = makeWing(wc.len, wc.wid, wc.broken);
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
  wreck.add(beaconLight);

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

  function update(_dt, state) {
    const t = state.elapsed;
    // Double-pulse distress beacon rhythm
    const cycle = t % 2.4;
    const pulse =
      Math.exp(-Math.pow((cycle - 0.18) / 0.07, 2)) +
      Math.exp(-Math.pow((cycle - 0.42) / 0.08, 2)) * 0.72;
    beaconMat.emissiveIntensity = 0.25 + pulse * 5.2;
    beaconLight.intensity = pulse * 10.5;

    // Subtle wind shudder on intact skyward wings
    for (let i = 0; i < windWings.length; i++) {
      const ww = windWings[i];
      ww.obj.rotation.z =
        ww.baseRz + Math.sin(t * (2.6 + i * 0.7) + i) * 0.014 * (0.4 + state.windSpeed * 0.9);
    }
  }

  return { group: wreck, update };
}

// ============================================================================
// 3. FREMEN QANAT TRAIL LANTERNS & DEW-COLLECTOR WIND HARPS
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

  const lanternLights = [];

  for (let i = 0; i < lanternPositions.length; i++) {
    const lp = lanternPositions[i];
    const gy = getGroundHeight(lp.x, lp.z);
    const g = new THREE.Group();
    g.position.set(lp.x, gy - 0.06, lp.z);

    // Carved tapered basalt pedestal
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.12, 1.38, 6), basaltMat);
    post.position.y = 0.69;
    post.castShadow = true;
    post.receiveShadow = true;
    g.add(post);

    // Pierced brass lantern crown
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.24, 6), brassMat);
    cap.position.y = 1.66;
    cap.castShadow = true;
    g.add(cap);

    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.10, 0.06, 6), brassMat);
    rim.position.y = 1.38;
    g.add(rim);

    // Warm flame/glowglobe bulb inside
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.095, 1), flameCoreMat);
    core.position.y = 1.50;
    g.add(core);

    // Real PointLights on alternate key lanterns so dusk/night trail pools with warm amber glow
    if (i === 0 || i === 2 || i === 4) {
      const pt = new THREE.PointLight(0xff9b48, 0, 14.0, 1.8);
      pt.position.set(0, 1.56, 0);
      g.add(pt);
      lanternLights.push({ light: pt, phase: i * 2.1 });
    }

    root.add(g);
    colliders.push({ x: lp.x, z: lp.z, r: 0.32 });
  }

  // Dew-Collector Wind Harps along rocky canyon shoulders
  const harpCoords = [
    { x: 11.6, z: 2.2, yaw: -0.4 },
    { x: 12.2, z: -5.2, yaw: -0.7 },
    { x: 10.8, z: -12.4, yaw: -0.2 },
    { x: -11.4, z: 15.2, yaw: 0.6 }
  ];
  const harpParts = [];
  for (const hc of harpCoords) {
    const gy = getGroundHeight(hc.x, hc.z);
    const frameL = new THREE.CylinderGeometry(0.025, 0.035, 3.1, 6);
    frameL.rotateZ(0.10);
    frameL.translate(-0.42, 1.48, 0);
    const frameR = new THREE.CylinderGeometry(0.025, 0.035, 3.1, 6);
    frameR.rotateZ(-0.10);
    frameR.translate(0.42, 1.48, 0);
    const barTop = new THREE.CylinderGeometry(0.022, 0.022, 0.62, 6);
    barTop.rotateZ(Math.PI * 0.5);
    barTop.translate(0, 2.95, 0);

    const meshGroup = new THREE.Group();
    meshGroup.position.set(hc.x, gy - 0.1, hc.z);
    meshGroup.rotation.y = hc.yaw;
    const frameMesh = new THREE.Mesh(
      mergeGeometries([colorize(frameL, 0x8e6b40), colorize(frameR, 0x8e6b40), colorize(barTop, 0xb88c52)], false),
      brassMat
    );
    frameMesh.castShadow = true;
    meshGroup.add(frameMesh);

    // Translucent fine condensation mesh screen catching dawn glint
    const net = new THREE.Mesh(
      new THREE.PlaneGeometry(0.68, 2.35),
      new THREE.MeshPhysicalMaterial({
        color: 0xdbe6ef,
        roughness: 0.25,
        metalness: 0.35,
        transparent: true,
        opacity: 0.26,
        side: THREE.DoubleSide
      })
    );
    net.position.y = 1.65;
    meshGroup.add(net);
    root.add(meshGroup);
  }

  function update(_dt, state) {
    const t = state.elapsed;
    const nightAmt = Math.max(1.0 - smoothstep(-0.08, 0.16, state.sunDir.y), state.eclipseStrength * 0.85);
    flameCoreMat.emissiveIntensity = 0.08 + nightAmt * 2.85;
    for (let i = 0; i < lanternLights.length; i++) {
      const l = lanternLights[i];
      const flk = 0.90 + 0.10 * Math.sin(t * 11.4 + l.phase);
      l.light.intensity = nightAmt * 6.2 * flk;
    }
  }

  return { group: root, update };
}

// ============================================================================
// 4. HARVESTABLE MÉLANGE SPICE SEAMS
// ============================================================================

function buildSpiceNodes(interactables) {
  const root = new THREE.Group();
  root.name = 'MelangeSpiceNodes';

  const nodeDefs = [
    { id: 'spice_ridge', x: 8.8, z: -31.5, name: 'Erg Margin Spice Seam', landmarkId: null },
    { id: 'spice_east', x: 15.2, z: -45.5, name: 'Leeward Slipface Mélange', landmarkId: null },
    { id: 'spice_wreck', x: 22.0, z: -50.8, name: 'Scattered Cargo Mélange', landmarkId: 'ornithopter' },
    { id: 'spice_mid', x: -14.5, z: -51.5, name: 'Deep Trough Cinnamon Vein', landmarkId: null },
    { id: 'spice_crater', x: -21.0, z: -68.0, name: 'Pre-Spice Blow Core', landmarkId: 'spice' }
  ];

  const nodes = [];
  const crystalGeo = new THREE.OctahedronGeometry(0.18, 0);
  crystalGeo.scale(1.0, 0.35, 1.0);

  for (let i = 0; i < nodeDefs.length; i++) {
    const def = nodeDefs[i];
    const gy = getGroundHeight(def.x, def.z);
    const gNorm = getGroundNormal(def.x, def.z, new THREE.Vector3());

    const g = new THREE.Group();
    g.position.set(def.x, gy + 0.03, def.z);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), gNorm);

    // Natural wind-feathered cinnamon-ochre spice deposit with delicate sparkling blue-gold glints (zero flat ring!)
    const mat = new THREE.MeshStandardMaterial({
      color: 0x8e3814,
      emissive: new THREE.Color(0x2e64b8),
      emissiveIntensity: 0.22,
      roughness: 0.55,
      metalness: 0.18
    });

    const cluster = new THREE.Group();
    for (let k = 0; k < 9; k++) {
      const m = new THREE.Mesh(crystalGeo, mat);
      const a = (k / 9) * Math.PI * 2 + i * 1.3;
      const r = k === 0 ? 0.05 : 0.22 + (k % 3) * 0.26;
      m.position.set(Math.cos(a) * r, -0.015, Math.sin(a) * r);
      m.rotation.set((k % 2) * 0.18, a, 0.10);
      m.scale.setScalar(k === 0 ? 1.15 : 0.45 + (k % 3) * 0.18);
      cluster.add(m);
    }
    g.add(cluster);

    // Organic feathered wind-drifted spice stain & subtle atmospheric shimmer (zero hard disc edge!)
    const haloUniforms = {
      uTime: { value: 0 },
      uStrength: { value: 0.4 },
      uSeed: { value: i * 4.3 + 1.2 }
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
        varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float r = length(p);
          if (r > 1.0) discard;
          float n = fbm2(p * 2.6 + vec2(uSeed, -uTime * 0.12));
          float mask = smoothstep(0.95, 0.15, r + (n - 0.5) * 0.55);
          float spark = pow(vnoise2(p * 18.0 + uSeed) * vnoise2(p.yx * 26.0 - uSeed), 5.0);
          float twinkle = 0.55 + 0.45 * sin(uTime * 4.2 + n * 18.0);
          vec3 cinnamon = vec3(0.56, 0.20, 0.06);
          vec3 sparkBlue = vec3(0.35, 0.78, 1.35) * spark * twinkle * 5.2;
          vec3 col = cinnamon + sparkBlue;
          float alpha = mask * (0.48 + spark * 0.65) * uStrength;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.72));
        }
      `
    });
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), haloMat);
    halo.rotation.x = -Math.PI * 0.5;
    halo.position.y = 0.025;
    g.add(halo);

    root.add(g);

    const nodeState = {
      def,
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
      radius: 3.4,
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
        n.cluster.scale.lerp(new THREE.Vector3(0.25, 0.25, 0.25), Math.min(1, dt * 6));
        n.haloUniforms.uStrength.value = Math.max(0, n.haloUniforms.uStrength.value - dt * 1.2);
        if (n.regenTimer <= 0) n.harvested = false;
      } else {
        n.cluster.scale.lerp(new THREE.Vector3(1, 1, 1), Math.min(1, dt * 2.5));
        const pulse = 0.55 + 0.45 * Math.sin(t * 2.4 + i * 1.7);
        n.mat.emissiveIntensity = 0.18 + pulse * 0.35 + state.spiceBlow.intensity * 0.45;
        n.haloUniforms.uStrength.value = 0.78 + pulse * 0.22;
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

  // --- B) 120 Nocturnal Bioluminescent Desert Moths / Spores over Cistern & Blooms ---
  const MOTH_COUNT = 120;
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
    const r = 1.6 + rand() * 11.5;
    const bx = CISTERN_CENTER.x + Math.cos(a) * r;
    const bz = CISTERN_CENTER.z + Math.sin(a) * r;
    const by = Math.max(WATER_LEVEL + 0.22, getGroundHeight(bx, bz) + 0.35) + rand() * 2.4;
    mothSeeds.push({ bx, by, bz, sp: 0.6 + rand() * 1.1, ph: rand() * Math.PI * 2, rad: 0.35 + rand() * 0.75 });
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
    size: 0.16,
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

    // 2. Nocturnal bioluminescent moths/spores
    const nightVis = (1.0 - smoothstep(-0.08, 0.10, state.sunDir.y)) * (1.0 - stormHide * 0.85);
    mothPoints.visible = nightVis > 0.02;
    if (mothPoints.visible) {
      mothMat.opacity = nightVis * 0.82;
      const arr = mothGeo.attributes.position.array;
      for (let i = 0; i < MOTH_COUNT; i++) {
        const s = mothSeeds[i];
        arr[i * 3] = s.bx + Math.sin(t * s.sp + s.ph) * s.rad;
        arr[i * 3 + 1] = s.by + Math.sin(t * s.sp * 1.4 + s.ph) * 0.28;
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

  function update(dt) {
    if (!worldState) return;
    camp.update(dt, worldState);
    ornithopter.update(dt, worldState);
    lanterns.update(dt, worldState);
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
