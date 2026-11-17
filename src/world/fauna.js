import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { NOISE_GLSL } from '../shaders/noise.glsl.js';
import { getGroundHeight, getGroundNormal, smoothstep } from './terrainMath.js';

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

function colorizeGeo(geom, colorFn) {
  const g = geom.index ? geom.toNonIndexed() : geom.clone();
  if (!g.attributes.normal) g.computeVertexNormals();
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nrm, i);
    colorFn(v, n, c);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
  }
  return g;
}

// ============================================================================
// 1. MUAD'DIB DESERT KANGAROO MOUSE (Dipodomys / Jerboa of Arrakis)
// ============================================================================

function createSculptedEarGeometry(side = 1) {
  const uSegs = 12;
  const vSegs = 16;
  const positions = [];
  const uvs = [];
  const colors = [];
  const indices = [];

  const cBase = new THREE.Color(0xc28a62);
  const cInner = new THREE.Color(0xe59c8a);
  const cRim = new THREE.Color(0xa66c4e);
  const cTmp = new THREE.Color();

  for (let iv = 0; iv <= vSegs; iv++) {
    const v = iv / vSegs;
    const widthEnv = Math.sin(Math.pow(v, 0.70) * Math.PI) * 0.035 + (1.0 - v) * 0.008;
    const lenY = v * 0.126;
    const sweepBackZ = -Math.pow(v, 1.50) * 0.036;

    for (let iu = 0; iu <= uSegs; iu++) {
      const u = iu / uSegs;
      const across = (u - 0.5) * 2.0;
      const cupZ = (1.0 - across * across) * 0.016 * Math.sin(v * Math.PI);
      const rollEdge = Math.pow(Math.abs(across), 2.6) * 0.0055;

      const x = side * across * widthEnv;
      const y = lenY;
      const z = sweepBackZ - cupZ + rollEdge;

      positions.push(x, y, z);
      uvs.push(u, v);

      const centerPink = (1.0 - Math.abs(across)) * Math.sin(v * Math.PI * 0.9);
      const rimFold = smoothstep(0.65, 1.0, Math.abs(across));
      cTmp.copy(cBase).lerp(cInner, centerPink * 0.72).lerp(cRim, (smoothstep(0.76, 1.0, v) + rimFold * 0.4) * 0.52);
      colors.push(cTmp.r, cTmp.g, cTmp.b);
    }
  }

  const stride = uSegs + 1;
  for (let iv = 0; iv < vSegs; iv++) {
    for (let iu = 0; iu < uSegs; iu++) {
      const a = iv * stride + iu;
      const b = (iv + 1) * stride + iu;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

function buildMuadDibCreature() {
  const root = new THREE.Group();
  root.name = 'MuadDibKangarooMouse';

  // Positioned on crisp wind-rippled sand at (3.16, ground, 8.92) in a classic 3/4 wildlife side-profile (rotation.y = 1.32)
  // so his arched back, tucked seed-holding paws, AND sweeping white-tufted kangaroo tail are all clearly visible!
  const homeX = 3.16;
  const homeZ = 8.92;
  const homeY = getGroundHeight(homeX, homeZ);
  root.position.set(homeX, homeY, homeZ);
  root.rotation.y = 1.32;

  const furUniforms = {
    uSunDir: { value: new THREE.Vector3(0.3, 0.25, -0.9) },
    uSunColor: { value: new THREE.Color(0xffcfa0) }
  };

  const furMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.86,
    metalness: 0.0,
    sheen: 0.68,
    sheenRoughness: 0.52,
    sheenColor: new THREE.Color(0xffe4c4)
  });
  furMat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = furUniforms.uSunDir;
    shader.uniforms.uSunColor = furUniforms.uSunColor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFurLocalPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFurLocalPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}\nvarying vec3 vFurLocalPos;`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float strand = vnoise3(vFurLocalPos * vec3(210.0, 95.0, 210.0)) * 0.62 + vnoise3(vFurLocalPos * 380.0) * 0.38;
        diffuseColor.rgb *= (0.87 + 0.25 * strand);`
      );
  };

  const earMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.64,
    metalness: 0.0,
    side: THREE.DoubleSide
  });
  earMat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = furUniforms.uSunDir;
    shader.uniforms.uSunColor = furUniforms.uSunColor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vEarUv;\nvarying vec3 vEarWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEarUv = uv;\nvEarWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${NOISE_GLSL}\nuniform vec3 uSunDir;\nuniform vec3 uSunColor;\nvarying vec2 vEarUv;\nvarying vec3 vEarWorldPos;`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float veinCoord = abs(vEarUv.x - 0.5) * 8.0 - vEarUv.y * 1.4 + (fbm2(vEarUv * 12.0) - 0.5) * 1.2;
        float vein = (1.0 - smoothstep(0.0, 0.14, abs(fract(veinCoord) - 0.5))) * smoothstep(0.08, 0.85, vEarUv.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.56, 0.14, 0.16), vein * 0.32);`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec3 viewRayE = normalize(vEarWorldPos - cameraPosition);
        float sunUpE = smoothstep(-0.02, 0.18, uSunDir.y);
        float transGlow = (0.30 + 0.70 * pow(max(dot(viewRayE, normalize(uSunDir)), 0.0), 1.8)) * sunUpE;
        float thinCenter = sin(vEarUv.x * 3.14159) * sin(vEarUv.y * 3.0);
        totalEmissiveRadiance += vec3(0.82, 0.22, 0.15) * uSunColor * thinCenter * transGlow * 0.48;`
      );
  };

  const eyeMat = new THREE.MeshPhysicalMaterial({
    color: 0x080607,
    roughness: 0.05,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
    reflectivity: 1.0
  });

  const bodyPivot = new THREE.Group();
  root.add(bodyPivot);

  const cDorsal = new THREE.Color(0xb87e4b);
  const cFlank = new THREE.Color(0xd6a26e);
  const cBelly = new THREE.Color(0xf2e5d4);
  const cFootShadow = new THREE.Color(0x9e7450);
  const cDarkTail = new THREE.Color(0x422a1a);

  const shadeCoat = (v, _n, outC) => {
    const bellyFactor = clamp(smoothstep(0.005, 0.055, v.z) * smoothstep(0.028, 0.065, v.y) * (1.0 - smoothstep(0.16, 0.23, v.y)), 0, 1);
    const dorsalFactor = clamp(smoothstep(0.01, -0.045, v.z) + smoothstep(0.11, 0.21, v.y) * 0.55, 0, 1);
    const groundAO = 1.0 - smoothstep(0.0, 0.032, v.y);
    outC.copy(cFlank).lerp(cDorsal, dorsalFactor * 0.82).lerp(cBelly, bellyFactor * 0.88).lerp(cFootShadow, groundAO * 0.55);
  };

  const bodyParts = [];

  // Arched agile jerboa/kangaroo-mouse haunches, tucked waist & chest
  const haunchGeo = new THREE.SphereGeometry(0.074, 20, 16);
  haunchGeo.scale(0.86, 1.08, 1.12);
  haunchGeo.rotateX(-0.18);
  haunchGeo.translate(0, 0.084, -0.018);
  bodyParts.push(colorizeGeo(haunchGeo, shadeCoat));

  const chestGeo = new THREE.SphereGeometry(0.052, 18, 14);
  chestGeo.scale(0.84, 1.15, 0.94);
  chestGeo.rotateX(0.36);
  chestGeo.translate(0, 0.148, 0.024);
  bodyParts.push(colorizeGeo(chestGeo, shadeCoat));

  // Defined slender neck bridge (eliminates "potato" silhouette!)
  const neckGeo = new THREE.SphereGeometry(0.034, 14, 10);
  neckGeo.scale(0.85, 1.05, 0.92);
  neckGeo.translate(0, 0.184, 0.034);
  bodyParts.push(colorizeGeo(neckGeo, shadeCoat));

  // Powerful kangaroo thighs, hocks & planted hind metatarsal feet
  for (const side of [-1, 1]) {
    const thigh = new THREE.SphereGeometry(0.045, 14, 12);
    thigh.scale(0.64, 1.16, 1.12);
    thigh.rotateZ(side * -0.14);
    thigh.translate(side * 0.052, 0.072, -0.012);
    bodyParts.push(colorizeGeo(thigh, shadeCoat));

    const shin = new THREE.CapsuleGeometry(0.010, 0.048, 4, 8);
    shin.rotateX(-0.48);
    shin.translate(side * 0.048, 0.036, -0.028);
    bodyParts.push(colorizeGeo(shin, shadeCoat));

    const foot = new THREE.CapsuleGeometry(0.0095, 0.082, 5, 8);
    foot.rotateX(Math.PI * 0.5);
    foot.rotateY(side * 0.10);
    foot.translate(side * 0.046, 0.008, 0.022);
    bodyParts.push(colorizeGeo(foot, (_v, _n, c) => c.setHex(0xc8a482)));
  }

  // Iconic long S-curved balancing tail sweeping forward-camera-left into full view with dark band & snowy brush tuft!
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.046, -0.072),
    new THREE.Vector3(-0.045, 0.014, -0.175),
    new THREE.Vector3(-0.095, 0.028, -0.295),
    new THREE.Vector3(-0.115, 0.088, -0.395),
    new THREE.Vector3(-0.085, 0.145, -0.455)
  ]);
  const tailGeo = new THREE.TubeGeometry(tailCurve, 28, 0.0072, 7, false);
  bodyParts.push(
    colorizeGeo(tailGeo, (v, _n, c) => {
      const distBack = Math.hypot(v.x, v.z);
      if (distBack > 0.41) c.setHex(0xfbf6ee);
      else if (distBack > 0.33) c.copy(cDarkTail);
      else c.copy(cDorsal);
    })
  );

  // Fluffy snowy-white bicolored tail-tip banner tuft!
  const tuftGeo = new THREE.SphereGeometry(0.022, 14, 12);
  tuftGeo.scale(0.75, 0.88, 2.05);
  tuftGeo.rotateX(-0.62);
  tuftGeo.rotateY(0.28);
  tuftGeo.translate(-0.082, 0.148, -0.458);
  bodyParts.push(
    colorizeGeo(tuftGeo, (v, _n, c) => {
      c.copy(v.z > -0.432 ? cDarkTail : new THREE.Color(0xfcf8f0));
    })
  );

  const bodyMesh = new THREE.Mesh(mergeGeometries(bodyParts, false), furMat);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyPivot.add(bodyMesh);

  // Delicate tucked forepaws angled inward at 45 deg cradling a natural russet-ochre desert seed pod!
  const pawsGroup = new THREE.Group();
  pawsGroup.position.set(0, 0.150, 0.056);
  bodyPivot.add(pawsGroup);

  const pawParts = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.CapsuleGeometry(0.0075, 0.028, 4, 7);
    arm.rotateZ(side * -0.68);
    arm.rotateX(1.15);
    arm.translate(side * 0.016, -0.004, 0.014);
    pawParts.push(colorizeGeo(arm, (_v, _n, c) => c.setHex(0xdcb894)));
  }
  const pawsMesh = new THREE.Mesh(mergeGeometries(pawParts, false), furMat);
  pawsMesh.castShadow = true;
  pawsGroup.add(pawsMesh);

  const seedGeo = new THREE.DodecahedronGeometry(0.013, 1);
  seedGeo.scale(0.82, 1.28, 0.82);
  seedGeo.rotateZ(0.35);
  const seedMat = new THREE.MeshStandardMaterial({
    color: 0x8a4820,
    roughness: 0.62,
    metalness: 0.0
  });
  const seedMesh = new THREE.Mesh(seedGeo, seedMat);
  seedMesh.position.set(0, 0.001, 0.028);
  seedMesh.castShadow = true;
  pawsGroup.add(seedMesh);

  // Articulated Head, Tapered Snout, Delicate Whiskers, Glossy Eyes & Oversized Translucent Veined Ears!
  const headGroup = new THREE.Group();
  headGroup.position.set(0, 0.204, 0.042);
  bodyPivot.add(headGroup);

  const headParts = [];
  const cranium = new THREE.SphereGeometry(0.042, 18, 14);
  cranium.scale(0.90, 0.88, 1.18);
  headParts.push(colorizeGeo(cranium, shadeCoat));

  const snout = new THREE.SphereGeometry(0.026, 14, 12);
  snout.scale(0.78, 0.72, 1.42);
  snout.translate(0, -0.007, 0.038);
  headParts.push(
    colorizeGeo(snout, (v, _n, c) => {
      c.copy(v.y < -0.009 ? cBelly : cFlank);
    })
  );

  const nose = new THREE.SphereGeometry(0.0058, 8, 8);
  nose.translate(0, -0.004, 0.074);
  headParts.push(colorizeGeo(nose, (_v, _n, c) => c.setHex(0xc97272)));

  const headMesh = new THREE.Mesh(mergeGeometries(headParts, false), furMat);
  headMesh.castShadow = true;
  headMesh.receiveShadow = true;
  headGroup.add(headMesh);

  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.0122, 14, 12), eyeMat);
    eye.scale.set(0.76, 1.0, 1.08);
    eye.position.set(side * 0.029, 0.008, 0.022);
    headGroup.add(eye);
  }

  // Ultra-fine tapered translucent vibrissae whiskers
  const whiskerMat = new THREE.MeshBasicMaterial({
    color: 0xead8c4,
    transparent: true,
    opacity: 0.36,
    depthWrite: false
  });
  const whiskerParts = [];
  for (const side of [-1, 1]) {
    for (let w = 0; w < 5; w++) {
      const wy = -0.004 + (w - 2) * 0.0032;
      const spreadY = (w - 2) * 0.009;
      const wCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 0.015, wy, 0.056),
        new THREE.Vector3(side * 0.048, wy + spreadY * 0.4, 0.048),
        new THREE.Vector3(side * 0.082, wy + spreadY - 0.010, 0.028)
      ]);
      whiskerParts.push(new THREE.TubeGeometry(wCurve, 6, 0.00045, 3, false));
    }
  }
  headGroup.add(new THREE.Mesh(mergeGeometries(whiskerParts, false), whiskerMat));

  const leftEarPivot = new THREE.Group();
  leftEarPivot.position.set(0.022, 0.026, -0.012);
  leftEarPivot.rotation.set(-0.24, 0.22, -0.32);
  const leftEarMesh = new THREE.Mesh(createSculptedEarGeometry(1), earMat);
  leftEarMesh.castShadow = true;
  leftEarPivot.add(leftEarMesh);
  headGroup.add(leftEarPivot);

  const rightEarPivot = new THREE.Group();
  rightEarPivot.position.set(-0.022, 0.026, -0.012);
  rightEarPivot.rotation.set(-0.20, -0.26, 0.34);
  const rightEarMesh = new THREE.Mesh(createSculptedEarGeometry(-1), earMat);
  rightEarMesh.castShadow = true;
  rightEarPivot.add(rightEarMesh);
  headGroup.add(rightEarPivot);

  // Soft alpha-feathered ground contact-shadow AO pad beneath Muad'Dib's planted hind feet (zero protruding cylinder wedges!)
  const aoGeo = new THREE.PlaneGeometry(0.38, 0.38);
  aoGeo.rotateX(-Math.PI * 0.5);
  const aoMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      void main() {
        float d = length((vUv - 0.5) * 2.0);
        float alpha = (1.0 - smoothstep(0.15, 0.98, d)) * 0.44;
        if (alpha < 0.005) discard;
        gl_FragColor = vec4(0.08, 0.04, 0.02, alpha);
      }
    `
  });
  const aoMesh = new THREE.Mesh(aoGeo, aoMat);
  const gNorm = getGroundNormal(homeX, homeZ, new THREE.Vector3());
  aoMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), gNorm);
  aoMesh.position.set(homeX, homeY + 0.004, homeZ);
  aoMesh.renderOrder = 3;

  const container = new THREE.Group();
  container.add(root);
  container.add(aoMesh);

  function update(_dt, state) {
    if (!state) return;
    const t = state.elapsed;
    furUniforms.uSunDir.value.copy(state.sunDir);
    furUniforms.uSunColor.value.copy(state.sunColor);

    const hopCycle = t % 9.5;
    let hopLift = 0;
    let hopFwd = 0;
    if (hopCycle > 5.2 && hopCycle < 6.1) {
      const u = (hopCycle - 5.2) / 0.9;
      hopLift = Math.sin(u * Math.PI) * 0.14;
      hopFwd = Math.sin(u * Math.PI * 2.0) * 0.12;
    }

    const px = homeX + Math.sin(root.rotation.y) * hopFwd;
    const pz = homeZ + Math.cos(root.rotation.y) * hopFwd;
    const gy = getGroundHeight(px, pz);
    root.position.set(px, gy + hopLift, pz);
    aoMesh.position.set(px, gy + 0.004, pz);

    const breathe = Math.sin(t * 5.8) * 0.012;
    bodyPivot.scale.set(1.0 + breathe, 1.0 - breathe * 0.5, 1.0 + breathe);
    bodyPivot.rotation.x = hopLift > 0.01 ? -0.24 : Math.sin(t * 2.4) * 0.03;

    const nibble = Math.sin(t * 14.0) * 0.022;
    headGroup.rotation.x = 0.06 + nibble + Math.sin(t * 1.9) * 0.05;
    headGroup.rotation.y = -0.18 + Math.sin(t * 1.35 + 0.4) * 0.14;
    pawsGroup.rotation.x = -nibble * 1.1;

    const flickL = Math.pow(Math.max(0, Math.sin(t * 3.1 + 0.7)), 12.0) * 0.22;
    const flickR = Math.pow(Math.max(0, Math.sin(t * 2.7 + 2.3)), 12.0) * 0.24;
    leftEarPivot.rotation.z = -0.32 - flickL + Math.sin(t * 1.6) * 0.04;
    rightEarPivot.rotation.z = 0.34 + flickR - Math.cos(t * 1.5) * 0.04;
  }

  return { group: container, update };
}

// ============================================================================
// 2. COLOSSAL SHAI-HULUD SANDWORM (ELDER MAKER) — BREACH & PATROL
//    (66 overlapping armor rings with zero sky gaps, 3-lobed chitinous Fremen jaw,
//     48 gleaming broad crysknife teeth, terrain-feathered pyroclastic dust & velocity sand curtains!)
// ============================================================================

function createWormSegmentGeometry() {
  const radialSegs = 32;
  // Extended z-skirt [-0.82, +0.82] guarantees 100% overlap between adjacent segments even on tight dorsal arcs!
  const profiles = [
    { z: -0.82, r: 0.84, shade: 0.38 },
    { z: -0.52, r: 0.98, shade: 0.78 },
    { z:  0.00, r: 1.03, shade: 1.04 },
    { z:  0.52, r: 0.97, shade: 0.82 },
    { z:  0.82, r: 0.84, shade: 0.38 }
  ];

  const positions = [];
  const colors = [];
  const indices = [];
  const baseCol = new THREE.Color(0x5e3e28);
  const ridgeCol = new THREE.Color(0x8e6342);
  const cTmp = new THREE.Color();

  for (let pi = 0; pi < profiles.length; pi++) {
    const pr = profiles[pi];
    for (let ri = 0; ri <= radialSegs; ri++) {
      const ang = (ri / radialSegs) * Math.PI * 2;
      const scute = 0.5 + 0.5 * Math.cos(ang * 16.0);
      const ventralFlat = Math.sin(ang) < -0.3 ? 0.95 : 1.0;
      const r = pr.r * (0.95 + 0.065 * scute) * ventralFlat;
      positions.push(Math.cos(ang) * r, Math.sin(ang) * r, pr.z);

      cTmp.copy(baseCol).lerp(ridgeCol, scute * 0.68).multiplyScalar(pr.shade);
      colors.push(cTmp.r, cTmp.g, cTmp.b);
    }
  }

  const stride = radialSegs + 1;
  for (let pi = 0; pi < profiles.length - 1; pi++) {
    for (let ri = 0; ri < radialSegs; ri++) {
      const a = pi * stride + ri;
      const b = (pi + 1) * stride + ri;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

// Sculpted 3-lobed armored Fremen jaw hood + corrugated oral folds + recessed spice-furnace throat
function createThreeLobedMawGeometry() {
  const uSegs = 48;
  const ringStops = [
    { z: -3.8, r: 5.45, lobeAmp: 0.03, kind: 0 },
    { z: -1.6, r: 5.85, lobeAmp: 0.08, kind: 0 },
    { z:  0.4, r: 6.15, lobeAmp: 0.16, kind: 0 },
    { z:  1.45, r: 5.75, lobeAmp: 0.22, kind: 0 }, // 3 prominent armored jaw lips!
    { z:  0.95, r: 5.05, lobeAmp: 0.18, kind: 1 },
    { z: -2.4, r: 2.35, lobeAmp: 0.08, kind: 1 },
    { z: -4.8, r: 0.85, lobeAmp: 0.02, kind: 2 },
    { z: -5.4, r: 0.02, lobeAmp: 0.00, kind: 2 }
  ];

  const positions = [];
  const colors = [];
  const uvs = [];
  const indices = [];

  const outerBase = new THREE.Color(0x5e3e28);
  const outerRidge = new THREE.Color(0x8e6342);
  const innerDark = new THREE.Color(0x180b08);
  const innerFold = new THREE.Color(0x36150c);
  const furnaceCore = new THREE.Color(1.35, 0.36, 0.06);
  const cTmp = new THREE.Color();

  for (let vi = 0; vi < ringStops.length; vi++) {
    const st = ringStops[vi];
    for (let ui = 0; ui <= uSegs; ui++) {
      const ang = (ui / uSegs) * Math.PI * 2;
      // 3-lobed Fremen jaw symmetry with sutured creases between the 3 jaw valves
      const triWave = Math.cos(ang * 3.0);
      const sutureDip = 1.0 - 0.14 * Math.pow(Math.max(0, -triWave), 3.0) * st.lobeAmp * 4.0;
      const scute = 0.5 + 0.5 * Math.cos(ang * 18.0);
      const r = st.r * (1.0 + st.lobeAmp * triWave) * sutureDip * (st.kind === 0 ? 0.95 + 0.06 * scute : 1.0);
      const zOut = st.z + (vi === 3 ? Math.max(0, triWave) * 0.65 : 0.0);

      positions.push(Math.cos(ang) * r, Math.sin(ang) * r, zOut);
      uvs.push(ui / uSegs, vi / (ringStops.length - 1));

      if (st.kind === 0) {
        cTmp.copy(outerBase).lerp(outerRidge, scute * 0.7).multiplyScalar(vi === 0 ? 0.65 : 0.95);
      } else if (st.kind === 1) {
        cTmp.copy(innerDark).lerp(innerFold, scute * 0.65);
      } else {
        cTmp.copy(furnaceCore);
      }
      colors.push(cTmp.r, cTmp.g, cTmp.b);
    }
  }

  const stride = uSegs + 1;
  for (let vi = 0; vi < ringStops.length - 1; vi++) {
    for (let ui = 0; ui < uSegs; ui++) {
      const a = vi * stride + ui;
      const b = (vi + 1) * stride + ui;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// Broad, gleaming, faceted triangular Fremen Crysknife Tooth (cleanly resolved at 90m with zero moiré sieve aliasing!)
function createCrysknifeToothGeometry() {
  const segs = 7;
  const positions = [];
  const indices = [];
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const taper = Math.pow(1.0 - u, 0.85);
    const w = 0.21 * taper;
    const thick = 0.085 * taper;
    const y = -u * 1.68;
    const z = Math.pow(u, 1.35) * 0.58;
    // 4-point diamond blade cross-section
    positions.push(
      -w, y, z,
       0, y, z + thick,
       w, y, z,
       0, y, z - thick
    );
  }
  for (let i = 0; i < segs; i++) {
    const b0 = i * 4;
    const b1 = (i + 1) * 4;
    for (let k = 0; k < 4; k++) {
      const kn = (k + 1) % 4;
      indices.push(b0 + k, b1 + k, b0 + kn, b0 + kn, b1 + k, b1 + kn);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  const out = g.toNonIndexed();
  out.computeVertexNormals();
  return out;
}

function buildShaiHuludSystem() {
  const wormRoot = new THREE.Group();
  wormRoot.name = 'ShaiHuludColossus';

  const SEG_COUNT = 66;
  const segGeo = createWormSegmentGeometry();
  const wormMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.03
  });
  const segIM = new THREE.InstancedMesh(segGeo, wormMat, SEG_COUNT);
  segIM.castShadow = true;
  segIM.receiveShadow = true;
  segIM.frustumCulled = false;
  wormRoot.add(segIM);

  const mawGroup = new THREE.Group();
  wormRoot.add(mawGroup);

  const hoodGeo = createThreeLobedMawGeometry();
  const hoodMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.86,
    metalness: 0.03
  });
  const hoodMesh = new THREE.Mesh(hoodGeo, hoodMat);
  hoodMesh.castShadow = true;
  hoodMesh.receiveShadow = true;
  mawGroup.add(hoodMesh);

  // 48 Gleaming Broad Crystalline Crysknife Teeth in 2 staggered radial crowns!
  const toothGeo = createCrysknifeToothGeometry();
  const toothMat = new THREE.MeshPhysicalMaterial({
    color: 0xf4ead6,
    roughness: 0.24,
    metalness: 0.04,
    clearcoat: 0.45
  });
  const TOOTH_COUNT = 48;
  const teethIM = new THREE.InstancedMesh(toothGeo, toothMat, TOOTH_COUNT);
  const tDummy = new THREE.Object3D();
  let tIdx = 0;
  for (let tier = 0; tier < 2; tier++) {
    const countInTier = tier === 0 ? 27 : 21;
    const rRing = tier === 0 ? 4.95 : 3.85;
    const zRing = tier === 0 ? 0.85 : -0.35;
    const tScale = tier === 0 ? 1.08 : 0.86;
    for (let k = 0; k < countInTier && tIdx < TOOTH_COUNT; k++) {
      const ang = (k / countInTier) * Math.PI * 2 + tier * 0.14;
      const lobe = 1.0 + 0.16 * Math.cos(ang * 3.0);
      tDummy.position.set(Math.cos(ang) * rRing * lobe, Math.sin(ang) * rRing * lobe, zRing);
      tDummy.rotation.set(0, 0, ang - Math.PI * 0.5);
      tDummy.scale.setScalar(tScale);
      tDummy.updateMatrix();
      teethIM.setMatrixAt(tIdx++, tDummy.matrix);
    }
  }
  teethIM.instanceMatrix.needsUpdate = true;
  mawGroup.add(teethIM);

  // Craggy Vertex-Displaced & Terrain-Feathered Breach Plume (ZERO smooth soap bubbles & ZERO hard Z-buffer terrain cut!)
  const PUFF_COUNT = 88;
  const puffGeo = new THREE.IcosahedronGeometry(1.0, 3);
  const puffGroundYArr = new Float32Array(PUFF_COUNT);
  const puffSeedArr = new Float32Array(PUFF_COUNT);
  for (let i = 0; i < PUFF_COUNT; i++) {
    puffSeedArr[i] = (i * 1.73) % 13.0;
  }
  puffGeo.setAttribute('aGroundY', new THREE.InstancedBufferAttribute(puffGroundYArr, 1));
  puffGeo.setAttribute('aPuffSeed', new THREE.InstancedBufferAttribute(puffSeedArr, 1));

  const puffUniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(0xffcfa0) },
    uHorizonColor: { value: new THREE.Color(0xe6ac7c) }
  };
  const puffMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: puffUniforms,
    vertexShader: /* glsl */ `
      ${NOISE_GLSL}
      attribute float aGroundY;
      attribute float aPuffSeed;
      uniform float uTime;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vWorldPos;
      varying float vGroundY;
      varying float vAlphaScale;
      void main() {
        vGroundY = aGroundY;
        float disp = (fbm3(position * 2.4 + vec3(aPuffSeed, -uTime * 0.65, aPuffSeed * 0.7)) - 0.45) * 0.52;
        vec3 p = position + normal * disp;
        vec4 wp = vec4(p, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
          vAlphaScale = length(instanceMatrix[0].xyz);
        #else
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vAlphaScale = 1.0;
        #endif
        wp = modelMatrix * wp;
        vWorldPos = wp.xyz;
        vViewDir = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uHorizonColor;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vWorldPos;
      varying float vGroundY;
      varying float vAlphaScale;

      void main() {
        if (vAlphaScale < 0.05) discard;
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(vViewDir);
        float rim = clamp(dot(N, V), 0.0, 1.0);

        // Multi-scale world-space turbulent sand-plume billows + smooth terrain contact feathering (zero hard dune cut seam!)
        vec3 q = vWorldPos * 0.24 + vec3(0.0, -uTime * 0.75, uTime * 0.22);
        vec3 warp = vec3(fbm3(q), fbm3(q + vec3(3.7, -2.1, 4.4)), fbm3(q + vec3(-2.9, 5.1, -1.6))) - 0.5;
        float turb = fbm3(q * 1.8 + warp * 1.5) * 0.62 + (1.0 - abs(vnoise3(q * 4.5 + warp * 1.8) * 2.0 - 1.0)) * 0.38;

        float terrainFeather = smoothstep(vGroundY - 0.4, vGroundY + 4.4, vWorldPos.y);
        float soft = pow(rim, 1.85) * smoothstep(0.24, 0.76, turb + rim * 0.30) * terrainFeather;
        if (soft < 0.012) discard;

        vec3 turbN = normalize(N + warp * 1.25);
        float sunLit = clamp(dot(turbN, normalize(uSunDir)) * 0.5 + 0.5, 0.0, 1.0);
        float sunUp = smoothstep(-0.06, 0.18, uSunDir.y);
        vec3 shadowSand = mix(vec3(0.12, 0.09, 0.14), vec3(0.42, 0.24, 0.125), sunUp);
        vec3 litSand = mix(uHorizonColor * 0.85, mix(vec3(0.90, 0.64, 0.36), uSunColor, 0.36), sunUp);
        vec3 col = mix(shadowSand, litSand, smoothstep(0.15, 0.88, sunLit * (0.7 + 0.45 * turb)));
        gl_FragColor = vec4(col, clamp(soft * 0.74, 0.0, 0.78));
      }
    `
  });
  const puffIM = new THREE.InstancedMesh(puffGeo, puffMat, PUFF_COUNT);
  puffIM.frustumCulled = false;
  puffIM.renderOrder = 5;
  wormRoot.add(puffIM);

  // FBM-Dissolved Warm Ochre Sand-Waterfall Veils pouring off Shai-Hulud's flanks (zero vertical white laser poles!)
  const CURTAIN_COUNT = 120;
  const curtainGeo = new THREE.PlaneGeometry(2.4, 5.5);
  const curtainUniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(0xc48248) },
    uOpacity: { value: 0.28 }
  };
  const curtainMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: curtainUniforms,
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      void main() {
        vUv = uv;
        vec4 wp = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
        #endif
        wp = modelMatrix * wp;
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      ${NOISE_GLSL}
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      void main() {
        float env = pow(sin(vUv.x * 3.14159265), 2.2) * pow(sin(vUv.y * 3.14159265), 1.6);
        float veil = fbm2(vec2(vWorldPos.x * 0.8 + vWorldPos.z * 0.8, vWorldPos.y * 0.25 + uTime * 3.2));
        float a = env * smoothstep(0.32, 0.82, veil) * uOpacity;
        if (a < 0.008) discard;
        gl_FragColor = vec4(uColor * (0.75 + 0.45 * veil), a);
      }
    `
  });
  const curtainIM = new THREE.InstancedMesh(curtainGeo, curtainMat, CURTAIN_COUNT);
  curtainIM.frustumCulled = false;
  curtainIM.renderOrder = 6;
  wormRoot.add(curtainIM);

  const curtainSeeds = [];
  const sRand = mulberry32(31337);
  for (let i = 0; i < CURTAIN_COUNT; i++) {
    curtainSeeds.push({
      s0: sRand(),
      s1: sRand(),
      s2: sRand(),
      scale: 0.7 + sRand() * 0.9
    });
  }

  const _dummy = new THREE.Object3D();
  const _pt = new THREE.Vector3();
  const _ptAhead = new THREE.Vector3();

  function evalBreachTrajectory(s, originX, originY, originZ, heading, outVec) {
    const forwardDist = (s - 0.12) * 58.0;
    const archY = Math.sin(clamp(s, -0.35, 1.35) * Math.PI) * 32.5 - (s < 0 ? -s * 28.0 : 0) - (s > 1 ? (s - 1) * 30.0 : 0);
    const sideSway = Math.sin(s * 3.6) * 3.8;
    const ch = Math.cos(heading);
    const sh = Math.sin(heading);
    outVec.set(
      originX + sh * forwardDist + ch * sideSway,
      originY + archY,
      originZ + ch * forwardDist - sh * sideSway
    );
    return outVec;
  }

  function update(_dt, worldState) {
    if (!worldState) return;
    const w = worldState.worm;
    const t = worldState.elapsed;

    puffUniforms.uTime.value = t;
    puffUniforms.uSunDir.value.copy(worldState.sunDir);
    puffUniforms.uSunColor.value.copy(worldState.sunColor);
    puffUniforms.uHorizonColor.value.copy(worldState.skyHorizonColor);

    const sunUp = smoothstep(-0.06, 0.18, worldState.sunDir.y);
    curtainUniforms.uTime.value = t;
    curtainUniforms.uColor.value.setRGB(
      mix(0.20, 0.72, sunUp),
      mix(0.16, 0.46, sunUp),
      mix(0.24, 0.25, sunUp)
    );

    if (w.phase === 'breach') {
      segIM.visible = true;
      puffIM.visible = true;
      curtainIM.visible = true;

      const ox = w.breachOrigin.x;
      const oz = w.breachOrigin.z;
      const oy = getGroundHeight(ox, oz) - 2.5;
      const headS = mix(-0.08, 1.18, w.breachProgress);
      const segSpacing = 0.0115;

      for (let i = 0; i < SEG_COUNT; i++) {
        const s = headS - (i + 0.85) * segSpacing;
        evalBreachTrajectory(s, ox, oy, oz, w.heading, _pt);
        evalBreachTrajectory(s + 0.008, ox, oy, oz, w.heading, _ptAhead);

        const groundHere = getGroundHeight(_pt.x, _pt.z);
        if (_pt.y < groundHere - 8.0) {
          _dummy.scale.setScalar(0.0001);
          _dummy.position.set(_pt.x, -50, _pt.z);
          _dummy.updateMatrix();
          segIM.setMatrixAt(i, _dummy.matrix);
          continue;
        }

        const taper = 1.0 - Math.pow(i / SEG_COUNT, 1.85) * 0.48;
        const rad = 5.65 * taper;
        _dummy.position.copy(_pt);
        _dummy.lookAt(_ptAhead);
        _dummy.scale.set(rad, rad, 2.05 * taper);
        _dummy.updateMatrix();
        segIM.setMatrixAt(i, _dummy.matrix);
      }
      segIM.instanceMatrix.needsUpdate = true;

      evalBreachTrajectory(headS, ox, oy, oz, w.heading, _pt);
      evalBreachTrajectory(headS + 0.012, ox, oy, oz, w.heading, _ptAhead);
      const headGround = getGroundHeight(_pt.x, _pt.z);
      if (_pt.y > headGround - 6.0) {
        mawGroup.visible = true;
        mawGroup.position.copy(_pt);
        mawGroup.lookAt(_ptAhead);
        mawGroup.rotateZ(0.25 + t * 0.35);
      } else {
        mawGroup.visible = false;
      }

      const groundAttr = puffGeo.attributes.aGroundY;
      for (let p = 0; p < PUFF_COUNT; p++) {
        if (p < 48) {
          const isReentry = p >= 30 && headS > 0.74;
          const refS = isReentry ? 1.0 : 0.05;
          evalBreachTrajectory(refS, ox, oy, oz, w.heading, _pt);
          const ang = (p / 30) * Math.PI * 2 + t * 0.32;
          const burst = isReentry
            ? smoothstep(0.74, 0.96, headS)
            : smoothstep(-0.08, 0.25, headS) * (1.0 - smoothstep(0.75, 1.0, w.breachProgress) * 0.5);
          const rOut = 5.2 + (p % 5) * 2.5 + burst * 5.2;
          const px = _pt.x + Math.cos(ang) * rOut;
          const pz = _pt.z + Math.sin(ang) * rOut;
          const localG = getGroundHeight(px, pz);
          groundAttr.array[p] = localG;
          const puffR = (3.0 + (p % 4) * 1.3) * Math.max(0.01, burst);
          _dummy.position.set(px, localG + 1.4 + puffR * 0.42 + (p % 3) * 1.4 * burst, pz);
          _dummy.rotation.set(t * 0.2 + p, p * 1.1, 0);
          _dummy.scale.set(puffR * 1.25, puffR * 0.90, puffR * 1.25);
        } else {
          // Cascading dust curtains strictly behind the maw (trailU >= 0.14 so ZERO puffs ever block the open mouth!)
          const trailU = 0.14 + ((p - 48) / (PUFF_COUNT - 48)) * 0.62;
          const segS = headS - trailU;
          evalBreachTrajectory(segS, ox, oy, oz, w.heading, _pt);
          const px = _pt.x + Math.sin(p * 2.3) * 3.4;
          const pz = _pt.z + Math.cos(p * 1.9) * 3.4;
          const localG = getGroundHeight(px, pz);
          groundAttr.array[p] = localG;
          if (_pt.y > localG + 1.5) {
            const drop = (t * 1.5 + p * 0.37) % 1.0;
            const fallY = mix(_pt.y - 2.6, localG + 2.2, drop * drop);
            const puffR = 2.0 + drop * 3.0;
            _dummy.position.set(px, fallY, pz);
            _dummy.scale.set(puffR, puffR * 1.32, puffR);
          } else {
            _dummy.scale.setScalar(0.001);
          }
        }
        _dummy.updateMatrix();
        puffIM.setMatrixAt(p, _dummy.matrix);
      }
      groundAttr.needsUpdate = true;
      puffIM.instanceMatrix.needsUpdate = true;

      // Update 260 velocity-stretched sand-curtain ribbons pouring downward off the worm's body!
      for (let i = 0; i < CURTAIN_COUNT; i++) {
        const sd = curtainSeeds[i];
        const life = (t * (0.95 + sd.s2 * 0.65) + sd.s0 * 5.0) % 1.0;
        const bodyS = headS - (0.06 + sd.s1 * 0.68);
        evalBreachTrajectory(bodyS, ox, oy, oz, w.heading, _pt);
        const gY = getGroundHeight(_pt.x, _pt.z);
        if (_pt.y > gY + 1.0) {
          const ang = sd.s0 * Math.PI * 2;
          const rad = 5.2 + life * 3.8;
          const px = _pt.x + Math.cos(ang) * rad + worldState.windDir.x * life * 4.5;
          const pz = _pt.z + Math.sin(ang) * rad + worldState.windDir.y * life * 4.5;
          const py = Math.max(gY + 1.5, _pt.y - 0.8 - life * life * 22.0);
          _dummy.position.set(px, py, pz);
          _dummy.rotation.set(0.08, ang, (sd.s2 - 0.5) * 0.20);
          _dummy.scale.set(sd.scale, sd.scale * (0.75 + life * 0.85), 1.0);
        } else {
          _dummy.position.set(ox, -80, oz);
          _dummy.scale.setScalar(0.001);
        }
        _dummy.updateMatrix();
        curtainIM.setMatrixAt(i, _dummy.matrix);
      }
      curtainIM.instanceMatrix.needsUpdate = true;
    } else {
      mawGroup.visible = false;
      curtainIM.visible = false;
      segIM.visible = false;
      puffIM.visible = Boolean(worldState.thumper && worldState.thumper.active);
      if (!puffIM.visible) return;

      const px = w.position.x;
      const pz = w.position.z;
      const ch = Math.cos(w.heading);
      const sh = Math.sin(w.heading);
      const groundAttr = puffGeo.attributes.aGroundY;

      for (let p = 0; p < PUFF_COUNT; p++) {
        if (p < 28) {
          const u = p / 28;
          const back = u * 34.0;
          const sx = px - sh * back + Math.sin(p * 2.1 + t) * 2.8;
          const sz = pz - ch * back + Math.cos(p * 1.7 + t) * 2.8;
          const gy = getGroundHeight(sx, sz);
          groundAttr.array[p] = gy;
          const puffR = (1.8 + u * 2.8) * (1.0 - u * 0.45);
          _dummy.position.set(sx, gy + 1.2 + puffR * 0.35, sz);
          _dummy.scale.set(puffR * 1.3, puffR * 0.75, puffR * 1.3);
        } else {
          _dummy.scale.setScalar(0.001);
        }
        _dummy.updateMatrix();
        puffIM.setMatrixAt(p, _dummy.matrix);
      }
      groundAttr.needsUpdate = true;
      puffIM.instanceMatrix.needsUpdate = true;
    }
  }

  return { group: wormRoot, update };
}

// ============================================================================
// 3. SOARING DIURNAL ARRAKIS DESERT HAWKS (Strictly Daytime & Clear of Eclipse/Night!)
// ============================================================================

function createDesertHawkGeometry() {
  const parts = [];

  const body = new THREE.ConeGeometry(0.085, 0.62, 7);
  body.rotateX(Math.PI * 0.5);
  parts.push(colorizeGeo(body, (_v, _n, c) => c.setHex(0x3a2618)));

  const tail = new THREE.ConeGeometry(0.18, 0.28, 4);
  tail.scale(1.0, 0.15, 1.0);
  tail.rotateX(-Math.PI * 0.5);
  tail.translate(0, 0.01, -0.34);
  parts.push(colorizeGeo(tail, (_v, _n, c) => c.setHex(0x5c3c24)));

  for (const side of [-1, 1]) {
    const innerWing = new THREE.BoxGeometry(0.58, 0.018, 0.20);
    innerWing.rotateY(side * -0.14);
    innerWing.rotateZ(side * 0.12);
    innerWing.translate(side * 0.30, 0.04, 0.04);
    parts.push(colorizeGeo(innerWing, (_v, _n, c) => c.setHex(0x4c3220)));

    const outerWing = new THREE.BoxGeometry(0.52, 0.012, 0.13);
    outerWing.rotateY(side * 0.24);
    outerWing.rotateZ(side * 0.05);
    outerWing.translate(side * 0.80, 0.08, -0.04);
    parts.push(colorizeGeo(outerWing, (_v, _n, c) => c.setHex(0x261810)));
  }

  return mergeGeometries(parts, false);
}

function buildSoaringHawks() {
  const count = 4;
  const hawkGeo = createDesertHawkGeometry();
  const hawkMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.85
  });
  const hawkIM = new THREE.InstancedMesh(hawkGeo, hawkMat, count);
  hawkIM.frustumCulled = false;

  const orbits = [
    { cx: -22, cz: -46, rx: 24, rz: 16, y: 22, speed: 0.16, phase: 0.9 },
    { cx: -28, cz: -56, rx: 26, rz: 19, y: 25.5, speed: 0.14, phase: 2.6 },
    { cx: 24, cz: -58, rx: 28, rz: 20, y: 26.5, speed: -0.13, phase: 1.5 },
    { cx: 18, cz: -82, rx: 32, rz: 22, y: 31, speed: 0.11, phase: 4.1 }
  ];

  const dummy = new THREE.Object3D();

  function update(_dt, worldState) {
    if (!worldState) return;
    const t = worldState.elapsed;
    const todPhase = worldState.timeOfDay * 0.92;
    const stormHide = worldState.weatherWeights.coriolisStorm;
    const isDayThermal = worldState.sunDir.y > 0.04 && worldState.eclipseStrength < 0.20 && stormHide < 0.65;

    hawkIM.visible = isDayThermal;
    if (!hawkIM.visible) return;

    for (let i = 0; i < count; i++) {
      const o = orbits[i];
      const a = t * o.speed + todPhase * (i % 2 === 0 ? 1 : -1) + o.phase;
      const px = o.cx + Math.cos(a) * o.rx;
      const pz = o.cz + Math.sin(a) * o.rz;
      const py = o.y + Math.sin(a * 2.0 + i) * 1.4;

      const vx = -Math.sin(a) * o.rx * o.speed;
      const vz = Math.cos(a) * o.rz * o.speed;
      const heading = Math.atan2(vx, vz);
      const bank = (o.speed > 0 ? -0.34 : 0.34) * (0.8 + 0.2 * Math.sin(a * 2.0));

      dummy.position.set(px, py, pz);
      dummy.rotation.set(0.04 * Math.sin(t * 2.0 + i), heading, bank);
      dummy.scale.setScalar(1.08);
      dummy.updateMatrix();
      hawkIM.setMatrixAt(i, dummy.matrix);
    }
    hawkIM.instanceMatrix.needsUpdate = true;
  }

  return { group: hawkIM, update };
}

export function createFaunaSystem(scene, worldState) {
  const group = new THREE.Group();
  group.name = 'ArrakisFaunaSystem';

  const muadDib = buildMuadDibCreature();
  const shaiHulud = buildShaiHuludSystem();
  const hawks = buildSoaringHawks();

  group.add(muadDib.group);
  group.add(shaiHulud.group);
  group.add(hawks.group);

  if (scene) {
    scene.add(group);
  }

  function update(dt) {
    muadDib.update(dt, worldState);
    shaiHulud.update(dt, worldState);
    hawks.update(dt, worldState);
  }

  return { group, update };
}
