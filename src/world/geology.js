import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NOISE_GLSL } from '../shaders/noise.glsl.js';
import {
  CISTERN_CENTER,
  WATER_LEVEL,
  fbm2,
  getGroundHeight,
  getGroundNormal,
  getPathDistance,
  getPathPointAt,
  getTerrainInfo,
  smoothstep
} from './terrainMath.js';

// ---------------------------------------------------------------------------
// Deterministic RNG & 3D procedural noise utilities (CPU geometry sculpting)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function smin(a, b, k) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
  return s - Math.floor(s);
}

function vnoise3(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const n000 = hash3(ix, iy, iz);
  const n100 = hash3(ix + 1, iy, iz);
  const n010 = hash3(ix, iy + 1, iz);
  const n110 = hash3(ix + 1, iy + 1, iz);
  const n001 = hash3(ix, iy, iz + 1);
  const n101 = hash3(ix + 1, iy, iz + 1);
  const n011 = hash3(ix, iy + 1, iz + 1);
  const n111 = hash3(ix + 1, iy + 1, iz + 1);

  return mix(
    mix(mix(n000, n100, ux), mix(n010, n110, ux), uy),
    mix(mix(n001, n101, ux), mix(n011, n111, ux), uy),
    uz
  );
}

function fbm3(x, y, z, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let px = x;
  let py = y;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise3(px, py, pz);
    const nx = px * 1.92 - pz * 0.58 + 13.7;
    const ny = py * 2.03 + 29.3;
    const nz = px * 0.58 + pz * 1.92 + 7.1;
    px = nx;
    py = ny;
    pz = nz;
    amp *= 0.5;
  }
  return sum;
}

function ridged3(x, y, z, octaves = 3) {
  let sum = 0;
  let amp = 0.55;
  let freq = 1.0;
  for (let i = 0; i < octaves; i++) {
    const n = 1.0 - Math.abs(vnoise3(x * freq, y * freq, z * freq) * 2.0 - 1.0);
    sum += amp * n * n;
    freq *= 2.12;
    amp *= 0.48;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Crease-angle normal computation & Geometry construction helpers
// ---------------------------------------------------------------------------

/**
 * Computes area-weighted creased vertex normals on non-indexed geometry so
 * fractured strata shelves and angular facets stay razor-sharp while gentle
 * sand-drifted aprons shade smoothly without polygon artifacts.
 */
function computeCreasedNormals(geom, creaseAngleDeg = 34) {
  const g = geom.index ? geom.toNonIndexed() : geom;
  const pos = g.attributes.position;
  const count = pos.count;
  const triCount = (count / 3) | 0;
  if (triCount <= 0) return g;

  g.computeBoundingBox();
  const bb = g.boundingBox;
  const span = Math.max(
    1e-3,
    bb.max.x - bb.min.x,
    bb.max.y - bb.min.y,
    bb.max.z - bb.min.z
  );
  const quant = 5000.0 / span;

  const faceNormals = new Float32Array(triCount * 3);
  const unitNormals = new Float32Array(triCount * 3);
  const buckets = new Map();

  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3;
    const i1 = i0 + 1;
    const i2 = i0 + 2;

    const ax = pos.getX(i0);
    const ay = pos.getY(i0);
    const az = pos.getZ(i0);
    const bx = pos.getX(i1);
    const by = pos.getY(i1);
    const bz = pos.getZ(i1);
    const cx = pos.getX(i2);
    const cy = pos.getY(i2);
    const cz = pos.getZ(i2);

    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);

    const t3 = t * 3;
    if (len > 1e-12 && Number.isFinite(len)) {
      faceNormals[t3] = nx;
      faceNormals[t3 + 1] = ny;
      faceNormals[t3 + 2] = nz;
      unitNormals[t3] = nx / len;
      unitNormals[t3 + 1] = ny / len;
      unitNormals[t3 + 2] = nz / len;
    } else {
      faceNormals[t3] = 0;
      faceNormals[t3 + 1] = 0;
      faceNormals[t3 + 2] = 0;
      unitNormals[t3] = 0;
      unitNormals[t3 + 1] = 1;
      unitNormals[t3 + 2] = 0;
    }

    for (let k = 0; k < 3; k++) {
      const idx = i0 + k;
      const key = `${Math.round(pos.getX(idx) * quant)},${Math.round(pos.getY(idx) * quant)},${Math.round(pos.getZ(idx) * quant)}`;
      let list = buckets.get(key);
      if (!list) {
        list = [];
        buckets.set(key, list);
      }
      list.push(idx);
    }
  }

  const cosThresh = Math.cos((creaseAngleDeg * Math.PI) / 180.0);
  const outNormals = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const t = (i / 3) | 0;
    const t3 = t * 3;
    const ux = unitNormals[t3];
    const uy = unitNormals[t3 + 1];
    const uz = unitNormals[t3 + 2];

    const key = `${Math.round(pos.getX(i) * quant)},${Math.round(pos.getY(i) * quant)},${Math.round(pos.getZ(i) * quant)}`;
    const list = buckets.get(key);

    let sx = 0;
    let sy = 0;
    let sz = 0;
    if (list) {
      for (let m = 0; m < list.length; m++) {
        const otherT = (list[m] / 3) | 0;
        const ot3 = otherT * 3;
        const dot = ux * unitNormals[ot3] + uy * unitNormals[ot3 + 1] + uz * unitNormals[ot3 + 2];
        if (dot >= cosThresh) {
          sx += faceNormals[ot3];
          sy += faceNormals[ot3 + 1];
          sz += faceNormals[ot3 + 2];
        }
      }
    }

    const sLen = Math.hypot(sx, sy, sz);
    const i3 = i * 3;
    if (sLen > 1e-12 && Number.isFinite(sLen)) {
      outNormals[i3] = sx / sLen;
      outNormals[i3 + 1] = sy / sLen;
      outNormals[i3 + 2] = sz / sLen;
    } else {
      outNormals[i3] = ux;
      outNormals[i3 + 1] = uy;
      outNormals[i3 + 2] = uz;
    }
  }

  g.setAttribute('normal', new THREE.BufferAttribute(outNormals, 3));
  return g;
}

/**
 * Builds a closed outward-wound non-indexed BufferGeometry from stacked rings.
 * Each ring is an array of { x, y, z, r?, g?, b?, u?, v? } ordered clockwise
 * in XZ (theta increasing from 0 to 2*PI with x = cos*R, z = sin*R).
 */
function buildLoftedPrism(rings, topCenter = null, botCenter = null) {
  const positions = [];
  const colors = [];
  const uvs = [];

  const pushV = (v, fallbackU = 0, fallbackV = 0) => {
    positions.push(v.x, v.y, v.z);
    colors.push(v.r !== undefined ? v.r : 1, v.g !== undefined ? v.g : 1, v.b !== undefined ? v.b : 1);
    uvs.push(v.u !== undefined ? v.u : fallbackU, v.v !== undefined ? v.v : fallbackV);
  };

  const hCount = rings.length;
  const sCount = rings[0].length;

  for (let h = 0; h < hCount - 1; h++) {
    const rA = rings[h];
    const rB = rings[h + 1];
    const vA = h / Math.max(1, hCount - 1);
    const vB = (h + 1) / Math.max(1, hCount - 1);
    for (let s = 0; s < sCount; s++) {
      const sNext = (s + 1) % sCount;
      const a = rA[s];
      const b = rA[sNext];
      const c = rB[sNext];
      const d = rB[s];
      const u0 = s / sCount;
      const u1 = (s + 1) / sCount;

      pushV(a, u0, vA);
      pushV(d, u0, vB);
      pushV(b, u1, vA);

      pushV(d, u0, vB);
      pushV(c, u1, vB);
      pushV(b, u1, vA);
    }
  }

  if (topCenter) {
    const topRing = rings[hCount - 1];
    for (let s = 0; s < sCount; s++) {
      const sNext = (s + 1) % sCount;
      pushV(topCenter, 0.5, 0.5);
      pushV(topRing[sNext], 0.5, 1.0);
      pushV(topRing[s], 0.5, 1.0);
    }
  }

  if (botCenter) {
    const botRing = rings[0];
    for (let s = 0; s < sCount; s++) {
      const sNext = (s + 1) % sCount;
      pushV(botCenter, 0.5, 0.5);
      pushV(botRing[s], 0.5, 0.0);
      pushV(botRing[sNext], 0.5, 0.0);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geom;
}

function preparePart(geom, hexColor = 0xffffff, jitter = 0) {
  const g = geom.index ? geom.toNonIndexed() : geom.clone();
  if (!g.attributes.normal) {
    g.computeVertexNormals();
  }
  const pos = g.attributes.position;
  const count = pos.count;
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  const existingColor = g.attributes.color;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color(hexColor);
  for (let i = 0; i < count; i++) {
    let mult = 1.0;
    if (jitter > 0) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);
      mult = 1.0 + (vnoise3(vx * 3.5, vy * 3.5, vz * 3.5) - 0.5) * jitter;
    }
    const er = existingColor ? existingColor.getX(i) : 1.0;
    const eg = existingColor ? existingColor.getY(i) : 1.0;
    const eb = existingColor ? existingColor.getZ(i) : 1.0;
    colors[i * 3] = clamp(c.r * er * mult, 0, 1);
    colors[i * 3 + 1] = clamp(c.g * eg * mult, 0, 1);
    colors[i * 3 + 2] = clamp(c.b * eb * mult, 0, 1);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function mergePreparedParts(parts) {
  const merged = mergeGeometries(parts, false);
  for (let i = 0; i < parts.length; i++) {
    parts[i].dispose();
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Procedural GLSL Material Factory (Three.js r187 onBeforeCompile)
// ---------------------------------------------------------------------------

function createAtmoUniforms(worldState) {
  return {
    uHorizonColor: { value: worldState ? worldState.skyHorizonColor.clone() : new THREE.Color(0xe6ac7c) },
    uSunColor: { value: worldState ? worldState.sunColor.clone() : new THREE.Color(0xffcfa0) },
    uZenithColor: { value: worldState ? worldState.skyZenithColor.clone() : new THREE.Color(0x4b6088) },
    uSunDir: { value: worldState ? worldState.sunDir.clone() : new THREE.Vector3(0.22, 0.14, -0.96) },
    uSunIntensity: { value: worldState ? worldState.sunIntensity : 3.0 },
    uFogDensity: { value: worldState ? worldState.fogDensity : 0.0022 }
  };
}

function syncAtmoUniforms(atmoUniforms, worldState) {
  if (!worldState || !atmoUniforms) return;
  atmoUniforms.uHorizonColor.value.copy(worldState.skyHorizonColor);
  atmoUniforms.uSunColor.value.copy(worldState.sunColor);
  atmoUniforms.uZenithColor.value.copy(worldState.skyZenithColor);
  atmoUniforms.uSunDir.value.copy(worldState.sunDir);
  atmoUniforms.uSunIntensity.value = worldState.sunIntensity;
  atmoUniforms.uFogDensity.value = worldState.fogDensity;
}

const FALLBACK_ATMO_UNIFORMS = createAtmoUniforms(null);

function createSandstonePhysicalMaterial(extra = {}) {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.90,
    metalness: 0.0,
    ior: 1.5,
    specularIntensity: 0.05,
    specularColor: new THREE.Color(0xf6d5b0),
    diffuseRoughness: 0.86,
    envMapIntensity: 0.18,
    ...extra
  });
}

function enhanceSandstoneMaterial(material, options = {}) {
  const {
    strataFreq = 9.0,
    bumpStrength = 0.24,
    dustStrength = 0.18,
    varnishStrength = 0.10,
    wetLine = -10.0,
    sandApronStrength = 0.0,
    baseOffset = 0.45,
    pureSandMix = 0.0,
    cisternSandDrift = 0.0,
    apronRange = 0.20,
    apronSlopeMin = 0.66,
    edgeSandStrength = 0.0,
    sandFilletStrength = 0.0,
    sandFilletHeight = 0.45,
    dressedStone = 0.0,
    atmoUniforms = FALLBACK_ATMO_UNIFORMS
  } = options;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uStrataFreq = { value: strataFreq };
    shader.uniforms.uBumpStrength = { value: bumpStrength };
    shader.uniforms.uDustStrength = { value: dustStrength };
    shader.uniforms.uVarnishStrength = { value: varnishStrength };
    shader.uniforms.uWetLine = { value: wetLine };
    shader.uniforms.uSandApronStrength = { value: sandApronStrength };
    shader.uniforms.uBaseOffset = { value: baseOffset };
    shader.uniforms.uPureSandMix = { value: pureSandMix };
    shader.uniforms.uCisternSandDrift = { value: cisternSandDrift };
    shader.uniforms.uApronRange = { value: apronRange };
    shader.uniforms.uApronSlopeMin = { value: apronSlopeMin };
    shader.uniforms.uEdgeSandStrength = { value: edgeSandStrength };
    shader.uniforms.uSandFilletStrength = { value: sandFilletStrength };
    shader.uniforms.uSandFilletHeight = { value: sandFilletHeight };
    shader.uniforms.uDressedStone = { value: dressedStone };
    shader.uniforms.uHorizonColor = atmoUniforms.uHorizonColor;
    shader.uniforms.uSunColor = atmoUniforms.uSunColor;
    shader.uniforms.uZenithColor = atmoUniforms.uZenithColor;
    shader.uniforms.uSunDir = atmoUniforms.uSunDir;
    shader.uniforms.uSunIntensity = atmoUniforms.uSunIntensity;
    shader.uniforms.uFogDensity = atmoUniforms.uFogDensity;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uBaseOffset;
        varying vec3 vGeoWorldPos;
        varying vec3 vGeoWorldNormal;
        varying float vGeoBaseY;
        varying float vGeoUvX;`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        vec3 geoObjN = objectNormal;
        #ifdef USE_INSTANCING
          geoObjN = mat3( instanceMatrix ) * geoObjN;
        #endif
        vGeoWorldNormal = normalize( mat3( modelMatrix ) * geoObjN );`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 geoWp = vec4( transformed, 1.0 );
        vec4 geoOrigin = vec4( 0.0, 0.0, 0.0, 1.0 );
        #ifdef USE_INSTANCING
          geoWp = instanceMatrix * geoWp;
          geoOrigin = instanceMatrix * geoOrigin;
        #endif
        geoWp = modelMatrix * geoWp;
        geoOrigin = modelMatrix * geoOrigin;
        vGeoWorldPos = geoWp.xyz;
        vGeoBaseY = geoOrigin.y + uBaseOffset;
        vGeoUvX = uv.x;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uStrataFreq;
        uniform float uBumpStrength;
        uniform float uDustStrength;
        uniform float uVarnishStrength;
        uniform float uWetLine;
        uniform float uSandApronStrength;
        uniform float uPureSandMix;
        uniform float uCisternSandDrift;
        uniform float uApronRange;
        uniform float uApronSlopeMin;
        uniform float uEdgeSandStrength;
        uniform float uSandFilletStrength;
        uniform float uSandFilletHeight;
        uniform float uDressedStone;
        uniform vec3 uHorizonColor;
        uniform vec3 uSunColor;
        uniform vec3 uZenithColor;
        uniform vec3 uSunDir;
        uniform float uSunIntensity;
        uniform float uFogDensity;
        varying vec3 vGeoWorldPos;
        varying vec3 vGeoWorldNormal;
        varying float vGeoBaseY;
        varying float vGeoUvX;
        ${NOISE_GLSL}

        float arrakisRockHeight(vec3 p, float w1, float w2, float bedMask, float aaFine) {
          float warpScale = mix(1.0, 0.14, uDressedStone);
          float bedCoord = p.y + (p.x * 0.055 - p.z * 0.045) * warpScale + (w1 * 0.42 + w2 * 0.12) * warpScale;
          // Crisp horizontal sedimentary shelf ledges + undercut recesses + chiseled sandstone pores
          float f1 = fract(bedCoord * (uStrataFreq * 0.13));
          float b1 = smoothstep(0.0, 0.07, f1) * (1.0 - smoothstep(0.68, 0.96, f1) * 0.22) - smoothstep(0.92, 1.0, f1) * 0.20;
          float f2 = fract(bedCoord * (uStrataFreq * 0.34) + w2 * 0.16 * warpScale);
          float b2 = smoothstep(0.0, 0.08, f2) * (1.0 - smoothstep(0.72, 0.96, f2) * 0.18) - smoothstep(0.93, 1.0, f2) * 0.12;
          float f3 = fract(bedCoord * (uStrataFreq * 0.76) + w2 * 0.28 * warpScale);
          float b3 = smoothstep(0.0, 0.14, f3);
          float pitField = vnoise3(p * 5.8 + vec3(w2 * 1.35, w1 * 0.9, -w2 * 1.1));
          float bedCrevice = 1.0 - smoothstep(0.06, 0.34, f1);
          float dressedSuppress = 1.0 - smoothstep(0.25, 0.80, uDressedStone);
          float pits = smoothstep(0.58, 0.86, pitField) * (0.35 + 0.65 * bedCrevice) * dressedSuppress;
          float grain = vnoise3(p * 5.4);
          float fineGrit = vnoise3(p * 14.5);
          float pores = vnoise3(p * 28.0);
          float strataRelief = (b1 * 0.44 + b2 * 0.26 + b3 * 0.11) * (0.48 + 0.52 * bedMask) * mix(1.0, 0.20, uDressedStone);
          float coarseGrain = grain * mix(0.14, 0.012, uDressedStone);
          float crispGrit = (fineGrit * mix(0.22, 0.18, uDressedStone) + pores * mix(0.16, 0.14, uDressedStone)) * (0.30 + 0.70 * aaFine);
          // Fine linear split-cleaved sandstone fracture seams on horizontal flagstones (zero extra noise evals)
          float fracCoord = p.x * 0.86 - p.z * 0.51 + (w1 * 0.28 + w2 * 0.08);
          float fCrack = abs(fract(fracCoord * 0.82) - 0.5);
          float linearSeam = (1.0 - smoothstep(0.0, 0.028, fCrack)) * smoothstep(0.28, 0.72, pitField) * uDressedStone;
          return strataRelief - pits * 0.18 - linearSeam * 0.15 + coarseGrain + crispGrit;
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 nW = normalize(vGeoWorldNormal);
        float w1 = fbm3(vGeoWorldPos * 0.28 + vec3(2.4, 0.8, 7.2));
        float w2 = fbm3(vGeoWorldPos * 1.05 + vec3(-4.1, 1.9, 3.3));
        float bedPatch = smoothstep(0.25, 0.78, fbm3(vGeoWorldPos * 0.55 + vec3(-1.3, 2.7, 4.1)));
        float warpScaleC = mix(1.0, 0.16, uDressedStone);
        float bedCoord = vGeoWorldPos.y + (vGeoWorldPos.x * 0.055 - vGeoWorldPos.z * 0.045) * warpScaleC + (w1 * 0.42 + w2 * 0.12) * warpScaleC;
        float f1C = fract(bedCoord * (uStrataFreq * 0.13));
        float undercutBand = (smoothstep(0.89, 0.99, f1C) + (1.0 - smoothstep(0.0, 0.06, f1C))) * (1.0 - uDressedStone);
        float bLow = sin(bedCoord * (uStrataFreq * 0.19) + w1 * 0.75 * warpScaleC);
        float bMid = sin(bedCoord * (uStrataFreq * 0.38) + w2 * 1.15 * warpScaleC + 1.3);
        float bFine = sin(bedCoord * (uStrataFreq * 0.76) + w2 * 1.65 * warpScaleC + 2.7);
        float bLamina = sin(bedCoord * (uStrataFreq * 1.48) + w2 * 2.1 * warpScaleC + 0.9);
        float bedMix = (bLow * 0.46 + bMid * 0.32 + bFine * 0.15 + bLamina * 0.07) * (0.45 + 0.55 * bedPatch);
        float microNoise = vnoise3(vGeoWorldPos * 5.2);
        float fineGritC = vnoise3(vGeoWorldPos * 12.8);
        float pitFieldC = vnoise3(vGeoWorldPos * 5.8 + vec3(w2 * 1.35, w1 * 0.9, -w2 * 1.1));
        float dressedSuppressC = 1.0 - smoothstep(0.25, 0.80, uDressedStone);
        float pitMaskC = smoothstep(0.58, 0.86, pitFieldC) * dressedSuppressC;
        float fracCoordC = vGeoWorldPos.x * 0.86 - vGeoWorldPos.z * 0.51 + (w1 * 0.28 + w2 * 0.08);
        float fCrackC = abs(fract(fracCoordC * 0.82) - 0.5);
        float linearSeamC = (1.0 - smoothstep(0.0, 0.028, fCrackC)) * smoothstep(0.28, 0.72, pitFieldC) * uDressedStone;

        // Calibrated Linear RGB warm desert sandstone-sand matching terrain.js palette
        float macroSand = fbm2(vGeoWorldPos.xz * 0.025 + vec2(4.2, -7.1));
        float sandGrain = vnoise2(vGeoWorldPos.xz * 14.0) * 0.5 + vnoise2(vGeoWorldPos.xz * 34.0) * 0.5;
        vec3 sandTrough = vec3(0.45, 0.26, 0.120);
        vec3 sandGold   = vec3(0.62, 0.40, 0.195);
        vec3 desertSand = mix(sandTrough, sandGold, smoothstep(0.22, 0.76, macroSand));
        desertSand *= (0.94 + 0.10 * sandGrain);

        // Wind-carved ochre-sandstone strata variation + pitted sandstone mineral grain
        float rockLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        float strataTint = smoothstep(0.05, 0.20, rockLum);
        float eastRimBoost = 1.0 + smoothstep(6.0, 24.0, vGeoWorldPos.x) * 0.45;
        float strataScale = clamp(uVarnishStrength * 6.0, 0.15, 1.0) * eastRimBoost * (1.0 - 0.65 * uDressedStone);
        vec3 warmOchre = vec3(0.54, 0.33, 0.145);
        vec3 paleLamina = vec3(0.60, 0.40, 0.21);
        vec3 ironBand = vec3(0.24, 0.125, 0.058);
        float ironMask = smoothstep(0.36, 0.88, bedMix) * (0.40 + 0.60 * vnoise3(vGeoWorldPos * 1.15));
        float microContrast = mix(0.40, 0.14, uDressedStone);
        float macroMixMod = mix(0.85 + 0.30 * microNoise, 0.96 + 0.08 * microNoise, uDressedStone);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * macroMixMod * (0.91 + 0.18 * fineGritC), microContrast);
        diffuseColor.rgb *= (1.0 - pitMaskC * 0.13 * strataTint - undercutBand * 0.14 * strataTint - linearSeamC * 0.14 * strataTint);
        diffuseColor.rgb = mix(diffuseColor.rgb, warmOchre, smoothstep(0.22, 0.82, bMid * 0.5 + 0.5) * 0.11 * strataTint * strataScale);
        diffuseColor.rgb = mix(diffuseColor.rgb, paleLamina, smoothstep(0.45, 0.90, bLow * 0.5 + 0.5) * 0.075 * strataTint * strataScale);
        diffuseColor.rgb = mix(diffuseColor.rgb, ironBand, clamp(ironMask * 0.19 + smoothstep(0.60, 0.92, bLamina) * 0.085, 0.0, 0.25) * clamp(uVarnishStrength * 3.6, 0.10, 0.68) * eastRimBoost * strataTint * (1.0 - 0.65 * uDressedStone));

        // Wind-blown sand dust resting strictly on upward horizontal sedimentary shelves & cornices
        float upShelf = smoothstep(0.68, 0.94, nW.y) * (0.45 + 0.55 * vnoise2(vGeoWorldPos.xz * 0.85));
        diffuseColor.rgb = mix(diffuseColor.rgb, desertSand, upShelf * uDustStrength);

        // Crisp tight sand-apron transition strictly on horizontal talus bases (zero smear on steep cliff faces)
        float skirtSand = 0.0;
        if (uSandApronStrength > 0.001) {
          float safeRange = min(uApronRange, 0.24);
          float safeSlopeMin = max(uApronSlopeMin, 0.40);
          float driftScale = max(0.02, safeRange / 0.24);
          float driftWarp = (fbm2(vGeoWorldPos.xz * 1.65 + vec2(3.1, -2.7)) - 0.5) * 0.05 * driftScale;
          float baseBlend = 1.0 - smoothstep(vGeoBaseY + safeRange * 0.20 + driftWarp, vGeoBaseY + safeRange + driftWarp, vGeoWorldPos.y);
          float slopeTrap = smoothstep(safeSlopeMin, clamp(safeSlopeMin + 0.20, 0.64, 0.94), nW.y);
          skirtSand = clamp(baseBlend * slopeTrap * uSandApronStrength, 0.0, 0.88);
        }

        // Subtle wind-drifted sand filleting strictly at flared architectural plinth base (e.g. Windtrap)
        if (uSandFilletStrength > 0.001) {
          float filletWarp = (fbm2(vGeoWorldPos.xz * 0.75 + vec2(2.1, -5.3)) - 0.5) * 0.28;
          float windLee = dot(normalize(vGeoWorldPos.xz - vec2(-21.0, -25.0) + vec2(1e-5)), normalize(vec2(0.92, 0.39)));
          float leeDrift = (0.5 + 0.5 * windLee) * 0.18;
          float filletY = vGeoBaseY + uSandFilletHeight + filletWarp + leeDrift;
          float filletBlend = 1.0 - smoothstep(vGeoBaseY - 0.14, filletY, vGeoWorldPos.y);
          float filletSlope = smoothstep(0.08, 0.44, nW.y);
          skirtSand = max(skirtSand, clamp(filletBlend * filletSlope * uSandFilletStrength, 0.0, 0.92));
        }

        // Wind-drifted sand lapping softly across outer perimeter slope & buried collar of flagstones
        if (uEdgeSandStrength > 0.001) {
          float driftMacro = fbm2(vGeoWorldPos.xz * 1.15 + vec2(3.4, -2.8));
          float driftMicro = (fbm2(vGeoWorldPos.xz * 3.1 + vec2(-1.7, 5.2)) - 0.5) * 0.22;
          float edgeOverlap = smoothstep(0.30, 0.78, driftMacro) * 0.26;
          float radialSand = smoothstep(0.24 - edgeOverlap + driftMicro, 0.72 + driftMicro * 0.4, vGeoUvX);
          float skirtSeal = smoothstep(0.54 + driftMicro * 0.2, 0.84, vGeoUvX) * 0.62;
          skirtSand = max(skirtSand, clamp(radialSand * uEdgeSandStrength + skirtSeal, 0.0, 0.96));
        }

        // Encroaching wind-drifted desert sand lapping over the outer backs & crevices of cistern rim stones
        if (uCisternSandDrift > 0.001) {
          vec2 fromCistern = vGeoWorldPos.xz - vec2(0.0, 3.8);
          vec2 outDir = normalize(fromCistern + vec2(1e-5, 0.0));
          float facingOut = smoothstep(-0.24, 0.46, dot(nW.xz, outDir));
          float upperBack = smoothstep(0.22, 0.80, nW.y) * smoothstep(0.71, 0.94, vGeoWorldPos.y);
          float driftPatch = smoothstep(0.16, 0.72, fbm2(vGeoWorldPos.xz * 0.88 + vec2(2.3, -4.1)));
          float dryHeightMask = smoothstep(0.73, 0.88, vGeoWorldPos.y);
          float backSand = clamp((facingOut * 0.66 + upperBack * 0.76) * driftPatch * dryHeightMask * uCisternSandDrift, 0.0, 0.94);
          skirtSand = max(skirtSand, backSand);
        }

        skirtSand = clamp(max(skirtSand, uPureSandMix), 0.0, 1.0);
        vec3 matchedApronSand = mix(desertSand, diffuseColor.rgb * vec3(1.04, 0.98, 0.92), 0.14 * (1.0 - uPureSandMix));
        diffuseColor.rgb = mix(diffuseColor.rgb, matchedApronSand, skirtSand);

        // Warm damp sandstone capillary tinting smoothly near WATER_LEVEL (matches terrain wet sand)
        float wetAmount = 0.0;
        if (uWetLine > -5.0) {
          float capNoise = (fbm2(vGeoWorldPos.xz * 3.1 + vec2(1.7, -3.3)) - 0.5) * 0.032;
          wetAmount = 1.0 - smoothstep(uWetLine - 0.015, uWetLine + 0.095 + capNoise, vGeoWorldPos.y);
          float subWaterDark = 1.0 - smoothstep(uWetLine - 0.14, uWetLine + 0.01, vGeoWorldPos.y);
          vec3 wetTint = mix(vec3(0.78, 0.71, 0.63), vec3(0.60, 0.54, 0.47), subWaterDark);
          diffuseColor.rgb *= mix(vec3(1.0), wetTint, wetAmount);
        }`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (uBumpStrength > 0.001 && uPureSandMix < 0.99) {
          float fwSpan = length(fwidth(vGeoWorldPos));
          float aaFine = 1.0 - smoothstep(0.04, 0.22, fwSpan);
          float eps = clamp(fwSpan * 0.55, 0.014, 0.032);
          float h0 = arrakisRockHeight(vGeoWorldPos, w1, w2, bedPatch, aaFine);
          float hx = arrakisRockHeight(vGeoWorldPos + vec3(eps, 0.0, 0.0), w1, w2, bedPatch, aaFine);
          float hy = arrakisRockHeight(vGeoWorldPos + vec3(0.0, eps, 0.0), w1, w2, bedPatch, aaFine);
          float hz = arrakisRockHeight(vGeoWorldPos + vec3(0.0, 0.0, eps), w1, w2, bedPatch, aaFine);
          vec3 gradW = vec3(hx - h0, hy - h0, hz - h0) / eps;
          vec3 nWorld = normalize(vGeoWorldNormal);
          vec3 gradSurf = gradW - nWorld * dot(gradW, nWorld);
          vec3 gradView = (viewMatrix * vec4(gradSurf, 0.0)).xyz;
          float wetBumpDamp = 1.0 - wetAmount * 0.92;
          float bumpFade = 1.0 - clamp(skirtSand * 0.92, 0.0, 0.92);
          normal = normalize(normal - (uBumpStrength * wetBumpDamp) * bumpFade * gradView);
        }
        if (skirtSand > 0.18 && uEdgeSandStrength < 0.01 && vGeoWorldNormal.y > 0.45) {
          vec3 viewUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          normal = normalize(mix(normal, viewUp, skirtSand * 0.10));
        }`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float rNoise = vnoise3(vGeoWorldPos * 5.8);
        float desertVarnish = smoothstep(0.48, 0.92, sin(bedCoord * (uStrataFreq * 0.22) + rNoise * 2.5));
        roughnessFactor = clamp(roughnessFactor - desertVarnish * 0.05 * uVarnishStrength + pitMaskC * 0.06 + (rNoise - 0.5) * 0.08 * (1.0 - 0.65 * uDressedStone), 0.58, 0.98);
        roughnessFactor = mix(roughnessFactor, 0.90, skirtSand);
        if (wetAmount > 0.001) {
          float wetRough = mix(0.62, 0.48, smoothstep(0.20, 0.90, wetAmount));
          roughnessFactor = max(0.48, mix(roughnessFactor, wetRough, wetAmount));
        }`
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        float rockSpecInt = mix(0.068, 0.052, skirtSand);
        rockSpecInt = clamp(mix(rockSpecInt, 0.095, wetAmount), 0.0, 0.11);
        #ifdef IOR
          #ifdef USE_SPECULAR
            specularIntensityFactor = rockSpecInt;
            material.specularF90 = mix(specularIntensityFactor, 1.0, metalnessFactor);
            material.specularColor = min(pow2((material.ior - 1.0) / (material.ior + 1.0)) * specularColorFactor, vec3(1.0)) * specularIntensityFactor;
            material.specularColorBlended = mix(material.specularColor, diffuseColor.rgb, metalnessFactor);
          #endif
        #endif
        #ifdef USE_DIFFUSE_ROUGHNESS
          material.diffuseRoughness = mix(0.84, 0.56, wetAmount);
        #endif`
      )
      .replace(
        '#include <lights_fragment_end>',
        `#if defined( RE_IndirectDiffuse )
          vec3 geoSunFillDir = normalize(uSunDir);
          float geoZenithLuma = dot(uZenithColor, vec3(0.2126, 0.7152, 0.0722));
          float geoNightGate = 1.0 - smoothstep(-0.02, 0.14, geoSunFillDir.y);
          float geoEclipseGate = (1.0 - smoothstep(0.045, 0.14, geoZenithLuma)) * smoothstep(-0.04, 0.12, geoSunFillDir.y) * (1.0 - smoothstep(2.0, 2.7, uSunIntensity));
          float geoDarkGate = clamp(max(geoNightGate, geoEclipseGate * 0.92), 0.0, 1.0);
          if (geoDarkGate > 0.005) {
            vec3 nWorldFill = normalize(vGeoWorldNormal);
            float skyCatch = clamp(nWorldFill.y * 0.65 + max(nWorldFill.z, 0.0) * 0.35, 0.0, 1.0);
            float deepNight = 1.0 - smoothstep(-0.14, 0.02, geoSunFillDir.y);
            vec3 moonSkyFill = mix(vec3(0.16, 0.23, 0.42), uHorizonColor * 1.15 + vec3(0.10, 0.14, 0.24), 0.32 * (1.0 - deepNight * 0.55));
            vec3 nightDuneFill = vec3(0.15, 0.16, 0.24);
            vec3 twiDuneFill = vec3(0.30, 0.18, 0.11);
            vec3 duneBounceFill = mix(nightDuneFill, twiDuneFill, clamp(geoEclipseGate + (1.0 - deepNight) * 0.65, 0.0, 1.0));
            vec3 nocturnalBounce = mix(duneBounceFill, moonSkyFill, skyCatch);
            irradiance += nocturnalBounce * (1.05 * geoDarkGate);
          }
        #endif
        #include <lights_fragment_end>
        if (wetAmount > 0.005) {
          float geoNdv = clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0);
          // Grazing-suppressed soft damp sky tint so 1px silhouette aliasing dots never fire at WATER_LEVEL
          float wetUpSheen = smoothstep(0.18, 0.62, geoNdv) * smoothstep(0.22, 0.88, clamp(normalize(vGeoWorldNormal).y, 0.0, 1.0));
          vec3 wetSkyRefl = mix(uHorizonColor * 0.42, uZenithColor * 0.60, 0.45);
          reflectedLight.indirectSpecular += wetSkyRefl * wetUpSheen * wetAmount * 0.022;
        }`
      )
      .replace(
        '#include <fog_fragment>',
        `#ifdef USE_FOG
          vec3 geoViewVec = cameraPosition - vGeoWorldPos;
          float geoViewDist = length(geoViewVec);
          vec3 geoViewRay = -geoViewVec / max(geoViewDist, 0.0001);
          vec3 geoSunDirW = normalize(uSunDir);

          float fogDens = max(uFogDensity, 0.0025);
          float distFactor = 1.0 - exp(-pow(geoViewDist * fogDens, 1.35));
          float stormFogLift = smoothstep(0.006, 0.013, uFogDensity);
          float baseMist = clamp(distFactor * mix(0.62, 0.92, stormFogLift), 0.0, mix(0.54, 0.88, stormFogLift));
          float heightFog = exp(-max(0.0, vGeoWorldPos.y - 2.0) * 0.135) * smoothstep(32.0, 140.0, geoViewDist) * 0.48;
          float farHorizonFade = smoothstep(380.0, 478.0, geoViewDist) * 0.45;
          float mistFactor = clamp(baseMist + (1.0 - baseMist) * heightFog, 0.0, 0.78);
          mistFactor = clamp(mistFactor + (1.0 - mistFactor) * farHorizonFade, 0.0, 0.88);

          float viewUp = clamp(geoViewRay.y, 0.0, 1.0);
          float sunUpH = smoothstep(-0.05, 0.16, geoSunDirW.y);
          float noonWarmH = smoothstep(0.16, 0.48, geoSunDirW.y);
          float horizonLuma = dot(uHorizonColor, vec3(0.2126, 0.7152, 0.0722));
          float zenithLuma = dot(uZenithColor, vec3(0.2126, 0.7152, 0.0722));
          float brightDayGate = smoothstep(0.34, 0.64, horizonLuma) * smoothstep(0.045, 0.14, zenithLuma) * smoothstep(2.0, 2.7, uSunIntensity) * sunUpH;

          vec3 horizonBase = mix(uHorizonColor, fogColor, 0.28);
          horizonBase = mix(horizonBase, max(horizonBase, vec3(0.94, 0.76, 0.51)), noonWarmH * 0.42 * brightDayGate);

          float mieScatter = pow(max(dot(geoViewRay, geoSunDirW), 0.0), 3.8);
          float antiSunCool = 1.0 - max(dot(geoViewRay, geoSunDirW), 0.0);
          float sunStrH = clamp(uSunIntensity / 2.6, 0.08, 1.25);

          vec3 saffronHaze = mix(uHorizonColor, vec3(0.94, 0.64, 0.34), 0.40) * (0.86 + 0.32 * mieScatter);
          vec3 dustScat = mix(horizonBase, uZenithColor, 0.07 + 0.15 * viewUp + 0.06 * antiSunCool * (1.0 - sunUpH * 0.40));
          dustScat = mix(dustScat, saffronHaze, clamp(heightFog * 0.85, 0.0, 0.45) * sunUpH * smoothstep(0.22, 0.55, horizonLuma));

          vec3 mistColor = dustScat + uSunColor * (mieScatter * (0.18 + 0.14 * clamp(heightFog * 1.5, 0.0, 1.0)) * sunUpH * sunStrH * smoothstep(0.04, 0.14, zenithLuma + horizonLuma * 0.2));

          gl_FragColor.rgb = mix(gl_FragColor.rgb, mistColor, mistFactor);
        #endif`
      );
  };
  material.customProgramCacheKey = () => 'arrakis-sandstone-v12';
  return material;
}

function enhanceMetalMaterial(material, mode = 'iron', atmoUniforms = FALLBACK_ATMO_UNIFORMS) {
  const dustStrength = mode === 'intake' ? 0.02 : mode === 'brass' ? 0.16 : 0.20;
  const patinaStrength = mode === 'bronze' || mode === 'copper' ? 0.20 : 0.12;
  const intakeShadow = mode === 'intake' ? 1.0 : 0.0;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDustStrength = { value: dustStrength };
    shader.uniforms.uPatinaStrength = { value: patinaStrength };
    shader.uniforms.uIntakeShadow = { value: intakeShadow };
    shader.uniforms.uHorizonColor = atmoUniforms.uHorizonColor;
    shader.uniforms.uSunColor = atmoUniforms.uSunColor;
    shader.uniforms.uZenithColor = atmoUniforms.uZenithColor;
    shader.uniforms.uSunDir = atmoUniforms.uSunDir;
    shader.uniforms.uSunIntensity = atmoUniforms.uSunIntensity;
    shader.uniforms.uFogDensity = atmoUniforms.uFogDensity;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vMetalWorldPos;
        varying vec3 vMetalWorldNormal;`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        vec3 mObjN = objectNormal;
        #ifdef USE_INSTANCING
          mObjN = mat3( instanceMatrix ) * mObjN;
        #endif
        vMetalWorldNormal = normalize( mat3( modelMatrix ) * mObjN );`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 mWp = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mWp = instanceMatrix * mWp;
        #endif
        vMetalWorldPos = ( modelMatrix * mWp ).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uDustStrength;
        uniform float uPatinaStrength;
        uniform float uIntakeShadow;
        uniform vec3 uHorizonColor;
        uniform vec3 uSunColor;
        uniform vec3 uZenithColor;
        uniform vec3 uSunDir;
        uniform float uSunIntensity;
        uniform float uFogDensity;
        varying vec3 vMetalWorldPos;
        varying vec3 vMetalWorldNormal;
        ${NOISE_GLSL}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float pat = fbm3(vMetalWorldPos * 2.6);
        float fine = vnoise3(vMetalWorldPos * 14.0);
        float grit = vnoise3(vMetalWorldPos * 32.0);
        vec3 nM = normalize(vMetalWorldNormal);

        // Brutalist weathered Arrakis industrial patina: sand-scoured pitting & subtle oxidation
        diffuseColor.rgb *= (0.90 + 0.22 * fine) * (0.95 + 0.12 * grit);
        float oxMask = smoothstep(0.42, 0.86, pat);
        diffuseColor.rgb *= mix(1.0, 0.82, oxMask * uPatinaStrength);

        // Subtle windblown desert dust resting on upward collars & shelves
        float dustCatch = smoothstep(0.50, 0.92, nM.y) * (0.45 + 0.55 * pat);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.48, 0.29, 0.14), dustCatch * uDustStrength);`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float mRough = fbm3(vMetalWorldPos * 5.2);
        roughnessFactor = clamp(roughnessFactor + (mRough - 0.5) * 0.10, 0.54, 0.95);`
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        // Calibrated Arrakis sand/sky diffuse bounce & rough bevel sheen (recessed shadow throat dampened)
        float cavityDamp = mix(1.0, 0.36, uIntakeShadow);
        vec3 V_view = normalize(vViewPosition);
        vec3 R_view = reflect(-V_view, normal);
        vec3 R_world = normalize((vec4(R_view, 0.0) * viewMatrix).xyz);
        vec3 envSand = vec3(0.36, 0.19, 0.08);
        vec3 envHorizon = uHorizonColor * 0.52;
        vec3 envSky = uZenithColor * 0.48;
        vec3 procEnv = mix(envSand, envHorizon, smoothstep(-0.42, 0.08, R_world.y));
        procEnv = mix(procEnv, envSky, smoothstep(0.08, 0.60, R_world.y));
        float ndv = clamp(dot(normal, V_view), 0.0, 1.0);
        float roughInv = clamp(1.0 - roughnessFactor, 0.0, 1.0);
        float specMask = roughInv * roughInv * 0.42;
        vec3 fresnel = mix(diffuseColor.rgb * 0.85 + vec3(0.04), vec3(0.42), pow(1.0 - ndv, 4.0));
        reflectedLight.indirectSpecular += procEnv * fresnel * specMask * (0.50 + 0.50 * metalnessFactor) * cavityDamp;
        vec3 bounceDiff = mix(vec3(0.32, 0.18, 0.08), uHorizonColor * 0.38, normalize(vMetalWorldNormal).y * 0.5 + 0.5);
        reflectedLight.indirectDiffuse += diffuseColor.rgb * bounceDiff * (0.55 * cavityDamp);
        if (uIntakeShadow > 0.5) {
          reflectedLight.directDiffuse *= 0.34;
          reflectedLight.indirectDiffuse *= 0.44;
        }`
      )
      .replace(
        '#include <fog_fragment>',
        `#ifdef USE_FOG
          vec3 mViewVec = cameraPosition - vMetalWorldPos;
          float mViewDist = length(mViewVec);
          vec3 mViewRay = -mViewVec / max(mViewDist, 0.0001);
          vec3 mSunDirW = normalize(uSunDir);

          float fogDens = max(uFogDensity, 0.0025);
          float distFactor = 1.0 - exp(-pow(mViewDist * fogDens, 1.35));
          float stormFogLift = smoothstep(0.006, 0.013, uFogDensity);
          float baseMist = clamp(distFactor * mix(0.62, 0.92, stormFogLift), 0.0, mix(0.54, 0.88, stormFogLift));
          float heightFog = exp(-max(0.0, vMetalWorldPos.y - 2.0) * 0.135) * smoothstep(32.0, 140.0, mViewDist) * 0.48;
          float mistFactor = clamp(baseMist + (1.0 - baseMist) * heightFog, 0.0, 0.78);

          float viewUp = clamp(mViewRay.y, 0.0, 1.0);
          float sunUpH = smoothstep(-0.05, 0.16, mSunDirW.y);
          float noonWarmH = smoothstep(0.16, 0.48, mSunDirW.y);
          float horizonLuma = dot(uHorizonColor, vec3(0.2126, 0.7152, 0.0722));
          float zenithLuma = dot(uZenithColor, vec3(0.2126, 0.7152, 0.0722));
          float brightDayGate = smoothstep(0.34, 0.64, horizonLuma) * smoothstep(0.045, 0.14, zenithLuma) * smoothstep(2.0, 2.7, uSunIntensity) * sunUpH;

          vec3 horizonBase = mix(uHorizonColor, fogColor, 0.28);
          horizonBase = mix(horizonBase, max(horizonBase, vec3(0.94, 0.76, 0.51)), noonWarmH * 0.42 * brightDayGate);

          float mieScatter = pow(max(dot(mViewRay, mSunDirW), 0.0), 3.8);
          float antiSunCool = 1.0 - max(dot(mViewRay, mSunDirW), 0.0);
          float sunStrH = clamp(uSunIntensity / 2.6, 0.08, 1.25);

          vec3 saffronHaze = mix(uHorizonColor, vec3(0.94, 0.64, 0.34), 0.40) * (0.86 + 0.32 * mieScatter);
          vec3 dustScat = mix(horizonBase, uZenithColor, 0.07 + 0.15 * viewUp + 0.06 * antiSunCool * (1.0 - sunUpH * 0.40));
          dustScat = mix(dustScat, saffronHaze, clamp(heightFog * 0.85, 0.0, 0.45) * sunUpH * smoothstep(0.22, 0.55, horizonLuma));

          vec3 mistColor = dustScat + uSunColor * (mieScatter * (0.18 + 0.14 * clamp(heightFog * 1.5, 0.0, 1.0)) * sunUpH * sunStrH * smoothstep(0.04, 0.14, zenithLuma + horizonLuma * 0.2));

          gl_FragColor.rgb = mix(gl_FragColor.rgb, mistColor, mistFactor);
        #endif`
      );
  };
  material.customProgramCacheKey = () => 'arrakis-metal-v8';
  return material;
}

// ---------------------------------------------------------------------------
// 1. Four Starkly Distinct Angular Geological Archetypes + Dense Talus Aprons
// ---------------------------------------------------------------------------

function smoothStepQuant(val, bands = 3.0, halfWidth = 0.28) {
  const x = val * bands;
  const fl = Math.floor(x);
  const fr = x - fl;
  return fl + smoothstep(0.5 - halfWidth, 0.5 + halfWidth, fr);
}

function makeRockVertexColor(outColor, t, bedCoord, notchDark, fissureDark, capFactor) {
  const cSandstone = new THREE.Color(0xc58d59);
  const cOchre = new THREE.Color(0xae7241);
  const cTerracotta = new THREE.Color(0x945932);
  const cIronMute = new THREE.Color(0x6b3e23);
  const cPaleCap = new THREE.Color(0xd5a573);

  // Subtle non-uniform sandstone bedding modulation (eliminates repetitive zebra stripes)
  const strataWave = Math.sin(bedCoord * 7.2 + Math.sin(bedCoord * 3.1) * 1.2) * 0.5 + 0.5;
  const strataFine = Math.sin(bedCoord * 13.5 + 1.1) * 0.5 + 0.5;
  const strataBand = strataWave * 0.72 + strataFine * 0.28;
  outColor.copy(cSandstone).lerp(cOchre, smoothstep(0.22, 0.78, strataBand) * 0.34);
  if (notchDark > 0.03) {
    outColor.lerp(cTerracotta, clamp(notchDark * 0.38, 0, 0.44));
  }
  if (fissureDark > 0.03) {
    outColor.lerp(cIronMute, clamp(fissureDark * 0.50, 0, 0.52));
  }
  if (capFactor > 0.01) {
    outColor.lerp(cPaleCap, clamp(capFactor * 0.24, 0, 0.24));
  }
  const ao = clamp(
    0.82 + 0.18 * (1.0 - notchDark * 0.28 - fissureDark * 0.36) * (0.64 + 0.36 * t),
    0.54,
    1.0
  );
  outColor.multiplyScalar(ao);
}

/**
 * Helper to sculpt an asymmetric angular sandstone cliff massif / terrace with
 * diagonal tectonic shear, multi-octave fluted strata benches, concave wind hollows,
 * deep vertical fault fissures, and smooth continuous eroded crown terraces.
 */
function buildCleavedMesaMassif({
  seed,
  rx,
  rz,
  height,
  ox = 0,
  oz = 0,
  shearX = 0,
  shearZ = 0,
  numPlanes = 9,
  hasCrownStep = true,
  tiltSlope = 0.09
}) {
  const rand = mulberry32(seed);
  const offX = rand() * 40 + 3.0;
  const offZ = rand() * 40 + 7.0;

  const pCos = [];
  const pSin = [];
  const pDist = [];
  const a0 = rand() * Math.PI * 2;
  for (let p = 0; p < numPlanes; p++) {
    const a = a0 + (p / numPlanes) * Math.PI * 2 + (rand() - 0.5) * 0.36;
    pCos.push(Math.cos(a));
    pSin.push(Math.sin(a));
    pDist.push(0.66 + rand() * 0.34);
  }
  const cleftAng1 = a0 + 0.48 + rand() * 0.42;
  const cleftAng2 = a0 + 1.65 + rand() * 0.45;
  const cleftAng3 = a0 + 2.95 + rand() * 0.48;
  const cleftAng4 = a0 + 4.22 + rand() * 0.45;
  const cleftAng5 = a0 + 5.38 + rand() * 0.40;

  const hStops = [
    0.00, 0.04, 0.08, 0.13, 0.18,
    0.24, 0.28, 0.305, 0.33, 0.36, 0.40,
    0.45, 0.50, 0.54, 0.575, 0.61, 0.66,
    0.71, 0.755, 0.785, 0.82, 0.86,
    0.90, 0.935, 0.965, 0.985, 1.00
  ];
  const radialSegs = 80;
  const rings = [];
  const tmpColor = new THREE.Color();

  const dipAng = rand() * Math.PI * 2;
  const dipX = Math.cos(dipAng);
  const dipZ = Math.sin(dipAng);
  const windAng = dipAng * 0.45 + 0.32;
  const windX = Math.cos(windAng);
  const windZ = Math.sin(windAng);
  const perpX = -windZ;
  const perpZ = windX;
  const splitAng = dipAng + 1.15 + (rand() - 0.5) * 0.6;
  const splitCos = Math.cos(splitAng);
  const splitSin = Math.sin(splitAng);

  for (let hi = 0; hi < hStops.length; hi++) {
    const t = hStops[hi];
    const ring = [];

    // Aerodynamic Yardang tapering & concave wind-scoured strata shelves (zero blocky voxel steps!)
    const baseFlare = Math.pow(1.0 - smoothstep(0.0, 0.28, t), 1.40) * 0.44;
    const midTaper = mix(1.06, 0.78, smoothstep(0.08, 0.62, t));
    const crownTaper = smoothstep(0.58, 1.0, t) * 0.34;
    const upperTaper = midTaper - crownTaper;
    const shelf1 = Math.exp(-Math.pow((t - 0.365) / 0.036, 2.0)) * 0.048;
    const shelf2 = Math.exp(-Math.pow((t - 0.605) / 0.034, 2.0)) * 0.044;
    const shelf3 = Math.exp(-Math.pow((t - 0.820) / 0.032, 2.0)) * 0.034;
    const notch1 = Math.exp(-Math.pow((t - 0.300) / 0.036, 2.0)) * 0.095;
    const notch2 = Math.exp(-Math.pow((t - 0.540) / 0.034, 2.0)) * 0.088;
    const notch3 = Math.exp(-Math.pow((t - 0.758) / 0.030, 2.0)) * 0.068;
    const baseNotch = notch1 + notch2 + notch3;

    const rockMask = smoothstep(0.08, 0.22, t);
    const crownFluteMask = smoothstep(0.10, 0.28, t) * (1.0 - smoothstep(0.95, 1.0, t) * 0.32);

    for (let si = 0; si < radialSegs; si++) {
      const theta = (si / radialSegs) * Math.PI * 2;
      const cx = Math.cos(theta);
      const sz = Math.sin(theta);

      // Rounded multi-plane sandstone cleavage yielding crisp natural cliff ribs without boxy polygons
      let planform = 1.45;
      for (let p = 0; p < numPlanes; p++) {
        const d = cx * pCos[p] + sz * pSin[p];
        if (d > 0.12) {
          planform = smin(planform, pDist[p] / d, 0.048);
        }
      }
      planform = clamp(planform, 0.56, 1.14);

      const along = cx * windX + sz * windZ;
      const perp = cx * perpX + sz * perpZ;
      // Stronger concave wind-scouring on the windward prow & flanks
      const windExposure = 0.58 + 0.42 * smoothstep(-0.45, 0.65, -along);
      const totalNotch = baseNotch * windExposure;

      // Narrow upper shoulders transversely to carve an elongated windward prow crest
      const prowPinch = 1.0 - smoothstep(0.42, 1.0, t) * (0.28 * Math.pow(Math.abs(perp), 1.35));
      const prowLead = along < 0.0 ? -along * 0.14 * smoothstep(0.24, 0.88, t) * (1.0 - smoothstep(0.88, 1.0, t) * 0.55) : 0.0;
      const profileScale = (upperTaper + baseFlare + shelf1 + shelf2 + shelf3 - totalNotch) * prowPinch + prowLead;
      const notchDark = totalNotch * 8.5;

      // Asymmetric directional cliff terrace sloping organically into the flank
      const dirSide = cx * dipX + sz * dipZ;
      const terraceShelf = dirSide > 0.0 ? smoothstep(0.08, 0.78, 1.0 - t) * 0.10 * dirSide : 0.0;

      // Sharp horizontal sedimentary shelf ribs & wind-carved undercut ledges
      const strataPhase = t * 23.0 + Math.sin(theta * 2.0 + offX) * 0.16 + dirSide * 0.45;
      const sawShelf =
        Math.sin(strataPhase) + 0.36 * Math.sin(strataPhase * 2.0 - 0.45) + 0.14 * Math.sin(strataPhase * 3.0 - 0.85);
      const strataRib = sawShelf * 0.012 * rockMask;
      const ribRecess = Math.max(0.0, -sawShelf) * 0.32 * rockMask;

      // Deep concave wind-scoured lateral alcoves & continuous irregular vertical fluting all the way up the crown
      const fluteNoise = fbm3(cx * 3.0 + offX, t * 1.15, sz * 3.0 + offZ, 3);
      const hollowMask =
        smoothstep(0.48, 0.80, fluteNoise) *
        smoothstep(0.16, 0.38, t) *
        (1.0 - smoothstep(0.84, 0.98, t) * 0.55);
      const windHollow = hollowMask * 0.074;
      const fluteRidge = ridged3(cx * 4.2 + offX, t * 0.32, sz * 4.2 + offZ, 2) - 0.38;
      const fluteGroove = Math.sin(theta * 9.0 + offX * 1.7 + t * 1.4) * 0.28 + Math.cos(theta * 14.0 - offZ) * 0.22;
      const verticalFlute = (fluteRidge * 0.048 + fluteGroove * 0.016) * crownFluteMask;

      const dC1 = Math.abs(Math.sin(theta - cleftAng1));
      const dC2 = Math.abs(Math.sin(theta - cleftAng2));
      const dC3 = Math.abs(Math.sin(theta - cleftAng3));
      const dC4 = Math.abs(Math.sin(theta - cleftAng4));
      const dC5 = Math.abs(Math.sin(theta - cleftAng5));
      // Deep irregular V-notch vertical geological joint fissures slicing cleanly through upper shoulders & crown
      const cleft =
        (Math.pow(Math.max(0, 1.0 - dC1 / 0.105), 1.35) * 0.36 +
          Math.pow(Math.max(0, 1.0 - dC2 / 0.095), 1.35) * 0.30 +
          Math.pow(Math.max(0, 1.0 - dC3 / 0.088), 1.35) * 0.25 +
          Math.pow(Math.max(0, 1.0 - dC4 / 0.082), 1.35) * 0.21 +
          Math.pow(Math.max(0, 1.0 - dC5 / 0.076), 1.35) * 0.17) *
        smoothstep(0.12, 0.30, t);

      const grain = (fbm3(cx * 2.6 + offX, t * 2.0, sz * 2.6 + offZ, 2) - 0.5) * 0.022 * crownFluteMask;
      const rFactor = Math.max(
        0.22,
        (mix(1.0, planform, 0.45 + 0.55 * rockMask) +
          terraceShelf +
          strataRib +
          verticalFlute -
          windHollow -
          cleft +
          grain) *
          profileScale
      );

      const diagShiftX = (t - 0.25) * shearX * rockMask;
      const diagShiftZ = (t - 0.25) * shearZ * rockMask;
      const px = ox + cx * rx * rFactor + diagShiftX;
      const pz = oz + sz * rz * rFactor + diagShiftZ;

      let py = t * height;
      if (t < 0.08) {
        py -= (1.0 - t / 0.08) * 0.94;
      } else {
        // Tapered wind-blasted Yardang crown prow crest with deep fissure rim notches (zero boxy flat tabletop!)
        const rimDrop = cleft * 0.58 * smoothstep(0.56, 1.0, t);
        const capDip = (cx * dipX + sz * dipZ) * height * tiltSlope * smoothstep(0.52, 1.0, t);
        const prowCrest = (-along * 0.13 - Math.abs(perp) * 0.065) * height * smoothstep(0.54, 1.0, t);
        const crownTier = hasCrownStep
          ? smoothstep(-0.12, 0.20, cx * splitCos + sz * splitSin) * (height * 0.062) * smoothstep(0.76, 0.96, t)
          : 0.0;
        const crownErode = (fbm3(px * 0.85 + offX, 2.1, pz * 0.85 + offZ, 2) - 0.5) * 0.085 * smoothstep(0.76, 1.0, t);
        py = py + capDip + prowCrest + crownTier + crownErode - rimDrop;
      }

      const bedCoord = t + (px * dipX + pz * dipZ) * 0.032;
      const capFactor = smoothstep(0.80, 0.98, t);
      const localNotchDark = notchDark + ribRecess + windHollow * 2.6;
      makeRockVertexColor(tmpColor, t, bedCoord, localNotchDark, cleft * 2.8, capFactor);

      ring.push({ x: px, y: py, z: pz, r: tmpColor.r, g: tmpColor.g, b: tmpColor.b });
    }
    rings.push(ring);
  }

  const topShiftX = ox + 0.75 * shearX;
  const topShiftZ = oz + 0.75 * shearZ;
  const topCenterColor = new THREE.Color();
  makeRockVertexColor(
    topCenterColor,
    1.0,
    1.0 + (topShiftX * dipX + topShiftZ * dipZ) * 0.032,
    0.06,
    0.0,
    0.85
  );
  const botCenterColor = new THREE.Color();
  makeRockVertexColor(botCenterColor, 0.0, (ox * dipX + oz * dipZ) * 0.032, 0.24, 0.0, 0.0);
  const topCenter = {
    x: topShiftX - windX * rx * 0.12,
    y: height * (hasCrownStep ? 1.035 : 0.99),
    z: topShiftZ - windZ * rz * 0.12,
    r: topCenterColor.r,
    g: topCenterColor.g,
    b: topCenterColor.b
  };
  const botCenter = {
    x: ox,
    y: -0.96,
    z: oz,
    r: botCenterColor.r,
    g: botCenterColor.g,
    b: botCenterColor.b
  };
  return buildLoftedPrism(rings, topCenter, botCenter);
}

/**
 * Archetype 1: Dramatic Asymmetric Wind-Carved Sandstone Yardang Monolith
 * Tapered windward prow crests, concave wind-undercut strata shelves,
 * deep irregular vertical fissures/flutes, and streamlined flanking spurs.
 */
function createCaprockMesaGeometry(seed) {
  const rand = mulberry32(seed);
  const mainH = 4.65 + rand() * 0.55;
  const mainRx = 1.98 + rand() * 0.22;
  const mainRz = 1.54 + rand() * 0.20;
  const parts = [];

  // 1) Primary towering wind-carved Yardang monolith with swept prow crest & deep vertical joint fissures
  parts.push(
    buildCleavedMesaMassif({
      seed: seed + 11,
      rx: mainRx,
      rz: mainRz,
      height: mainH,
      ox: -0.26,
      oz: -0.10,
      shearX: 0.22 + (rand() - 0.5) * 0.22,
      shearZ: -0.14 + (rand() - 0.5) * 0.18,
      numPlanes: 9,
      hasCrownStep: true,
      tiltSlope: 0.12
    })
  );

  // 2) Tapered wind-sloped flank shoulder buttress flowing seamlessly off leeward/side flank
  parts.push(
    buildCleavedMesaMassif({
      seed: seed + 57,
      rx: mainRx * 0.74,
      rz: mainRz * 0.72,
      height: mainH * (0.44 + rand() * 0.08),
      ox: 0.96 + (rand() - 0.5) * 0.18,
      oz: -0.26 + (rand() - 0.5) * 0.18,
      shearX: 0.20,
      shearZ: -0.14,
      numPlanes: 8,
      hasCrownStep: false,
      tiltSlope: 0.20
    })
  );

  // 3) Low eroded basal windward spur breaking up base footprint organically
  parts.push(
    buildCleavedMesaMassif({
      seed: seed + 109,
      rx: mainRx * 0.62,
      rz: mainRz * 0.62,
      height: mainH * (0.31 + rand() * 0.07),
      ox: -1.16 + (rand() - 0.5) * 0.20,
      oz: 0.72 + (rand() - 0.5) * 0.20,
      shearX: -0.16,
      shearZ: 0.12,
      numPlanes: 7,
      hasCrownStep: false,
      tiltSlope: 0.18
    })
  );

  const merged = mergePreparedParts(parts);
  computeCreasedNormals(merged, 36);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Archetype 2: Sleek Wind-Fluted Desert Razor Fin (Yardang Hogback)
 * Narrow elongated knife-blade geometry with deep wind-abrasion undercuts,
 * fluted strata ribs, asymmetric leaning prow, and serrated dorsal spine.
 */
function createKnifeFinYardangGeometry(seed) {
  const rand = mulberry32(seed);
  const offX = rand() * 40 + 11.0;
  const offZ = rand() * 40 + 19.0;

  const length = 5.8 + rand() * 1.65;
  const maxHalfW = 0.56 + rand() * 0.16;
  const maxHeight = 2.35 + rand() * 0.65;
  const uSegs = 56;

  const crossSteps = [
    { side: -1, h: 0.00, wMult: 1.24, yDrop: -0.90 },
    { side: -1, h: 0.10, wMult: 1.00, yDrop: 0.0 },
    { side: -1, h: 0.22, wMult: 0.78, yDrop: 0.0 },
    { side: -1, h: 0.34, wMult: 0.62, yDrop: 0.0 },
    { side: -1, h: 0.44, wMult: 0.69, yDrop: 0.0 },
    { side: -1, h: 0.56, wMult: 0.54, yDrop: 0.0 },
    { side: -1, h: 0.68, wMult: 0.41, yDrop: 0.0 },
    { side: -1, h: 0.79, wMult: 0.26, yDrop: 0.0 },
    { side: -1, h: 0.89, wMult: 0.15, yDrop: 0.0 },
    { side: -1, h: 0.96, wMult: 0.06, yDrop: 0.0 },
    { side:  0, h: 1.00, wMult: 0.022, yDrop: 0.0 },
    { side:  1, h: 0.96, wMult: 0.06, yDrop: 0.0 },
    { side:  1, h: 0.89, wMult: 0.16, yDrop: 0.0 },
    { side:  1, h: 0.79, wMult: 0.28, yDrop: 0.0 },
    { side:  1, h: 0.68, wMult: 0.44, yDrop: 0.0 },
    { side:  1, h: 0.56, wMult: 0.58, yDrop: 0.0 },
    { side:  1, h: 0.44, wMult: 0.72, yDrop: 0.0 },
    { side:  1, h: 0.34, wMult: 0.60, yDrop: 0.0 },
    { side:  1, h: 0.22, wMult: 0.80, yDrop: 0.0 },
    { side:  1, h: 0.10, wMult: 1.02, yDrop: 0.0 },
    { side:  1, h: 0.00, wMult: 1.28, yDrop: -0.90 }
  ];

  const stations = [];
  const tmpColor = new THREE.Color();
  const prowLean = 0.52 + rand() * 0.24;
  const ridgeSway = (rand() - 0.5) * 0.40;
  const finTilt = (rand() - 0.5) * 0.24;

  let prowZ = 0;
  let tailZ = 0;

  for (let ui = 0; ui <= uSegs; ui++) {
    const u = ui / uSegs;
    let crestH;
    if (u < 0.22) {
      const p = clamp(u / 0.22, 0.0, 1.0);
      crestH = 0.14 + 0.86 * Math.pow(p, 0.86);
    } else if (u < 0.34) {
      const p = (u - 0.22) / 0.12;
      crestH = mix(1.0, 0.88, p);
    } else {
      const p = clamp((u - 0.34) / 0.66, 0.0, 1.0);
      crestH = 0.88 * Math.pow(Math.max(0, 1.0 - p), 1.15);
    }
    const notch1 = Math.exp(-Math.pow((u - 0.48) / 0.042, 2.0)) * 0.16;
    const notch2 = Math.exp(-Math.pow((u - 0.72) / 0.040, 2.0)) * 0.14;
    crestH = Math.max(0.08, crestH - notch1 - notch2);

    const tipPinch = smoothstep(0.0, 0.06, u) * smoothstep(1.0, 0.90, u);
    const localHalfW = maxHalfW * mix(0.08, 1.0, Math.pow(tipPinch, 0.55) * (1.0 - u * 0.24));
    const localH = maxHeight * crestH;

    const centerZ = Math.sin(u * Math.PI * 1.25) * ridgeSway * tipPinch;
    if (ui === 0) prowZ = centerZ;
    if (ui === uSegs) tailZ = centerZ;
    const baseX = (u - 0.42) * length;

    const ring = [];
    for (let vi = 0; vi < crossSteps.length; vi++) {
      const cs = crossSteps[vi];
      const diagUndercutShift = cs.side * 0.055 * Math.sin(u * 5.2 + offX);
      const bedH = clamp(cs.h + diagUndercutShift, 0.0, 1.0);
      const prowOverhang = (1.0 - smoothstep(0.0, 0.28, u)) * prowLean * Math.pow(cs.h, 1.10);

      const px = baseX - prowOverhang;
      const py = cs.h * localH + cs.yDrop;

      const rockMask = smoothstep(0.12, 0.85, cs.h);
      const blockFacet =
        smoothStepQuant(vnoise3(px * 1.2 + offX, cs.h * 2.0, cs.side * 1.5 + offZ), 3.0, 0.30) *
        0.032 *
        rockMask;
      const strataFlute = Math.sin(cs.h * 22.0 + u * 3.5 + offX) * 0.028 * rockMask;
      const micro = (fbm3(px * 2.4 + offX, py * 2.4, cs.side * 1.5 + offZ, 3) - 0.5) * 0.064 * smoothstep(0.10, 0.45, cs.h);
      const zOff = cs.side * localHalfW * Math.max(0.020, cs.wMult + blockFacet + strataFlute + micro) + cs.h * finTilt * 0.42;
      const pz = centerZ + zOff;

      const isUndercut = Math.exp(-Math.pow((cs.h - 0.34) / 0.08, 2.0)) + Math.max(0, -strataFlute * 12.0);
      const capFactor = smoothstep(0.80, 1.0, cs.h);
      makeRockVertexColor(tmpColor, cs.h, bedH * 0.6 + u * 0.18, isUndercut * 0.28, 0.0, capFactor);

      ring.push({ x: px, y: py, z: pz, r: tmpColor.r, g: tmpColor.g, b: tmpColor.b });
    }
    stations.push(ring);
  }

  const positions = [];
  const colors = [];
  const uvs = [];
  const pushV = (v, uCoord, vCoord) => {
    positions.push(v.x, v.y, v.z);
    colors.push(v.r, v.g, v.b);
    uvs.push(uCoord, vCoord);
  };

  const sLen = crossSteps.length;
  for (let ui = 0; ui < uSegs; ui++) {
    const rA = stations[ui];
    const rB = stations[ui + 1];
    const u0 = ui / uSegs;
    const u1 = (ui + 1) / uSegs;
    for (let vi = 0; vi < sLen; vi++) {
      const viNext = (vi + 1) % sLen;
      const a = rA[vi];
      const b = rB[vi];
      const c = rB[viNext];
      const d = rA[viNext];
      const v0 = vi / sLen;
      const v1 = (vi + 1) / sLen;

      pushV(a, u0, v0);
      pushV(d, u0, v1);
      pushV(b, u1, v0);

      pushV(d, u0, v1);
      pushV(c, u1, v1);
      pushV(b, u1, v0);
    }
  }

  const prowColor = new THREE.Color();
  makeRockVertexColor(prowColor, 0.14, 0.08, 0.18, 0.0, 0.0);
  const tailColor = new THREE.Color();
  makeRockVertexColor(tailColor, 0.12, 0.26, 0.18, 0.0, 0.0);
  const prowCenter = {
    x: -0.42 * length - 0.08,
    y: -0.10,
    z: prowZ,
    r: prowColor.r,
    g: prowColor.g,
    b: prowColor.b
  };
  const tailCenter = {
    x: 0.58 * length + 0.06,
    y: -0.16,
    z: tailZ,
    r: tailColor.r,
    g: tailColor.g,
    b: tailColor.b
  };
  const prowRing = stations[0];
  const tailRing = stations[uSegs];
  for (let vi = 0; vi < sLen; vi++) {
    const viNext = (vi + 1) % sLen;
    pushV(prowCenter, 0, 0.5);
    pushV(prowRing[viNext], 0, viNext / sLen);
    pushV(prowRing[vi], 0, vi / sLen);
    pushV(tailCenter, 1, 0.5);
    pushV(tailRing[vi], 1, vi / sLen);
    pushV(tailRing[viNext], 1, viNext / sLen);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  computeCreasedNormals(geom, 35);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Archetype 3: Stratified Eroded Tilted Bedrock Scarp Slab Cluster
 * Gently dipping multi-layered sandstone shelves with fluted strata ribs,
 * wind-hollowed benches, deeply buried root skirts, and organic irregular silhouettes.
 */
function createTiltedCuestaGeometry(seed) {
  const rand = mulberry32(seed);
  const offX = rand() * 40 + 23.0;
  const offZ = rand() * 40 + 31.0;

  const dipAngle = 0.36 + (rand() - 0.5) * 0.10;
  const parts = [];
  const tmpColor = new THREE.Color();

  const slabConfigs = [
    { w: 2.15 + rand() * 0.38, d: 0.96 + rand() * 0.18, thick: 0.74, offX: 0.04, offY: 0.04, offZ: -0.06, shearScarp: 0.20, yaw: 0.0 },
    { w: 1.68 + rand() * 0.30, d: 0.78 + rand() * 0.16, thick: 0.56, offX: -0.36, offY: 0.54, offZ: 0.30, shearScarp: 0.22, yaw: (rand() - 0.5) * 0.38 },
    { w: 1.38 + rand() * 0.24, d: 0.80 + rand() * 0.16, thick: 0.50, offX: 0.34, offY: -0.06, offZ: -0.52, shearScarp: 0.16, yaw: 0.42 + (rand() - 0.5) * 0.32 },
    { w: 1.52 + rand() * 0.26, d: 0.92 + rand() * 0.18, thick: 0.44, offX: 0.54, offY: -0.24, offZ: 0.22, shearScarp: 0.12, yaw: -0.35 + (rand() - 0.5) * 0.28 }
  ];

  const hStops = [
    0.0, 0.06, 0.12, 0.18, 0.24, 0.31,
    0.38, 0.45, 0.52, 0.59, 0.66, 0.73,
    0.80, 0.86, 0.91, 0.95, 0.98, 1.0
  ];
  const radialSegs = 52;

  for (let si = 0; si < slabConfigs.length; si++) {
    const cfg = slabConfigs[si];
    const pRand = mulberry32(seed + si * 97);
    const numCleaves = 8;
    const fCos = [];
    const fSin = [];
    const fDist = [];
    const aBase = pRand() * 0.50 - 0.25;
    for (let f = 0; f < numCleaves; f++) {
      const a = aBase + (f / numCleaves) * Math.PI * 2 + (pRand() - 0.5) * 0.28;
      fCos.push(Math.cos(a));
      fSin.push(Math.sin(a));
      fDist.push(f === 0 ? 0.72 : 0.76 + pRand() * 0.24);
    }

    const notchTheta1 = pRand() * Math.PI * 2;
    const notchTheta2 = notchTheta1 + 1.9 + pRand() * 0.8;
    const rings = [];
    const cy = Math.cos(cfg.yaw);
    const sy = Math.sin(cfg.yaw);

    for (let hi = 0; hi < hStops.length; hi++) {
      const t = hStops[hi];
      const ring = [];
      const rockMask = smoothstep(0.14, 0.34, t);
      const basePlinth = 1.0 + (1.0 - smoothstep(0.0, 0.24, t)) * 0.22;
      const lipEdge = t > 0.94 ? mix(1.0, 0.94, (t - 0.94) / 0.06) : 1.0;
      const bedIndent = Math.exp(-Math.pow((t - 0.52) / 0.10, 2.0)) * 0.068;

      for (let ri = 0; ri < radialSegs; ri++) {
        const theta = (ri / radialSegs) * Math.PI * 2;
        const cx = Math.cos(theta);
        const sz = Math.sin(theta);

        let polyR = 1.40;
        for (let f = 0; f < numCleaves; f++) {
          const d = cx * fCos[f] + sz * fSin[f];
          if (d > 0.12) {
            polyR = smin(polyR, fDist[f] / d, 0.048);
          }
        }

        const dN1 = Math.abs(Math.sin(theta - notchTheta1));
        const dN2 = Math.abs(Math.sin(theta - notchTheta2));
        const scarpNotch =
          (Math.max(0, 1.0 - dN1 / 0.19) ** 2 * 0.22 +
            Math.max(0, 1.0 - dN2 / 0.16) ** 2 * 0.15) *
          smoothstep(0.38, 0.95, t);

        // Multi-octave sandstone strata ribs & wind-carved hollows across slab flanks
        const strataPhase = t * 20.0 + Math.sin(theta * 2.0 + offX + si) * 0.45;
        const bedWave =
          (Math.sin(strataPhase) * 0.030 + Math.sin(strataPhase * 2.1 + 1.1) * 0.014) * rockMask;
        const windHollow =
          smoothstep(0.45, 0.78, fbm3(cx * 3.4 + offX + si, t * 2.2, sz * 3.4 + offZ, 3)) *
          0.105 *
          smoothstep(0.24, 0.70, t);
        const cragNoise =
          (ridged3(cx * 2.8 + offX + si, t * 2.0, sz * 2.8 + offZ, 3) - 0.38) * 0.072 * rockMask;

        polyR = clamp(polyR, 0.54, 1.08) * lipEdge * basePlinth - bedIndent - scarpNotch;
        const micro = (fbm3(cx * 3.2 + offX + si, t * 2.6, sz * 3.2 + offZ, 3) - 0.5) * 0.055 * rockMask;
        const r = Math.max(0.28, polyR + bedWave - windHollow + cragNoise + micro);

        // Gently round-taper downhill (+x) extremity so no sharp triangle tip pokes onto flat sand
        const downhillEase = cx > 0.15 ? smoothstep(0.15, 0.95, cx) * 0.14 : 0.0;
        const lx = cx * cfg.w * r * (1.0 - downhillEase * 0.35) - (1.0 - t) * cfg.shearScarp;
        let ly = (t - 0.12) * cfg.thick;
        const lz = sz * cfg.d * r;

        if (t < 0.22) {
          ly -= Math.pow(1.0 - t / 0.22, 1.35) * 1.15;
        } else if (t > 0.78) {
          const topBlend = smoothstep(0.78, 1.0, t);
          const terraceBench =
            smoothStepQuant(vnoise3(cx * 1.8 + offX + si, 2.1, sz * 1.8 + offZ), 2.5, 0.32) * 0.042;
          ly += (cx * -0.05 + terraceBench - scarpNotch * 0.34 - downhillEase * 0.38) * topBlend;
        }

        const wxLocal = lx * cy - lz * sy;
        const wzLocal = lx * sy + lz * cy;

        const ca = Math.cos(-dipAngle);
        const sa = Math.sin(-dipAngle);
        const rx = wxLocal * ca - ly * sa + cfg.offX;
        const ry = wxLocal * sa + ly * ca + cfg.offY + 0.38;
        const rz = wzLocal + cfg.offZ;

        const capFactor = t > 0.86 ? 0.72 : 0.0;
        const localNotchDark = bedIndent * 10.0 + Math.max(0, -bedWave * 14.0) + windHollow * 2.8;
        makeRockVertexColor(
          tmpColor,
          clamp(ry / 2.6, 0, 1),
          t * 0.9 + si * 0.35,
          localNotchDark,
          scarpNotch * 2.2,
          capFactor
        );

        ring.push({ x: rx, y: ry, z: rz, r: tmpColor.r, g: tmpColor.g, b: tmpColor.b });
      }
      rings.push(ring);
    }

    const tiltPt = (lx, ly, lz) => {
      const wxLocal = lx * cy - lz * sy;
      const wzLocal = lx * sy + lz * cy;
      const ca = Math.cos(-dipAngle);
      const sa = Math.sin(-dipAngle);
      return {
        x: wxLocal * ca - ly * sa + cfg.offX,
        y: wxLocal * sa + ly * ca + cfg.offY + 0.38,
        z: wzLocal + cfg.offZ
      };
    };
    const tc = tiltPt(0, 0.88 * cfg.thick, 0);
    const bc = tiltPt(0, -0.12 * cfg.thick - 1.18, 0);
    const tcColor = new THREE.Color();
    makeRockVertexColor(tcColor, clamp(tc.y / 2.6, 0, 1), 0.9 + si * 0.35, 0.08, 0.0, 0.72);
    const bcColor = new THREE.Color();
    makeRockVertexColor(bcColor, 0.0, si * 0.35, 0.24, 0.0, 0.0);
    const slabGeom = buildLoftedPrism(
      rings,
      { ...tc, r: tcColor.r, g: tcColor.g, b: tcColor.b },
      { ...bc, r: bcColor.r, g: bcColor.g, b: bcColor.b }
    );
    parts.push(slabGeom);
  }

  const merged = mergePreparedParts(parts);
  computeCreasedNormals(merged, 30);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Archetype 4: Asymmetric Wind-Eroded Sandstone Ledges & Dipping Caprock Fault Outcrops
 * High-resolution stratified bedrock blocks with fluted strata ribs, concave wind hollows,
 * continuous smooth eroded benches, and crisp geological fault crevices.
 */
function createStratifiedCliffLedgeGeometry(seed) {
  const rand = mulberry32(seed);
  const offX = rand() * 40 + 17.0;
  const offZ = rand() * 40 + 41.0;
  const mode = seed % 3;
  const parts = [];
  const tmpColor = new THREE.Color();

  let ledgeConfigs;
  if (mode === 0) {
    ledgeConfigs = [
      { ox: -0.34, oz: -0.14, rx: 1.18, rz: 0.76, h: 2.65 + rand() * 0.35, yaw: 0.25, dip: 0.30, shear: 0.18 },
      { ox:  0.64, oz:  0.20, rx: 1.36, rz: 0.82, h: 1.18 + rand() * 0.22, yaw: -0.55, dip: 0.24, shear: -0.10 },
      { ox: -0.74, oz:  0.54, rx: 1.14, rz: 0.72, h: 1.44 + rand() * 0.24, yaw: 1.05, dip: 0.26, shear: 0.14 }
    ];
  } else if (mode === 1) {
    ledgeConfigs = [
      { ox: -0.42, oz: -0.32, rx: 1.50, rz: 0.68, h: 2.40 + rand() * 0.34, yaw: 0.32, dip: 0.28, shear: 0.20 },
      { ox:  0.56, oz:  0.42, rx: 1.28, rz: 0.64, h: 1.56 + rand() * 0.24, yaw: 0.24, dip: 0.24, shear: 0.14 },
      { ox:  0.10, oz: -0.78, rx: 1.12, rz: 0.66, h: 1.02 + rand() * 0.20, yaw: -0.85, dip: 0.22, shear: -0.10 }
    ];
  } else {
    ledgeConfigs = [
      { ox:  0.08, oz:  0.04, rx: 1.58, rz: 0.82, h: 1.68 + rand() * 0.26, yaw: -0.25, dip: 0.24, shear: 0.14 },
      { ox: -0.58, oz: -0.18, rx: 1.08, rz: 0.68, h: 2.52 + rand() * 0.32, yaw: 0.62, dip: 0.32, shear: -0.18 },
      { ox:  0.86, oz: -0.28, rx: 1.10, rz: 0.70, h: 1.10 + rand() * 0.20, yaw: 1.45, dip: 0.22, shear: 0.10 }
    ];
  }

  const hStops = [
    0.0, 0.07, 0.14, 0.22, 0.29, 0.34, 0.39,
    0.45, 0.51, 0.57, 0.63, 0.68, 0.74,
    0.80, 0.86, 0.92, 0.97, 1.0
  ];
  const radialSegs = 56;

  for (let li = 0; li < ledgeConfigs.length; li++) {
    const cfg = ledgeConfigs[li];
    const lRand = mulberry32(seed + li * 131);
    const numFaces = 7 + (li % 3);
    const fCos = [];
    const fSin = [];
    const fDist = [];
    const a0 = cfg.yaw + lRand() * 0.45;
    for (let f = 0; f < numFaces; f++) {
      const a = a0 + (f / numFaces) * Math.PI * 2 + (lRand() - 0.5) * 0.26;
      fCos.push(Math.cos(a));
      fSin.push(Math.sin(a));
      fDist.push(0.66 + lRand() * 0.30);
    }

    const cleftAng1 = a0 + 0.95 + lRand() * 0.8;
    const cleftAng2 = cleftAng1 + 2.55 + lRand() * 0.7;
    const rings = [];
    const dipX = Math.cos(cfg.yaw + 0.35) * cfg.dip;
    const dipZ = Math.sin(cfg.yaw + 0.35) * cfg.dip;
    const windX = Math.cos(cfg.yaw);
    const windZ = Math.sin(cfg.yaw);
    const perpX = -windZ;
    const perpZ = windX;
    const shearX = Math.cos(cfg.yaw) * cfg.shear;
    const shearZ = Math.sin(cfg.yaw) * cfg.shear;

    for (let hi = 0; hi < hStops.length; hi++) {
      const t = hStops[hi];
      const ring = [];
      // Smoothly tapered wind-eroded yardang pinnacle envelope (zero blocky horizontal step boxes!)
      let wallScale;
      if (t < 0.14) {
        wallScale = mix(1.26, 1.02, t / 0.14);
      } else if (t < 0.52) {
        wallScale = mix(1.02, 0.74, smoothstep(0.14, 0.52, t));
      } else if (t < 0.80) {
        wallScale = mix(0.74, 0.56, smoothstep(0.52, 0.80, t));
      } else {
        wallScale = mix(0.56, 0.34, smoothstep(0.80, 1.0, t));
      }
      const rockMask = smoothstep(0.08, 0.24, t);
      const strataShelf =
        (Math.exp(-Math.pow((t - 0.46) / 0.045, 2.0)) * 0.044 +
          Math.exp(-Math.pow((t - 0.75) / 0.042, 2.0)) * 0.036) *
        rockMask;
      const windNotch =
        (Math.exp(-Math.pow((t - 0.34) / 0.045, 2.0)) * 0.105 +
          Math.exp(-Math.pow((t - 0.63) / 0.042, 2.0)) * 0.085) *
        rockMask;

      for (let ri = 0; ri < radialSegs; ri++) {
        const theta = (ri / radialSegs) * Math.PI * 2;
        const cx = Math.cos(theta);
        const sz = Math.sin(theta);

        let polyR = 1.42;
        for (let f = 0; f < numFaces; f++) {
          const d = cx * fCos[f] + sz * fSin[f];
          if (d > 0.12) {
            polyR = smin(polyR, fDist[f] / d, 0.056);
          }
        }
        polyR = clamp(polyR, 0.52, 1.10);

        const along = cx * windX + sz * windZ;
        const perp = cx * perpX + sz * perpZ;
        const windAspect = 0.55 + 0.45 * smoothstep(-0.4, 0.6, -along);
        const prowNarrow = 1.0 - smoothstep(0.45, 1.0, t) * (0.28 * Math.pow(Math.abs(perp), 1.3));

        const strataPhase = t * 21.0 + Math.sin(theta * 2.0 + offX + li) * 0.38;
        const sawShelf =
          Math.sin(strataPhase) + 0.38 * Math.sin(strataPhase * 2.0 - 0.4) + 0.15 * Math.sin(strataPhase * 3.0 - 0.8);
        const strataRib = sawShelf * 0.022 * rockMask;
        const windHollow =
          smoothstep(0.44, 0.78, fbm3(cx * 3.4 + offX + li, t * 1.6, sz * 3.4 + offZ, 3)) *
          0.115 *
          smoothstep(0.16, 0.42, t) *
          (1.0 - smoothstep(0.84, 0.98, t) * 0.50);
        const vFlute = (ridged3(cx * 4.0 + offX + li, t * 0.35, sz * 4.0 + offZ, 2) - 0.38) * 0.052 * rockMask;
        const dC1 = Math.abs(Math.sin(theta - cleftAng1));
        const dC2 = Math.abs(Math.sin(theta - cleftAng2));
        const cleft =
          (Math.pow(Math.max(0, 1.0 - dC1 / 0.13), 1.45) * 0.28 +
            Math.pow(Math.max(0, 1.0 - dC2 / 0.12), 1.45) * 0.22) *
          smoothstep(0.14, 0.36, t);
        const grain = (fbm3(cx * 2.8 + offX + li, t * 2.2, sz * 2.8 + offZ, 2) - 0.5) * 0.042 * rockMask;

        const r = Math.max(
          0.22,
          (polyR + strataShelf + strataRib + vFlute - windNotch * windAspect - windHollow - cleft + grain) *
            wallScale *
            prowNarrow
        );

        const px = cfg.ox + cx * cfg.rx * r + t * shearX;
        const pz = cfg.oz + sz * cfg.rz * r + t * shearZ;
        let py = t * cfg.h;
        if (t < 0.07) {
          py -= (1.0 - t / 0.07) * 0.94;
        } else if (t > 0.56) {
          const dipBlend = smoothstep(0.56, 1.0, t);
          const relX = px - (cfg.ox + t * shearX);
          const relZ = pz - (cfg.oz + t * shearZ);
          const prowSlope = (-along * 0.16 - Math.abs(perp) * 0.07) * cfg.h * 0.38;
          const rimNoise = (fbm3(px * 1.1 + offX, 1.9, pz * 1.1 + offZ, 2) - 0.5) * 0.045;
          py += (relX * dipX + relZ * dipZ + prowSlope + rimNoise - cleft * 0.58) * dipBlend;
        }

        const localNotchDark =
          windNotch * windAspect * 8.5 + Math.max(0, -sawShelf * 0.42 * rockMask) + windHollow * 3.0;
        makeRockVertexColor(
          tmpColor,
          t,
          t * 0.70 + li * 0.22,
          localNotchDark,
          cleft * 2.6,
          smoothstep(0.82, 1.0, t)
        );
        ring.push({ x: px, y: py, z: pz, r: tmpColor.r, g: tmpColor.g, b: tmpColor.b });
      }
      rings.push(ring);
    }

    const tcColor = new THREE.Color();
    makeRockVertexColor(tcColor, 1.0, 0.70 + li * 0.22, 0.08, 0.0, 0.85);
    const bcColor = new THREE.Color();
    makeRockVertexColor(bcColor, 0.0, li * 0.22, 0.24, 0.0, 0.0);
    const tc = {
      x: cfg.ox + shearX - windX * cfg.rx * 0.10,
      y: cfg.h + 0.06,
      z: cfg.oz + shearZ - windZ * cfg.rz * 0.10,
      r: tcColor.r,
      g: tcColor.g,
      b: tcColor.b
    };
    const bc = {
      x: cfg.ox,
      y: -0.96,
      z: cfg.oz,
      r: bcColor.r,
      g: bcColor.g,
      b: bcColor.b
    };
    parts.push(buildLoftedPrism(rings, tc, bc));
  }

  const merged = mergePreparedParts(parts);
  computeCreasedNormals(merged, 36);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Angular Cleaved Talus Block & Fractured Sandstone Slab Builders (for dense talus skirts)
 */
function createAngularTalusBoulderGeometry(seed, slabMode = false) {
  const rand = mulberry32(seed);
  const geom = new THREE.IcosahedronGeometry(1.0, 2);
  const pos = geom.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  const sx = slabMode ? 1.42 + rand() * 0.42 : 1.18 + rand() * 0.38;
  const sy = slabMode ? 0.38 + rand() * 0.16 : 0.64 + rand() * 0.26;
  const sz = slabMode ? 0.98 + rand() * 0.32 : 0.86 + rand() * 0.28;

  const planes = [];
  const pCount = slabMode ? 7 : 6;
  for (let p = 0; p < pCount; p++) {
    const theta = rand() * Math.PI * 2;
    const phi = slabMode && p < 2 ? (p === 0 ? 1.35 : -1.35) : (rand() - 0.30) * 1.35;
    planes.push({
      nx: Math.cos(theta) * Math.cos(phi),
      ny: Math.sin(phi),
      nz: Math.sin(theta) * Math.cos(phi),
      d: (slabMode && p < 2 ? 0.46 : 0.54) + rand() * 0.24
    });
  }

  const tmpColor = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);

    for (let p = 0; p < planes.length; p++) {
      const pl = planes[p];
      const dot = x * pl.nx + y * pl.ny + z * pl.nz;
      if (dot > pl.d) {
        const excess = dot - pl.d;
        x -= pl.nx * excess;
        y -= pl.ny * excess;
        z -= pl.nz * excess;
      }
    }

    const strata = Math.sin(y * 11.0 + seed) * 0.038;
    const n = (fbm3(x * 2.4 + seed, y * 2.4, z * 2.4 - seed, 2) - 0.5) * 0.14;
    const px = x * sx * (1 + n + strata);
    const py = y * sy * (1 + n * 0.6);
    const pz = z * sz * (1 + n + strata);
    pos.setXYZ(i, px, py, pz);

    const t = clamp((py / sy + 1.0) * 0.5, 0.0, 1.0);
    makeRockVertexColor(tmpColor, t, t * 0.8 + px * 0.2, 0.16 + Math.max(0, -strata * 6.0), 0.0, t * 0.4);
    colors[i * 3] = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
  }

  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  computeCreasedNormals(geom, 35);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

const WIND_ANG = 0.40;
const WIND_COS = Math.cos(WIND_ANG);
const WIND_SIN = Math.sin(WIND_ANG);

function buildRockOutcrops(parentGroup, atmoUniforms = FALLBACK_ATMO_UNIFORMS) {
  const sinkOutcrop = 0.72;
  const rockMat = enhanceSandstoneMaterial(
    createSandstonePhysicalMaterial({
      vertexColors: true,
      roughness: 0.92
    }),
    {
      strataFreq: 9.2,
      bumpStrength: 0.28,
      dustStrength: 0.12,
      varnishStrength: 0.11,
      sandApronStrength: 0.44,
      apronRange: 0.20,
      apronSlopeMin: 0.68,
      baseOffset: sinkOutcrop + 0.02,
      atmoUniforms
    }
  );

  const talusMat = enhanceSandstoneMaterial(
    createSandstonePhysicalMaterial({
      vertexColors: true,
      roughness: 0.92
    }),
    {
      strataFreq: 10.5,
      bumpStrength: 0.22,
      dustStrength: 0.30,
      varnishStrength: 0.08,
      sandApronStrength: 0.84,
      apronRange: 0.24,
      apronSlopeMin: 0.44,
      baseOffset: 0.34,
      atmoUniforms
    }
  );

  const geometries = {
    caprockMesa: [
      createCaprockMesaGeometry(1101),
      createCaprockMesaGeometry(1102),
      createCaprockMesaGeometry(1103)
    ],
    razorRidge: [
      createKnifeFinYardangGeometry(1201),
      createKnifeFinYardangGeometry(1202),
      createKnifeFinYardangGeometry(1203),
      createKnifeFinYardangGeometry(1204)
    ],
    tiltedCuesta: [
      createTiltedCuestaGeometry(1301),
      createTiltedCuestaGeometry(1302),
      createTiltedCuestaGeometry(1303),
      createTiltedCuestaGeometry(1304)
    ],
    cliffLedge: [
      createStratifiedCliffLedgeGeometry(1401),
      createStratifiedCliffLedgeGeometry(1402),
      createStratifiedCliffLedgeGeometry(1403),
      createStratifiedCliffLedgeGeometry(1404)
    ],
    boulder: [
      createAngularTalusBoulderGeometry(1501, false),
      createAngularTalusBoulderGeometry(1502, false),
      createAngularTalusBoulderGeometry(1503, true),
      createAngularTalusBoulderGeometry(1504, false),
      createAngularTalusBoulderGeometry(1505, true),
      createAngularTalusBoulderGeometry(1506, false),
      createAngularTalusBoulderGeometry(1507, true),
      createAngularTalusBoulderGeometry(1508, false)
    ]
  };

  // Curated canyon-rim & southern-backdrop layout: starkly contrasted asymmetric mesas,
  // oblique wind-fluted yardang fins, eroded stratified cuestas, and varied crags.
  const specs = [
    // --- WEST CANYON RIM (Primary focal view in 04_yardang_noon!) ---
    { x: -35.5, z: -4.0, type: 'caprockMesa', sx: 1.48, sy: 1.44, sz: 1.42, yaw: 0.95 },
    { x: -33.5, z: -18.5, type: 'tiltedCuesta', sx: 1.42, sy: 1.28, sz: 1.26, yaw: 0.78 },
    { x: -32.0, z: 9.5, type: 'cliffLedge', sx: 1.42, sy: 1.24, sz: 1.36, yaw: -0.55 },
    { x: -27.5, z: 20.5, type: 'tiltedCuesta', sx: 1.36, sy: 1.24, sz: 1.34, yaw: 0.80 },
    { x: -23.5, z: -13.5, type: 'cliffLedge', sx: 1.10, sy: 1.18, sz: 1.02, yaw: 1.85 },
    { x: -17.2, z: -6.4, type: 'cliffLedge', sx: 1.00, sy: 0.98, sz: 0.94, yaw: -0.75 },
    { x: -14.2, z: 2.2, type: 'tiltedCuesta', sx: 1.00, sy: 0.88, sz: 0.96, yaw: 1.62 },
    { x: -19.8, z: 4.8, type: 'razorRidge', sx: 1.08, sy: 0.86, sz: 1.06, yaw: 0.28 },
    { x: -15.6, z: 12.6, type: 'cliffLedge', sx: 1.02, sy: 0.92, sz: 0.96, yaw: 0.42 },
    { x: -24.0, z: 13.8, type: 'razorRidge', sx: 1.10, sy: 0.98, sz: 1.08, yaw: 0.32 },
    { x: -17.6, z: -10.8, type: 'cliffLedge', sx: 0.88, sy: 0.64, sz: 0.84, yaw: 0.72 },
    { x: -14.8, z: 7.4, type: 'cliffLedge', sx: 0.96, sy: 0.64, sz: 0.88, yaw: 2.35 },

    // --- EAST CANYON RIM (x: +11..+38, broad cleaved cuesta & flanking stepped strata in 01_cistern_dawn far right!) ---
    { x: 33.8, z: -15.5, type: 'cliffLedge', sx: 1.48, sy: 1.32, sz: 1.42, yaw: -0.45 },
    { x: 35.5, z: -1.5, type: 'caprockMesa', sx: 1.50, sy: 1.42, sz: 1.44, yaw: 2.05 },
    { x: 33.0, z: 12.0, type: 'cliffLedge', sx: 1.46, sy: 1.34, sz: 1.40, yaw: 0.75 },
    { x: 27.5, z: 21.5, type: 'tiltedCuesta', sx: 1.40, sy: 1.26, sz: 1.36, yaw: -1.10 },
    { x: 23.0, z: -13.5, type: 'tiltedCuesta', sx: 1.10, sy: 1.04, sz: 1.02, yaw: 0.12 },
    { x: 16.5, z: -7.2, type: 'cliffLedge', sx: 1.06, sy: 0.94, sz: 0.98, yaw: -1.45 },
    { x: 14.8, z: 0.8, type: 'tiltedCuesta', sx: 1.04, sy: 0.84, sz: 0.98, yaw: -1.15 },
    { x: 20.5, z: 5.5, type: 'razorRidge', sx: 1.08, sy: 0.96, sz: 1.06, yaw: 0.48 },
    { x: 15.8, z: 10.2, type: 'tiltedCuesta', sx: 1.04, sy: 0.98, sz: 1.02, yaw: 0.45 },
    { x: 24.5, z: 14.5, type: 'cliffLedge', sx: 1.12, sy: 1.08, sz: 1.12, yaw: 2.40 },
    { x: 14.8, z: -11.4, type: 'tiltedCuesta', sx: 1.28, sy: 0.92, sz: 1.20, yaw: 0.18 },
    { x: 18.2, z: -12.6, type: 'cliffLedge', sx: 1.08, sy: 0.56, sz: 1.02, yaw: -0.65 },
    { x: 13.4, z: 6.2, type: 'cliffLedge', sx: 0.84, sy: 0.70, sz: 0.82, yaw: -0.82 },

    // --- SOUTHERN BACKDROP (z: 10..26, clearing winding path!) ---
    { x: -18.5, z: 22.8, type: 'cliffLedge', sx: 1.36, sy: 1.22, sz: 1.30, yaw: 0.55 },
    { x: -11.5, z: 18.2, type: 'cliffLedge', sx: 1.02, sy: 0.94, sz: 1.00, yaw: 1.32 },
    { x: -9.8, z: 24.4, type: 'tiltedCuesta', sx: 1.12, sy: 1.05, sz: 1.05, yaw: 0.25 },
    { x: 1.2, z: 23.6, type: 'cliffLedge', sx: 1.24, sy: 1.16, sz: 1.18, yaw: -0.35 },
    { x: 10.8, z: 23.8, type: 'tiltedCuesta', sx: 1.30, sy: 1.22, sz: 1.26, yaw: 0.92 },
    { x: 11.2, z: 15.8, type: 'razorRidge', sx: 1.02, sy: 0.94, sz: 0.98, yaw: 0.40 },
    { x: 19.2, z: 22.5, type: 'cliffLedge', sx: 1.14, sy: 1.10, sz: 1.10, yaw: 1.85 },
    { x: -10.8, z: 12.8, type: 'tiltedCuesta', sx: 0.84, sy: 0.80, sz: 0.82, yaw: 0.65 },
    { x: 4.5, z: 18.5, type: 'cliffLedge', sx: 0.86, sy: 0.78, sz: 0.86, yaw: -1.25 },
    { x: 16.5, z: 16.8, type: 'razorRidge', sx: 0.96, sy: 0.90, sz: 0.94, yaw: 0.36 }
  ];

  const placedAnchors = [];
  const rocksGroup = new THREE.Group();
  rocksGroup.name = 'ArrakisGeologyOutcrops';

  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const pool = geometries[s.type];
    const geom = pool[i % pool.length];
    const bbox = geom.boundingBox;
    const rawRx = Math.max(Math.abs(bbox.max.x), Math.abs(bbox.min.x)) * s.sx;
    const rawRz = Math.max(Math.abs(bbox.max.z), Math.abs(bbox.min.z)) * s.sz;
    const footprintR = Math.max(rawRx, rawRz);

    // 1) Central North sightline x in [-11, 11], z < -10
    if (Math.abs(s.x) - footprintR * 0.68 < 11.0 && s.z - footprintR * 0.68 < -10.0) {
      continue;
    }
    // 2) Windtrap path clearance
    if (getPathDistance(s.x, s.z).dist < 2.2 + footprintR * 0.60) {
      continue;
    }
    // 3) Cistern pool clearance
    const centerInfo = getTerrainInfo(s.x, s.z);
    const distCistern = Math.hypot(s.x - CISTERN_CENTER.x, s.z - CISTERN_CENTER.z);
    if (centerInfo.isWater || centerInfo.cisternBowl > 0.08 || distCistern < 7.6 + footprintR * 0.50) {
      continue;
    }
    // 4) Strict Windtrap Bastion (-21, -25) radius >= 7.5m & Thumper (8.5, -14.5) clearance
    if (Math.hypot(s.x + 21, s.z + 25) < 7.5 + footprintR * 0.55) {
      continue;
    }
    if (Math.hypot(s.x - 8.5, s.z + 14.5) < 3.0 + footprintR * 0.50) {
      continue;
    }

    // Ground deeply (-0.72m) using minimum terrain elevation across footprint so zero sides float
    let minH = centerInfo.height;
    for (const frac of [0.45, 0.78, 1.0]) {
      const sampleR = footprintR * frac;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const h = getTerrainInfo(s.x + Math.cos(a) * sampleR, s.z + Math.sin(a) * sampleR).height;
        if (h < minH) minH = h;
      }
    }

    const mesh = new THREE.Mesh(geom, rockMat);
    mesh.position.set(s.x, minH - sinkOutcrop, s.z);
    mesh.rotation.y = s.yaw;
    mesh.scale.set(s.sx, s.sy, s.sz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    rocksGroup.add(mesh);

    placedAnchors.push({ x: s.x, z: s.z, r: footprintR, rx: rawRx, rz: rawRz, type: s.type, yaw: s.yaw });
  }

  // Dense rugged fractured talus boulders & cobbles clustered tightly right across every rock-to-sand intersection
  const talusRand = mulberry32(8421);
  const talusItems = [];
  const talusNormal = new THREE.Vector3();
  const upVec = new THREE.Vector3(0, 1, 0);
  const tiltQuat = new THREE.Quaternion();
  const yawQuat = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const dummy = new THREE.Object3D();

  for (let i = 0; i < placedAnchors.length; i++) {
    const a = placedAnchors[i];
    const cosY = Math.cos(a.yaw);
    const sinY = Math.sin(a.yaw);

    // Inner coarse half-buried angular talus chunks seating the exact rock-to-sand base intersection
    const innerCount = a.type === 'caprockMesa' || a.type === 'tiltedCuesta' ? 24 : a.type === 'cliffLedge' ? 20 : 16;
    for (let k = 0; k < innerCount; k++) {
      const localAng = (k / innerCount) * Math.PI * 2 + (talusRand() - 0.5) * 0.42;
      const lx = Math.cos(localAng) * a.rx * (0.34 + talusRand() * 0.26);
      const lz = Math.sin(localAng) * a.rz * (0.34 + talusRand() * 0.26);
      const rxW = lx * cosY + lz * sinY;
      const rzW = -lx * sinY + lz * cosY;
      const tx = a.x + rxW;
      const tz = a.z + rzW;

      if (getPathDistance(tx, tz).dist < 1.55) continue;
      if (Math.hypot(tx - CISTERN_CENTER.x, tz - CISTERN_CENTER.z) < 7.6) continue;
      if (Math.hypot(tx + 21, tz + 25) < 7.0) continue;
      if (Math.hypot(tx - 8.5, tz + 14.5) < 2.8) continue;
      if (Math.abs(tx) < 9.8 && tz < -10.5) continue;
      if (tx > -16.8 && tx < -13.0 && tz > 4.6 && tz < 7.4) continue;

      const tInfo = getTerrainInfo(tx, tz);
      if (tInfo.isWater) continue;
      getGroundNormal(tx, tz, talusNormal);

      const sizeMult = a.type === 'caprockMesa' ? 1.24 : 0.96;
      const sc = (0.34 + talusRand() * 0.38) * sizeMult;
      talusItems.push({
        variant: (i + k) % geometries.boulder.length,
        x: tx,
        y: tInfo.height - sc * 0.52,
        z: tz,
        nx: talusNormal.x,
        ny: talusNormal.y,
        nz: talusNormal.z,
        yaw: talusRand() * Math.PI * 2,
        sx: sc * (0.94 + talusRand() * 0.44),
        sy: sc * (0.56 + talusRand() * 0.28),
        sz: sc * (0.88 + talusRand() * 0.40)
      });
    }

    // Outer clustered angular talus cobbles tightly buried into base sand aprons (zero stray nubs on open dune)
    const outerCount = a.type === 'caprockMesa' || a.type === 'cliffLedge' ? 22 : 16;
    for (let k = 0; k < outerCount; k++) {
      const localAng = (k / outerCount) * Math.PI * 2 + (talusRand() - 0.5) * 0.52;
      const distFrac = 0.40 + talusRand() * 0.26;
      const lx = Math.cos(localAng) * a.rx * distFrac;
      const lz = Math.sin(localAng) * a.rz * distFrac;
      const rxW = lx * cosY + lz * sinY;
      const rzW = -lx * sinY + lz * cosY;
      const tx = a.x + rxW;
      const tz = a.z + rzW;

      if (getPathDistance(tx, tz).dist < 1.50) continue;
      if (Math.hypot(tx - CISTERN_CENTER.x, tz - CISTERN_CENTER.z) < 7.6) continue;
      if (Math.hypot(tx + 21, tz + 25) < 7.0) continue;
      if (Math.hypot(tx - 8.5, tz + 14.5) < 2.8) continue;
      if (Math.abs(tx) < 10.0 && tz < -10.5) continue;
      if (tx > -17.0 && tx < -12.8 && tz > 4.4 && tz < 7.6) continue;

      const tInfo = getTerrainInfo(tx, tz);
      if (tInfo.isWater) continue;
      getGroundNormal(tx, tz, talusNormal);

      const sizeGrade = clamp(1.24 - distFrac * 0.55, 0.45, 0.96);
      const sc = (0.17 + talusRand() * 0.20) * sizeGrade;
      talusItems.push({
        variant: (i + k * 3) % geometries.boulder.length,
        x: tx,
        y: tInfo.height - sc * 0.62,
        z: tz,
        nx: talusNormal.x,
        ny: talusNormal.y,
        nz: talusNormal.z,
        yaw: talusRand() * Math.PI * 2,
        sx: sc * (0.98 + talusRand() * 0.42),
        sy: sc * (0.44 + talusRand() * 0.20),
        sz: sc * (0.86 + talusRand() * 0.38)
      });
    }
  }

  // Grounded desert sandstone talus blocks clustered softly around Windtrap plinth skirt (-21, -25)
  for (let k = 0; k < 10; k++) {
    const ang = (k / 10) * Math.PI * 2 + (talusRand() - 0.5) * 0.35;
    const dist = 3.55 + talusRand() * 0.95;
    const tx = -21.0 + Math.cos(ang) * dist;
    const tz = -25.0 + Math.sin(ang) * dist;
    if (getPathDistance(tx, tz).dist < 1.85) continue;
    const tInfo = getTerrainInfo(tx, tz);
    getGroundNormal(tx, tz, talusNormal);
    const sc = 0.28 + talusRand() * 0.28;
    talusItems.push({
      variant: k % geometries.boulder.length,
      x: tx,
      y: tInfo.height - sc * 0.38,
      z: tz,
      nx: talusNormal.x,
      ny: talusNormal.y,
      nz: talusNormal.z,
      yaw: talusRand() * Math.PI * 2,
      sx: sc * (1.0 + talusRand() * 0.4),
      sy: sc * (0.62 + talusRand() * 0.24),
      sz: sc * (0.88 + talusRand() * 0.35)
    });
  }

  for (let v = 0; v < geometries.boulder.length; v++) {
    const items = talusItems.filter((item) => item.variant === v);
    if (items.length === 0) continue;
    const im = new THREE.InstancedMesh(geometries.boulder[v], talusMat, items.length);
    im.castShadow = true;
    im.receiveShadow = true;
    for (let j = 0; j < items.length; j++) {
      const it = items[j];
      talusNormal.set(it.nx, it.ny, it.nz).normalize();
      tiltQuat.setFromUnitVectors(upVec, talusNormal);
      yawQuat.setFromAxisAngle(yAxis, it.yaw);
      dummy.position.set(it.x, it.y, it.z);
      dummy.quaternion.copy(tiltQuat).multiply(yawQuat);
      dummy.scale.set(it.sx, it.sy, it.sz);
      dummy.updateMatrix();
      im.setMatrixAt(j, dummy.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
    rocksGroup.add(im);
  }

  parentGroup.add(rocksGroup);
  return placedAnchors;
}

// ---------------------------------------------------------------------------
// 2. Organic Multi-Height Cistern Rim Boulders, Rough Ledges & Clustered Scree
// ---------------------------------------------------------------------------

/**
 * Generates recessed rough-hewn sandstone ledges & partially submerged wading steps
 * with deeply sunk battered footings (-0.74m) and smooth contact bevels (zero dark underside slivers).
 */
function createCisternShelfGeometry(kind, seed) {
  const rand = mulberry32(seed);
  const isLedge = kind === 'ledge';
  const isStep = kind === 'step';
  const off = seed * 2.13;

  const wHalf = isLedge ? 0.68 + rand() * 0.28 : isStep ? 0.54 + rand() * 0.18 : 0.60 + rand() * 0.24;
  const dHalf = isLedge ? 0.52 + rand() * 0.18 : isStep ? 0.46 + rand() * 0.16 : 0.48 + rand() * 0.18;
  // Tall buried footing (-0.86m) + gentle rounded sandstone dome (+0.48..+0.60m) designed to sink 0.46-0.62m into wet sand
  const topY = isStep ? 0.48 + rand() * 0.03 : isLedge ? 0.54 + rand() * 0.04 : 0.56 + rand() * 0.04;
  const botY = -0.86;

  const numCleaves = 5 + Math.floor(rand() * 3);
  const fCos = [];
  const fSin = [];
  const fDist = [];
  const a0 = rand() * Math.PI * 2;
  for (let f = 0; f < numCleaves; f++) {
    const a = a0 + (f / numCleaves) * Math.PI * 2 + (rand() - 0.5) * 0.34;
    fCos.push(Math.cos(a));
    fSin.push(Math.sin(a));
    fDist.push(0.68 + rand() * 0.28);
  }

  const radialSegs = 40;
  const hStops = [0.0, 0.20, 0.42, 0.58, 0.70, 0.80, 0.89, 0.95, 1.0];
  const rings = [];
  const tmpColor = new THREE.Color();
  const dipX = (rand() - 0.5) * 0.08;
  const dipZ = (rand() - 0.5) * 0.08;
  const splitAng = rand() * Math.PI * 2;
  const splitCos = Math.cos(splitAng);
  const splitSin = Math.sin(splitAng);

  for (let hi = 0; hi < hStops.length; hi++) {
    const t = hStops[hi];
    const ring = [];

    for (let si = 0; si < radialSegs; si++) {
      const theta = (si / radialSegs) * Math.PI * 2;
      const cx = Math.cos(theta);
      const sz = Math.sin(theta);

      // Generous lateral rounding (smin 0.12) eliminates boxy low-poly shoreline corners
      let polyR = 1.45;
      for (let f = 0; f < numCleaves; f++) {
        const d = cx * fCos[f] + sz * fSin[f];
        if (d > 0.14) {
          polyR = smin(polyR, fDist[f] / d, 0.12);
        }
      }
      polyR = clamp(polyR, 0.58, 1.06);

      const jagged = (fbm3(cx * 2.8 + off, t * 1.8, sz * 2.8 - off, 2) - 0.5) * 0.09;
      // Broad gently-sloped water-worn sandstone apron tapering smoothly toward crown (zero steep block walls!)
      const batter = mix(1.42, 0.94, smoothstep(0.0, 0.72, t));
      const topChamfer = 1.0 - smoothstep(0.72, 1.0, t) * (isLedge ? 0.24 : 0.28);

      const r = Math.max(0.30, (polyR + jagged) * batter * topChamfer);
      const px = cx * wHalf * r;
      const pz = sz * dHalf * r;

      let py;
      if (t < 0.54) {
        py = mix(botY, topY * 0.62, t / 0.54);
      } else {
        const topFrac = (t - 0.54) / 0.46;
        const backSlope = sz > 0 ? sz * smoothstep(0.20, 1.0, sz) * -0.025 : 0.0;
        const tilt = px * dipX + pz * dipZ;
        const splitStep = smoothstep(-0.15, 0.35, cx * splitCos + sz * splitSin) * 0.014;
        py = mix(topY * 0.62, topY + tilt + splitStep + backSlope, smoothstep(0.0, 0.86, topFrac));
      }

      const slopeShade = clamp(0.90 + 0.10 * t, 0.88, 1.0);
      tmpColor.setRGB(slopeShade, slopeShade * 0.98, slopeShade * 0.95);
      ring.push({ x: px, y: py, z: pz, r: tmpColor.r, g: tmpColor.g, b: tmpColor.b });
    }
    rings.push(ring);
  }

  const tc = { x: 0, y: topY + 0.008, z: 0, r: 1, g: 1, b: 1 };
  const bc = { x: 0, y: botY, z: 0, r: 0.86, g: 0.83, b: 0.79 };
  const geom = buildLoftedPrism(rings, tc, bc);
  computeCreasedNormals(geom, 44);
  geom.computeBoundingBox();
  return geom;
}

/**
 * Generates low, rounded water-worn desert sandstone shelf cushions with broad flared
 * sand skirts and deep -0.86m footings for seamless shoreline embedding.
 */
function createCisternBoulderGeometry(seed) {
  const rand = mulberry32(seed);
  const off = seed * 3.17;
  const rx = 0.54 + rand() * 0.26;
  const rz = 0.44 + rand() * 0.22;
  const topY = 0.53 + rand() * 0.05;
  const botY = -0.86;

  const numPlanes = 5 + Math.floor(rand() * 3);
  const fCos = [];
  const fSin = [];
  const fDist = [];
  const a0 = rand() * Math.PI * 2;
  for (let p = 0; p < numPlanes; p++) {
    const a = a0 + (p / numPlanes) * Math.PI * 2 + (rand() - 0.5) * 0.36;
    fCos.push(Math.cos(a));
    fSin.push(Math.sin(a));
    fDist.push(0.68 + rand() * 0.26);
  }

  const hStops = [0.0, 0.20, 0.42, 0.56, 0.68, 0.79, 0.88, 0.95, 1.0];
  const radialSegs = 40;
  const rings = [];
  const tmpColor = new THREE.Color();
  const dipX = (rand() - 0.5) * 0.09;
  const dipZ = (rand() - 0.5) * 0.09;
  const splitAng = rand() * Math.PI * 2;
  const splitCos = Math.cos(splitAng);
  const splitSin = Math.sin(splitAng);

  for (let hi = 0; hi < hStops.length; hi++) {
    const t = hStops[hi];
    const ring = [];
    // Broad gently-sloped water-worn sandstone dome profile (zero vertical boxy side walls!)
    let slabEnv;
    if (t < 0.56) {
      slabEnv = mix(1.42, 1.12, t / 0.56);
    } else if (t < 0.79) {
      slabEnv = mix(1.12, 0.88, (t - 0.56) / 0.23);
    } else if (t < 0.95) {
      slabEnv = mix(0.88, 0.70, (t - 0.79) / 0.16);
    } else {
      slabEnv = 0.58;
    }

    for (let si = 0; si < radialSegs; si++) {
      const theta = (si / radialSegs) * Math.PI * 2;
      const cx = Math.cos(theta);
      const sz = Math.sin(theta);

      let polyR = 1.42;
      for (let p = 0; p < numPlanes; p++) {
        const d = cx * fCos[p] + sz * fSin[p];
        if (d > 0.14) {
          polyR = smin(polyR, fDist[p] / d, 0.13);
        }
      }
      polyR = clamp(polyR, 0.58, 1.06);

      const rough = (fbm3(cx * 2.4 + off, t * 1.8, sz * 2.4 - off, 2) - 0.5) * 0.09;
      const r = Math.max(0.28, (polyR + rough) * slabEnv);
      const px = cx * rx * r;
      const pz = sz * rz * r;

      let py;
      if (t < 0.56) {
        py = mix(botY, topY * 0.64, t / 0.56);
      } else {
        const u = (t - 0.56) / 0.44;
        const planeTilt = px * dipX + pz * dipZ;
        const splitStep = smoothstep(-0.15, 0.35, cx * splitCos + sz * splitSin) * 0.016;
        const microFacet = (vnoise3(px * 2.8 + off, 1.4, pz * 2.8) - 0.5) * 0.010;
        py = mix(topY * 0.64, topY + planeTilt + splitStep + microFacet, smoothstep(0.0, 0.88, u));
      }

      const shade = clamp(0.90 + 0.10 * t, 0.88, 1.0);
      tmpColor.setRGB(shade, shade * 0.98, shade * 0.95);
      ring.push({ x: px, y: py, z: pz, r: tmpColor.r, g: tmpColor.g, b: tmpColor.b });
    }
    rings.push(ring);
  }

  const tc = { x: 0, y: topY + 0.008, z: 0, r: 1, g: 1, b: 1 };
  const bc = { x: 0, y: botY, z: 0, r: 0.86, g: 0.83, b: 0.79 };
  const geom = buildLoftedPrism(rings, tc, bc);
  computeCreasedNormals(geom, 44);
  geom.computeBoundingBox();
  return geom;
}

/**
 * Generates thick irregular 5-to-7-sided split-cleaved desert sandstone stepping slabs
 * with flat planar chiseled upper tables, crisp beveled chamfer edges, and deep -0.34m
 * buried collars for authentic half-buried dune seating.
 */
function createPathSlabGeometry(w, d, seed, numSides = 6) {
  const rand = mulberry32(seed);
  const off = seed * 1.91;
  const hw = w * 0.5;
  const hd = d * 0.5;
  const topH = 0.048 + rand() * 0.020; // Thick substantial split-cleaved slab (+0.048m..+0.068m proud)

  // True irregular 5-to-7-sided fractured sandstone polygon (pentagons, skewed hexagons, wedges)
  const sides = clamp(Math.round(numSides), 5, 7);
  const angWeights = [];
  let sumW = 0;
  for (let i = 0; i < sides; i++) {
    const aw = 0.68 + rand() * 0.64;
    angWeights.push(aw);
    sumW += aw;
  }

  const polyCorners = [];
  let curA = rand() * Math.PI * 2;
  for (let i = 0; i < sides; i++) {
    const radScale = 0.80 + rand() * 0.28;
    const skewX = 1.0 + (rand() - 0.5) * 0.14;
    const skewZ = 1.0 + (rand() - 0.5) * 0.14;
    polyCorners.push({
      x: Math.cos(curA) * hw * radScale * skewX,
      z: Math.sin(curA) * hd * radScale * skewZ
    });
    curA += (angWeights[i] / sumW) * Math.PI * 2;
  }

  // Crisp cleaved polygon stone edges with subtle natural chipping
  const subPerEdge = 3;
  const perim = [];
  for (let i = 0; i < polyCorners.length; i++) {
    const a = polyCorners[i];
    const b = polyCorners[(i + 1) % polyCorners.length];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const eLen = Math.hypot(ex, ez) || 1.0;
    const nx = ez / eLen;
    const nz = -ex / eLen;
    for (let s = 0; s < subPerEdge; s++) {
      const u = s / subPerEdge;
      const midWeight = Math.sin(u * Math.PI);
      const chip = (vnoise3(mix(a.x, b.x, u) * 6.5 + off, 0.5, mix(a.z, b.z, u) * 6.5 - off) - 0.5) * 0.014 * midWeight;
      perim.push({
        x: mix(a.x, b.x, u) + nx * chip,
        z: mix(a.z, b.z, u) + nz * chip
      });
    }
  }

  const tiltX = (rand() - 0.5) * 0.0025;
  const tiltZ = (rand() - 0.5) * 0.0025;
  const cleaveAng = rand() * Math.PI * 2;
  const cleaveCos = Math.cos(cleaveAng);
  const cleaveSin = Math.sin(cleaveAng);
  const cleaveOff = (rand() - 0.5) * 0.10;

  // Deep buried skirt (-0.34m) -> collar -> steep cleaved wall -> crisp beveled chamfer -> flat chiseled table
  const ringDefs = [
    { rScale: 1.24, yBase: -0.340,        uvX: 1.00, colorHex: 0xcab090, isTop: false },
    { rScale: 1.14, yBase: -0.095,        uvX: 0.90, colorHex: 0xd5bc9e, isTop: false },
    { rScale: 1.05, yBase: -0.006,        uvX: 0.72, colorHex: 0xe0cab0, isTop: false },
    { rScale: 1.02, yBase: topH * 0.62,   uvX: 0.42, colorHex: 0xebd8c2, isTop: false },
    { rScale: 0.96, yBase: topH,          uvX: 0.14, colorHex: 0xf4e8d8, isTop: true },
    { rScale: 0.62, yBase: topH,          uvX: 0.00, colorHex: 0xf8f0e4, isTop: true }
  ];

  const rings = [];
  const totalPts = perim.length;
  for (let ri = 0; ri < ringDefs.length; ri++) {
    const rd = ringDefs[ri];
    const c = new THREE.Color(rd.colorHex);
    const ring = [];
    for (let pi = 0; pi < totalPts; pi++) {
      const p = perim[pi];
      const px = p.x * rd.rScale;
      const pz = p.z * rd.rScale;
      let py = rd.yBase;
      if (rd.isTop) {
        // Planar split-cleavage table with subtle chiseled bedding relief (zero pillowy dome!)
        const cleaveCoord = px * cleaveCos + pz * cleaveSin - cleaveOff;
        const laminarStep = smoothstep(-0.02, 0.03, cleaveCoord) * 0.0025;
        py = clamp(rd.yBase + px * tiltX + pz * tiltZ + laminarStep, 0.044, 0.072);
      }
      const edgeDriftJitter = rd.uvX > 0.05 && rd.uvX < 0.88 ? (vnoise3(px * 4.5 + off, 0.7, pz * 4.5 - off) - 0.5) * 0.12 : 0.0;
      const uvX = clamp(rd.uvX + edgeDriftJitter, 0.0, 1.0);
      ring.push({ x: px, y: py, z: pz, r: c.r, g: c.g, b: c.b, u: uvX, v: pi / totalPts });
    }
    rings.push(ring);
  }

  const topC = new THREE.Color(0xf8f0e4);
  const botC = new THREE.Color(0xcab090);
  const topCenter = { x: 0, y: topH, z: 0, r: topC.r, g: topC.g, b: topC.b, u: 0.0, v: 0.5 };
  const botCenter = { x: 0, y: -0.340, z: 0, r: botC.r, g: botC.g, b: botC.b, u: 1.0, v: 0.5 };
  const geom = buildLoftedPrism(rings, topCenter, botCenter);
  computeCreasedNormals(geom, 24);
  geom.computeBoundingBox();
  geom.userData.perim = perim;
  return geom;
}

function createScreeFragmentGeometry(seed) {
  const rand = mulberry32(seed);
  const geom = new THREE.IcosahedronGeometry(1.0, 1);
  const pos = geom.attributes.position;

  const sx = 1.10 + rand() * 0.48;
  const sy = 0.44 + rand() * 0.22;
  const sz = 0.78 + rand() * 0.36;

  const planes = [];
  for (let p = 0; p < 4; p++) {
    const theta = rand() * Math.PI * 2;
    const phi = (rand() - 0.25) * 1.1;
    const nx = Math.cos(theta) * Math.cos(phi);
    const ny = Math.sin(phi);
    const nz = Math.sin(theta) * Math.cos(phi);
    planes.push({ nx, ny, nz, d: 0.62 + rand() * 0.22 });
  }

  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);

    for (let p = 0; p < planes.length; p++) {
      const pl = planes[p];
      const dot = x * pl.nx + y * pl.ny + z * pl.nz;
      if (dot > pl.d) {
        const excess = dot - pl.d;
        x -= pl.nx * excess;
        y -= pl.ny * excess;
        z -= pl.nz * excess;
      }
    }

    const n = (vnoise3(x * 3.1 + seed, y * 3.1, z * 3.1 - seed) - 0.5) * 0.14;
    pos.setXYZ(i, x * sx * (1 + n), y * sy * (1 + n * 0.5), z * sz * (1 + n));
  }

  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  const totalH = Math.max(0.01, bb.max.y - bb.min.y);
  const shiftY = -(bb.min.y + totalH * 0.72);
  geom.translate(0, shiftY, 0);
  computeCreasedNormals(geom, 22);
  geom.computeBoundingBox();
  return { geom, height: totalH };
}

function buildCurbingPathAndPebbles(parentGroup, rockAnchors, atmoUniforms = FALLBACK_ATMO_UNIFORMS) {
  const rand = mulberry32(7731);
  const stoneGroup = new THREE.Group();
  stoneGroup.name = 'FremenMasonryAndStones';

  // --- A. Sparse Sun-Bleached Water-Worn Sandstone Shelf Spits & Open Wet Sandy Coves ---
  const shoreMat = enhanceSandstoneMaterial(
    createSandstonePhysicalMaterial({
      vertexColors: true,
      roughness: 0.90
    }),
    {
      strataFreq: 10.5,
      bumpStrength: 0.20,
      dustStrength: 0.22,
      varnishStrength: 0.05,
      wetLine: WATER_LEVEL,
      sandApronStrength: 0.72,
      apronRange: 0.24,
      apronSlopeMin: 0.34,
      cisternSandDrift: 1.0,
      baseOffset: 0.44,
      atmoUniforms
    }
  );

  const shoreVariants = [
    createCisternShelfGeometry('shelf', 511),
    createCisternShelfGeometry('ledge', 512),
    createCisternShelfGeometry('step', 513),
    createCisternShelfGeometry('ledge', 515),
    createCisternShelfGeometry('step', 516),
    createCisternBoulderGeometry(521),
    createCisternBoulderGeometry(522),
    createCisternBoulderGeometry(523),
    createCisternBoulderGeometry(524)
  ];

  const shoreTransforms = [];
  const makeSandstoneTint = () =>
    new THREE.Color(0xd9af7f).offsetHSL((rand() - 0.5) * 0.012, (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.06);
  const makeWeatheredUmberTint = () =>
    new THREE.Color(0xc89a6c).offsetHSL((rand() - 0.5) * 0.010, (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.05);
  const makeWetSlateTint = () =>
    new THREE.Color(0xbe936a).offsetHSL((rand() - 0.5) * 0.008, (rand() - 0.5) * 0.04, (rand() - 0.5) * 0.05);

  // Sparse broken cove spit shelves keeping wide natural sandy coves (no continuous stone necklace)
  const headlands = [
    { aStart: 3.64, aEnd: 4.30, count: 5, canHaveStep: true, frontCove: false },   // Northwest shelf (208..246 deg)
    { aStart: 4.94, aEnd: 5.74, count: 5, canHaveStep: true, frontCove: false },   // Northeast cove shelf (283..329 deg)
    { aStart: -0.06, aEnd: 0.24, count: 2, canHaveStep: false, frontCove: false }, // East accent shelf (356..14 deg)
    { aStart: 2.04, aEnd: 2.66, count: 4, canHaveStep: true, frontCove: true },    // Front-left cove spit (x: -4.8..-1.8, z: 6.0..9.2)
    { aStart: 0.28, aEnd: 0.94, count: 3, canHaveStep: true, frontCove: true }     // Front-right cove spit (x: +2.8..+5.2, z: 4.0..8.3)
  ];

  const isFrontCenterSandyInlet = (px, pz) => px > -1.85 && px < 2.35 && pz > 6.4;

  const findShoreR = (theta) => {
    for (let r = 2.4; r <= 8.4; r += 0.06) {
      const tx = CISTERN_CENTER.x + Math.cos(theta) * r;
      const tz = CISTERN_CENTER.z + Math.sin(theta) * r;
      if (getGroundHeight(tx, tz) >= WATER_LEVEL + 0.02) {
        return r;
      }
    }
    return 5.0;
  };

  for (let hi = 0; hi < headlands.length; hi++) {
    const hl = headlands[hi];
    const span = hl.aEnd - hl.aStart;

    for (let k = 0; k < hl.count; k++) {
      // Natural irregular gaps inside each broken spit
      if (k > 0 && k < hl.count - 1 && rand() < 0.26) continue;

      const u = (k + 0.16 + rand() * 0.68) / hl.count;
      const theta = hl.aStart + u * span;
      const shoreR = findShoreR(theta);
      const bankBias = hl.frontCove ? 0.24 : 0.08;
      const rPos = shoreR + bankBias + (rand() - 0.5) * 0.44;
      const px = CISTERN_CENTER.x + Math.cos(theta) * rPos;
      const pz = CISTERN_CENTER.z + Math.sin(theta) * rPos;

      // Guarantee open shallow sunlit sandy entry inlet in front-center
      if (isFrontCenterSandyInlet(px, pz)) continue;
      if (!hl.frontCove && pz > 5.8) continue;
      if (getPathDistance(px, pz).dist < 1.15) continue;

      const groundH = getGroundHeight(px, pz);
      const inwardYaw = Math.atan2(-Math.cos(theta), -Math.sin(theta)) + Math.PI;
      const roll = rand();
      const isSlabPlate = hl.frontCove ? roll < 0.54 : roll < 0.44;
      const isWetStep = !isSlabPlate && hl.canHaveStep && roll > 0.74;

      if (isSlabPlate) {
        // Low sand-buried rounded sandstone shelf cushion sunk 0.46-0.62m deep into wet sand
        const sVar = 5 + Math.floor(rand() * 4);
        const surfBase = clamp(groundH, WATER_LEVEL + 0.01, hl.frontCove ? WATER_LEVEL + 0.11 : WATER_LEVEL + 0.08);
        const sinkShore = (hl.frontCove ? 0.49 : 0.46) + rand() * 0.14;
        const datumY = surfBase - sinkShore;
        shoreTransforms.push({
          variant: sVar,
          x: px + (rand() - 0.5) * 0.16,
          y: datumY,
          z: pz + (rand() - 0.5) * 0.16,
          yaw: inwardYaw + (rand() - 0.5) * 1.35,
          tiltX: (rand() - 0.5) * 0.07,
          tiltZ: (rand() - 0.5) * 0.07,
          sx: (hl.frontCove ? 0.68 : 0.74) + rand() * 0.52,
          sy: (hl.frontCove ? 0.84 : 0.90) + rand() * 0.14,
          sz: (hl.frontCove ? 0.62 : 0.68) + rand() * 0.44,
          tint: rand() < 0.40 ? makeWeatheredUmberTint() : makeSandstoneTint()
        });
      } else {
        // Low rounded sandstone shelf ledge or flush water-edge wading step sunk 0.45-0.60m deep
        const ledgeVar = isWetStep ? ((hi + k) % 2 === 0 ? 2 : 4) : (rand() < 0.45 ? 0 : rand() < 0.5 ? 1 : 3);
        const surfBase = isWetStep
          ? WATER_LEVEL + 0.02
          : clamp(groundH, WATER_LEVEL + 0.01, hl.frontCove ? WATER_LEVEL + 0.10 : WATER_LEVEL + 0.07);
        const sinkShore = isWetStep ? 0.46 + rand() * 0.08 : (hl.frontCove ? 0.48 : 0.46) + rand() * 0.13;
        const datumY = surfBase - sinkShore;
        shoreTransforms.push({
          variant: ledgeVar,
          x: px,
          y: datumY,
          z: pz,
          yaw: inwardYaw + (rand() - 0.5) * 0.95,
          tiltX: (rand() - 0.5) * 0.06,
          tiltZ: (rand() - 0.5) * 0.06,
          sx: (hl.frontCove ? 0.68 : 0.76) + rand() * 0.50,
          sy: (hl.frontCove ? 0.85 : 0.90) + rand() * 0.14,
          sz: (hl.frontCove ? 0.62 : 0.68) + rand() * 0.42,
          tint: isWetStep ? makeWetSlateTint() : makeSandstoneTint()
        });
      }

      // Occasional low companion shelf or wading step clustered gently along broken spit
      if (hl.canHaveStep && rand() < 0.25) {
        const isFrontStep = rand() < (hl.frontCove ? 0.45 : 0.60);
        const secR = isFrontStep ? rPos - (0.34 + rand() * 0.24) : rPos + (0.48 + rand() * 0.42);
        const a2 = theta + (rand() - 0.5) * 0.12;
        const sx2 = CISTERN_CENTER.x + Math.cos(a2) * secR;
        const sz2 = CISTERN_CENTER.z + Math.sin(a2) * secR;
        if (
          !isFrontCenterSandyInlet(sx2, sz2) &&
          (hl.frontCove || sz2 <= 5.8) &&
          getPathDistance(sx2, sz2).dist >= 1.15
        ) {
          const gH2 = getGroundHeight(sx2, sz2);
          const surfBase2 = isFrontStep
            ? WATER_LEVEL + 0.01
            : clamp(gH2, WATER_LEVEL + 0.01, hl.frontCove ? WATER_LEVEL + 0.14 : WATER_LEVEL + 0.08);
          const sinkShore2 = isFrontStep ? 0.46 + rand() * 0.08 : 0.48 + rand() * 0.14;
          const secY = surfBase2 - sinkShore2;
          shoreTransforms.push({
            variant: isFrontStep ? ((hi + k) % 2 === 0 ? 2 : 4) : 5 + Math.floor(rand() * 4),
            x: sx2,
            y: secY,
            z: sz2,
            yaw: inwardYaw + (rand() - 0.5) * 1.1,
            tiltX: (rand() - 0.5) * 0.06,
            tiltZ: (rand() - 0.5) * 0.06,
            sx: 0.52 + rand() * 0.36,
            sy: isFrontStep ? 0.86 + rand() * 0.10 : 0.82 + rand() * 0.12,
            sz: 0.48 + rand() * 0.34,
            tint: isFrontStep ? makeWetSlateTint() : makeSandstoneTint()
          });
        }
      }
    }
  }

  const dummy = new THREE.Object3D();
  for (let v = 0; v < shoreVariants.length; v++) {
    const items = shoreTransforms.filter((c) => c.variant === v);
    if (items.length === 0) continue;
    const im = new THREE.InstancedMesh(shoreVariants[v], shoreMat, items.length);
    im.castShadow = true;
    im.receiveShadow = true;
    for (let j = 0; j < items.length; j++) {
      const it = items[j];
      dummy.position.set(it.x, it.y, it.z);
      dummy.rotation.set(it.tiltX, it.yaw, it.tiltZ);
      dummy.scale.set(it.sx, it.sy, it.sz);
      dummy.updateMatrix();
      im.setMatrixAt(j, dummy.matrix);
      im.setColorAt(j, it.tint);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    stoneGroup.add(im);
  }

  // Subtle low sand-embedded shoreline accent cushions (deeply sunk 0.48-0.62m so zero boxy nubs protrude)
  const shoreBoulderGeom = createCisternBoulderGeometry(599);
  const shoreBoulderItems = [];
  for (let hi = 0; hi < headlands.length; hi++) {
    const hl = headlands[hi];
    const chipCount = hi === 2 ? 1 : 2;
    for (let k = 0; k < chipCount; k++) {
      const theta = hl.aStart + rand() * (hl.aEnd - hl.aStart);
      const shoreR = findShoreR(theta);
      const rPos = shoreR + 0.08 + (rand() - 0.5) * 0.34;
      const px = CISTERN_CENTER.x + Math.cos(theta) * rPos;
      const pz = CISTERN_CENTER.z + Math.sin(theta) * rPos;
      if (isFrontCenterSandyInlet(px, pz) || (!hl.frontCove && pz > 5.8) || getPathDistance(px, pz).dist < 1.15) continue;
      const gH = getGroundHeight(px, pz);
      const surfBase = clamp(gH, WATER_LEVEL, WATER_LEVEL + 0.08);
      const sinkShore = 0.48 + rand() * 0.14;
      shoreBoulderItems.push({
        x: px,
        y: surfBase - sinkShore,
        z: pz,
        yaw: rand() * Math.PI * 2,
        tiltX: (rand() - 0.5) * 0.08,
        tiltZ: (rand() - 0.5) * 0.08,
        sx: 0.28 + rand() * 0.18,
        sy: 0.72 + rand() * 0.16,
        sz: 0.26 + rand() * 0.16,
        tint: rand() < 0.5 ? makeWetSlateTint() : makeWeatheredUmberTint()
      });
    }
  }
  if (shoreBoulderItems.length > 0) {
    const shoreRocksIM = new THREE.InstancedMesh(shoreBoulderGeom, shoreMat, shoreBoulderItems.length);
    shoreRocksIM.castShadow = false;
    shoreRocksIM.receiveShadow = true;
    for (let j = 0; j < shoreBoulderItems.length; j++) {
      const it = shoreBoulderItems[j];
      dummy.position.set(it.x, it.y, it.z);
      dummy.rotation.set(it.tiltX, it.yaw, it.tiltZ);
      dummy.scale.set(it.sx, it.sy, it.sz);
      dummy.updateMatrix();
      shoreRocksIM.setMatrixAt(j, dummy.matrix);
      shoreRocksIM.setColorAt(j, it.tint);
    }
    shoreRocksIM.instanceMatrix.needsUpdate = true;
    if (shoreRocksIM.instanceColor) shoreRocksIM.instanceColor.needsUpdate = true;
    stoneGroup.add(shoreRocksIM);
  }

  // --- B. Thick Split-Cleaved Flat Sandstone Flagstones Along the Windtrap Path ---
  const flagstoneMat = enhanceSandstoneMaterial(
    createSandstonePhysicalMaterial({
      vertexColors: true,
      roughness: 0.88
    }),
    {
      strataFreq: 10.5,
      bumpStrength: 0.12,
      dustStrength: 0.16,
      varnishStrength: 0.06,
      wetLine: -10.0,
      sandApronStrength: 0.0,
      edgeSandStrength: 0.88,
      dressedStone: 0.85,
      baseOffset: 0.0,
      atmoUniforms
    }
  );

  // Substantial 5-to-7-sided split-cleaved sandstone slab dimensions (0.74..1.24m)
  const flagDims = [
    { w: 1.16, d: 0.78, seed: 611, sides: 6 },
    { w: 0.80, d: 1.12, seed: 612, sides: 5 },
    { w: 1.02, d: 0.74, seed: 613, sides: 7 },
    { w: 0.78, d: 0.86, seed: 614, sides: 5 },
    { w: 0.96, d: 1.04, seed: 615, sides: 6 },
    { w: 1.10, d: 0.76, seed: 616, sides: 5 },
    { w: 0.82, d: 0.98, seed: 617, sides: 7 },
    { w: 1.24, d: 0.84, seed: 618, sides: 6 },
    { w: 0.76, d: 0.88, seed: 619, sides: 5 },
    { w: 0.98, d: 0.82, seed: 620, sides: 7 },
    { w: 0.84, d: 1.10, seed: 621, sides: 6 },
    { w: 1.04, d: 0.74, seed: 622, sides: 5 }
  ];
  const flagVariants = flagDims.map((dim) => createPathSlabGeometry(dim.w, dim.d, dim.seed, dim.sides));

  const pathSamples = [];
  let prevP = getPathPointAt(0);
  let totalLen = 0;
  const steps = 200;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = getPathPointAt(t);
    totalLen += Math.hypot(p.x - prevP.x, p.z - prevP.z);
    pathSamples.push({ t, x: p.x, z: p.z, s: totalLen });
    prevP = p;
  }

  const PRIMARY_STEPS = 32;
  const clusterConfig = new Map([
    [3, [{ lat: -0.66, fwd: 0.24, scale: 0.82, yawOff: 0.42 }]],
    [5, [{ lat: 0.60, fwd: -0.18, scale: 0.80, yawOff: -0.48 }]],
    [7, [{ lat: -0.62, fwd: 0.16, scale: 0.84, yawOff: 0.55 }]],
    [10, [
      { lat: -0.64, fwd: 0.20, scale: 0.82, yawOff: -0.44 },
      { lat: 0.62, fwd: -0.32, scale: 0.78, yawOff: 0.52 }
    ]],
    [14, [{ lat: 0.62, fwd: 0.22, scale: 0.82, yawOff: -0.40 }]],
    [17, [
      { lat: 0.66, fwd: 0.26, scale: 0.82, yawOff: -0.38 },
      { lat: -0.60, fwd: -0.28, scale: 0.78, yawOff: 0.48 }
    ]],
    [22, [
      { lat: -0.66, fwd: 0.22, scale: 0.84, yawOff: 0.42 },
      { lat: 0.62, fwd: -0.26, scale: 0.78, yawOff: -0.46 }
    ]],
    [26, [{ lat: -0.58, fwd: 0.16, scale: 0.82, yawOff: -0.36 }]],
    [29, [
      { lat: -0.64, fwd: 0.18, scale: 0.86, yawOff: -0.30 },
      { lat: 0.60, fwd: -0.24, scale: 0.80, yawOff: 0.35 }
    ]]
  ]);
  const flagItems = [];
  const upVec = new THREE.Vector3(0, 1, 0);
  const gNormal = new THREE.Vector3();
  const centerNormal = new THREE.Vector3();
  const alignedNormal = new THREE.Vector3();
  const fullTiltQuat = new THREE.Quaternion();
  const tiltQuat = new THREE.Quaternion();
  const yawQuat = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const cornerVec = new THREE.Vector3();
  const collarProbe = new THREE.Vector3();

  const samplePathAtT = (tTarget) => {
    const tC = clamp(tTarget, 0.0, 1.0);
    const idxF = tC * steps;
    const i0 = Math.min(Math.floor(idxF), steps - 1);
    const i1 = i0 + 1;
    const f = idxF - i0;
    const a = pathSamples[i0];
    const b = pathSamples[i1];
    return {
      t: mix(a.t, b.t, f),
      x: mix(a.x, b.x, f),
      z: mix(a.z, b.z, f),
      s: mix(a.s, b.s, f)
    };
  };

  const sStart = samplePathAtT(0.04).s;
  const sEnd = samplePathAtT(0.95).s;
  const stepSpan = (sEnd - sStart) / Math.max(1, PRIMARY_STEPS - 1);
  const slabTints = [0xd2a475, 0xc39363, 0xdaaf81, 0xba895a, 0xcba071, 0xbf8f60];

  const overlapsPlacedFlagstone = (px, pz, rCheck) => {
    for (let i = 0; i < flagItems.length; i++) {
      const f = flagItems[i];
      const fDim = flagDims[f.variant];
      const fR = Math.max(fDim.w * f.sx, fDim.d * f.sz) * 0.42;
      if (Math.hypot(px - f.x, pz - f.z) < fR + rCheck) return true;
    }
    return false;
  };

  const pushFlagstone = (px, pz, tx, tz, variantIdx, tintIdx, scaleMult = 1.0, yawExtra = 0.0, pathT = 0.0) => {
    const info = getTerrainInfo(px, pz);
    if (info.isWater || info.cisternBowl >= 0.25) return;

    const vIdx = variantIdx % flagVariants.length;
    const dim = flagDims[vIdx];
    // Uphill scale maintenance/boost keeps distant Windtrap approach slabs bold and readable (zero tiny pebbles)
    const uphillScale = mix(1.0, 1.30, smoothstep(0.38, 0.96, pathT));
    const sx = (0.90 + rand() * 0.20) * scaleMult * uphillScale;
    const sz = (0.90 + rand() * 0.20) * scaleMult * uphillScale;
    const approxR = Math.max(dim.w * sx, dim.d * sz) * 0.40;
    if (scaleMult < 0.95 && overlapsPlacedFlagstone(px, pz, approxR)) return;

    const yaw = Math.atan2(tx, tz) + (rand() - 0.5) * 0.68 + yawExtra;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const halfW = dim.w * 0.5 * sx * 0.96;
    const halfD = dim.d * 0.5 * sz * 0.96;

    // Sample terrain height across rotated top-rim corners + mid-edges
    const cOffsets = [
      [ halfW,  halfD],
      [-halfW,  halfD],
      [-halfW, -halfD],
      [ halfW, -halfD],
      [ halfW,  0.0],
      [-halfW,  0.0],
      [ 0.0,    halfD],
      [ 0.0,   -halfD]
    ];
    const cornerPts = [];
    for (let ci = 0; ci < cOffsets.length; ci++) {
      const lx = cOffsets[ci][0];
      const lz = cOffsets[ci][1];
      const dx = lx * cosY + lz * sinY;
      const dz = -lx * sinY + lz * cosY;
      cornerPts.push({ dx, dz, h: getGroundHeight(px + dx, pz + dz) });
    }

    // Best-fit slope plane normal blended with analytic terrain normal
    const e1x = cornerPts[2].dx - cornerPts[0].dx;
    const e1y = cornerPts[2].h - cornerPts[0].h;
    const e1z = cornerPts[2].dz - cornerPts[0].dz;
    const e2x = cornerPts[3].dx - cornerPts[1].dx;
    const e2y = cornerPts[3].h - cornerPts[1].h;
    const e2z = cornerPts[3].dz - cornerPts[1].dz;
    gNormal.set(
      e1y * e2z - e1z * e2y,
      e1z * e2x - e1x * e2z,
      e1x * e2y - e1y * e2x
    );
    if (gNormal.y < 0) gNormal.negate();
    if (gNormal.lengthSq() < 1e-8) gNormal.set(0, 1, 0);
    gNormal.normalize();
    getGroundNormal(px, pz, centerNormal);
    gNormal.lerp(centerNormal, 0.35).normalize();

    const slopeSteep = 1.0 - gNormal.y;
    fullTiltQuat.setFromUnitVectors(upVec, gNormal);
    // Align 88% smoothly with local dune slope normal so flat table sits cleanly flush in dune flank
    tiltQuat.identity().slerp(fullTiltQuat, 0.88);
    alignedNormal.copy(upVec).applyQuaternion(tiltQuat).normalize();

    // Project tilted slab plane corners so uphill & downhill collars sink cleanly without burying the upper table
    let minCornerY = info.height;
    for (let ci = 0; ci < cornerPts.length; ci++) {
      cornerVec.set(cornerPts[ci].dx, 0, cornerPts[ci].dz).applyQuaternion(tiltQuat);
      const impliedCenterY = cornerPts[ci].h - cornerVec.y;
      if (impliedCenterY < minCornerY) minCornerY = impliedCenterY;
    }
    const baseDatumY = Math.max(minCornerY, info.height - 0.010);
    let placeY = baseDatumY - 0.006 - slopeSteep * 0.020;

    // Guarantee ZERO floating skirt vertices while capping sinkage so upper ridge slabs never drown under terrain triangles
    const perim = flagVariants[vIdx].userData.perim || [];
    yawQuat.setFromAxisAngle(yAxis, yaw);
    dummy.position.set(px, placeY, pz);
    dummy.quaternion.copy(tiltQuat).multiply(yawQuat);
    dummy.scale.set(sx, 1.0, sz);
    dummy.updateMatrix();
    let maxCollarExcess = 0.0;
    for (let pi = 0; pi < perim.length; pi++) {
      const p = perim[pi];
      for (const ringDef of [
        { rS: 1.14, ly: -0.095, margin: 0.004 },
        { rS: 1.24, ly: -0.340, margin: 0.010 }
      ]) {
        collarProbe.set(p.x * ringDef.rS, ringDef.ly, p.z * ringDef.rS).applyMatrix4(dummy.matrix);
        const gh = getGroundHeight(collarProbe.x, collarProbe.z);
        const excess = collarProbe.y - (gh - ringDef.margin);
        if (excess > maxCollarExcess) maxCollarExcess = excess;
      }
    }
    if (maxCollarExcess > 0.0) {
      placeY -= Math.min(maxCollarExcess, 0.018);
    }
    placeY = Math.max(placeY, info.height - 0.012);

    const baseHex = slabTints[tintIdx % slabTints.length];
    flagItems.push({
      variant: vIdx,
      x: px,
      y: placeY,
      z: pz,
      nx: alignedNormal.x,
      ny: alignedNormal.y,
      nz: alignedNormal.z,
      yaw,
      sx,
      sy: 1.0,
      sz,
      pathT,
      tint: new THREE.Color(baseHex).offsetHSL(
        (rand() - 0.5) * 0.015,
        (rand() - 0.5) * 0.06,
        (rand() - 0.5) * 0.06
      )
    });
  };

  for (let stepIdx = 0; stepIdx < PRIMARY_STEPS; stepIdx++) {
    const jitterS =
      stepIdx === 0 || stepIdx === PRIMARY_STEPS - 1 ? 0.0 : (rand() - 0.5) * stepSpan * 0.48;
    const targetS = clamp(sStart + stepIdx * stepSpan + jitterS, sStart, sEnd);

    let sampleA = pathSamples[0];
    let sampleB = pathSamples[1];
    for (let k = 0; k < pathSamples.length - 1; k++) {
      if (pathSamples[k + 1].s >= targetS) {
        sampleA = pathSamples[k];
        sampleB = pathSamples[k + 1];
        break;
      }
    }
    const segSpan = Math.max(1e-5, sampleB.s - sampleA.s);
    const localF = clamp((targetS - sampleA.s) / segSpan, 0, 1);
    const cx = mix(sampleA.x, sampleB.x, localF);
    const cz = mix(sampleA.z, sampleB.z, localF);
    const pathT = mix(sampleA.t, sampleB.t, localF);

    const dirX = sampleB.x - sampleA.x;
    const dirZ = sampleB.z - sampleA.z;
    const dirLen = Math.hypot(dirX, dirZ) || 1;
    const tx = dirX / dirLen;
    const tz = dirZ / dirLen;
    const nx = -tz;
    const nz = tx;

    // Natural meandering tread with organic lateral drift instead of a stiff single-file ruler
    const wander = Math.sin(stepIdx * 0.65 + 0.4) * 0.26 + Math.cos(stepIdx * 1.42) * 0.14;
    const latOffset = clamp(wander + (rand() - 0.5) * 0.36, -0.50, 0.50);
    const px = cx + nx * latOffset;
    const pz = cz + nz * latOffset;

    const variantPick = (stepIdx * 3 + Math.floor(rand() * 5)) % flagVariants.length;
    pushFlagstone(px, pz, tx, tz, variantPick, stepIdx, 1.0, 0.0, pathT);

    // Organic off-beat stepping pairs & compact companion wedges breaking single-file runs
    const clusterList = clusterConfig.get(stepIdx);
    if (clusterList) {
      for (let ci = 0; ci < clusterList.length; ci++) {
        const cl = clusterList[ci];
        const clLat = cl.lat + (rand() - 0.5) * 0.16;
        const clFwd = cl.fwd + (rand() - 0.5) * 0.14;
        pushFlagstone(
          cx + nx * clLat + tx * clFwd,
          cz + nz * clLat + tz * clFwd,
          tx,
          tz,
          stepIdx * 2 + ci * 5 + 3,
          stepIdx + ci + 1,
          cl.scale,
          cl.yawOff,
          pathT
        );
      }
    }
  }

  for (let v = 0; v < flagVariants.length; v++) {
    const items = flagItems.filter((f) => f.variant === v);
    if (items.length === 0) continue;
    const im = new THREE.InstancedMesh(flagVariants[v], flagstoneMat, items.length);
    im.castShadow = false;
    im.receiveShadow = true;
    for (let j = 0; j < items.length; j++) {
      const it = items[j];
      gNormal.set(it.nx, it.ny, it.nz).normalize();
      tiltQuat.setFromUnitVectors(upVec, gNormal);
      yawQuat.setFromAxisAngle(yAxis, it.yaw);
      dummy.position.set(it.x, it.y, it.z);
      dummy.quaternion.copy(tiltQuat).multiply(yawQuat);
      dummy.scale.set(it.sx, it.sy, it.sz);
      dummy.updateMatrix();
      im.setMatrixAt(j, dummy.matrix);
      im.setColorAt(j, it.tint);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    stoneGroup.add(im);
  }

  // --- C. Deeply Embedded Sand-Drifted Scree & Coarse Cistern-Edge Shingle Tongues ---
  const screeMat = enhanceSandstoneMaterial(
    createSandstonePhysicalMaterial({
      roughness: 0.92
    }),
    {
      strataFreq: 14.0,
      bumpStrength: 0.14,
      dustStrength: 0.44,
      varnishStrength: 0.04,
      wetLine: WATER_LEVEL,
      sandApronStrength: 0.78,
      apronRange: 0.16,
      apronSlopeMin: 0.32,
      baseOffset: 0.04,
      atmoUniforms
    }
  );

  const screeVariants = [
    createScreeFragmentGeometry(711),
    createScreeFragmentGeometry(712),
    createScreeFragmentGeometry(713),
    createScreeFragmentGeometry(714)
  ];

  const overlapsAnyFlagstone = (px, pz, margin = 0.18) => {
    for (let oi = 0; oi < flagItems.length; oi++) {
      const o = flagItems[oi];
      const oDim = flagDims[o.variant];
      const oHw = oDim.w * 0.5 * o.sx * 1.18 + margin;
      const oHd = oDim.d * 0.5 * o.sz * 1.18 + margin;
      const ddx = px - o.x;
      const ddz = pz - o.z;
      const oc = Math.cos(o.yaw);
      const os = Math.sin(o.yaw);
      const olx = ddx * oc - ddz * os;
      const olz = ddx * os + ddz * oc;
      if (Math.abs(olx) < oHw && Math.abs(olz) < oHd) {
        return true;
      }
    }
    return false;
  };

  const screeItems = [];
  const addScree = (px, pz, scaleLo, scaleHi, lumScale = 1.0, allowNearCisternRim = false, syMult = 1.0, allowWaterEdge = false) => {
    if (!allowNearCisternRim && Math.hypot(px - CISTERN_CENTER.x, pz - CISTERN_CENTER.z) < 8.4) return false;
    if (overlapsAnyFlagstone(px, pz, syMult < 0.7 ? 0.18 : 0.24)) return false;
    const info = getTerrainInfo(px, pz);
    if (allowWaterEdge) {
      if (info.waterDepth > 0.045 || isFrontCenterSandyInlet(px, pz)) return false;
    } else if (info.isWater || (allowNearCisternRim && info.cisternBowl >= 0.20)) {
      return false;
    }
    const sc = scaleLo + rand() * (scaleHi - scaleLo);
    const variantIdx = screeItems.length % screeVariants.length;
    const pHeight = screeVariants[variantIdx].height;
    getGroundNormal(px, pz, gNormal);

    const syScale = sc * (0.72 + rand() * 0.24) * syMult;
    // Deeply embedded so gravel & shingle feel drifted into sand rather than dropped dark pebbles
    const exposeLift =
      syMult < 0.7
        ? pHeight * syScale * (-0.16 + rand() * 0.05)
        : pHeight * syScale * (-0.10 + rand() * 0.05);

    const tint = new THREE.Color(syMult < 0.7 ? 0xd3aa7d : 0xcca173).offsetHSL(
      (rand() - 0.5) * 0.008,
      (rand() - 0.5) * 0.05,
      ((rand() - 0.5) * 0.05) * lumScale
    );

    screeItems.push({
      variant: variantIdx,
      x: px,
      y: info.height + exposeLift,
      z: pz,
      nx: gNormal.x,
      ny: gNormal.y,
      nz: gNormal.z,
      yaw: rand() * Math.PI * 2,
      sx: sc * (0.90 + rand() * 0.42),
      sy: syScale,
      sz: sc * (0.86 + rand() * 0.40),
      tint
    });
    return true;
  };

  // 1) Embedded talus scree pockets tightly hugging rock outcrop base skirts (no stray foreground sand nubs)
  for (let i = 0; i < rockAnchors.length; i++) {
    const anchor = rockAnchors[i];
    const pockets = 6;
    for (let p = 0; p < pockets; p++) {
      const pAng = (p / pockets) * Math.PI * 2 + (rand() - 0.5) * 0.55;
      const pDist = anchor.r * (0.34 + rand() * 0.20);
      const pcx = anchor.x + Math.cos(pAng) * pDist;
      const pcz = anchor.z + Math.sin(pAng) * pDist;
      if (getPathDistance(pcx, pcz).dist < 1.50) continue;
      if (Math.hypot(pcx - CISTERN_CENTER.x, pcz - CISTERN_CENTER.z) < 8.4) continue;
      if (pcx > -16.8 && pcx < -13.0 && pcz > 4.6 && pcz < 7.4) continue;

      const chipsInPocket = 7 + Math.floor(rand() * 4);
      for (let k = 0; k < chipsInPocket; k++) {
        const spread = k < 3 ? rand() * 0.16 : 0.10 + rand() * 0.26;
        const ang = rand() * Math.PI * 2;
        const px = pcx + Math.cos(ang) * spread;
        const pz = pcz + Math.sin(ang) * spread;
        if (getPathDistance(px, pz).dist < 1.45) continue;
        if (Math.abs(px) < 10.0 && pz < -10.5) continue;
        if (px > -16.8 && px < -13.0 && pz > 4.6 && pz < 7.4) continue;
        const isChunk = k < 3;
        addScree(px, pz, isChunk ? 0.105 : 0.052, isChunk ? 0.175 : 0.098, 1.0, false, isChunk ? 0.72 : 0.56);
      }
    }
  }

  // 2) Grounded gravel pockets nestled right around Windtrap plinth skirt (-21, -25)
  for (let p = 0; p < 6; p++) {
    const pAng = 0.4 + (p / 6) * Math.PI * 2;
    const pcx = -21.0 + Math.cos(pAng) * 3.70;
    const pcz = -25.0 + Math.sin(pAng) * 3.70;
    for (let k = 0; k < 5; k++) {
      const ang = rand() * Math.PI * 2;
      const r = rand() * 0.52;
      addScree(pcx + Math.cos(ang) * r, pcz + Math.sin(ang) * r, 0.060, 0.125, 1.0, false, 0.58);
    }
  }

  // 3) Sparse warm water-edge desert shingle & gravel tongues along broken cistern shore coves
  const shingleZones = [
    { aStart: 2.00, aEnd: 2.70, count: 16, rSpread: 1.05 }, // Front-left cove shingle (x: -4.8..-1.9, z: 6.0..9.2)
    { aStart: 0.14, aEnd: 0.98, count: 18, rSpread: 1.15 }, // Front-right / side cove shingle (x: +2.6..+5.4, z: 3.6..8.4)
    { aStart: 3.64, aEnd: 4.30, count: 8, rSpread: 0.70 },  // Northwest headland transition shingle
    { aStart: 4.94, aEnd: 5.74, count: 8, rSpread: 0.70 }   // Northeast headland transition shingle
  ];
  for (let si = 0; si < shingleZones.length; si++) {
    const sz = shingleZones[si];
    for (let k = 0; k < sz.count; k++) {
      const u = (k + rand() * 0.85) / sz.count;
      const theta = sz.aStart + u * (sz.aEnd - sz.aStart) + (rand() - 0.5) * 0.06;
      const shoreR = findShoreR(theta);
      const rPos = shoreR - 0.08 + Math.pow(rand(), 1.15) * sz.rSpread;
      const px = CISTERN_CENTER.x + Math.cos(theta) * rPos;
      const pz = CISTERN_CENTER.z + Math.sin(theta) * rPos;
      if (getPathDistance(px, pz).dist < 1.10) continue;
      const isCoarse = k % 4 === 0;
      addScree(
        px,
        pz,
        isCoarse ? 0.072 : 0.038,
        isCoarse ? 0.115 : 0.070,
        1.0,
        true,
        isCoarse ? 0.42 : 0.34,
        true
      );
    }
  }

  // 4) Low embedded drifted desert gravel pockets beside foreground flagstones (omits upper ridge to avoid tiny dots)
  for (let fi = 0; fi < flagItems.length; fi++) {
    const slab = flagItems[fi];
    if (slab.pathT > 0.42) continue;
    if (fi % 2 !== 0 && rand() > 0.35) continue;
    const dim = flagDims[slab.variant];
    const hw = dim.w * 0.5 * slab.sx * 1.14;
    const hd = dim.d * 0.5 * slab.sz * 1.14;
    const cosY = Math.cos(slab.yaw);
    const sinY = Math.sin(slab.yaw);
    const side = fi % 4 < 2 ? 1 : -1;
    const pocketCenterLx = side * (hw + 0.18 + rand() * 0.22);
    const pocketCenterLz = (rand() - 0.5) * hd * 0.72;
    const pebbleCount = 2 + Math.floor(rand() * 2);
    for (let pk = 0; pk < pebbleCount; pk++) {
      const lx = pocketCenterLx + (rand() - 0.5) * 0.14;
      const lz = pocketCenterLz + (rand() - 0.5) * 0.16;
      const px = slab.x + lx * cosY + lz * sinY;
      const pz = slab.z - lx * sinY + lz * cosY;
      addScree(px, pz, 0.036, 0.068, 1.0, true, 0.42);
    }
  }

  for (let v = 0; v < screeVariants.length; v++) {
    const items = screeItems.filter((p) => p.variant === v);
    if (items.length === 0) continue;
    const im = new THREE.InstancedMesh(screeVariants[v].geom, screeMat, items.length);
    im.castShadow = false;
    im.receiveShadow = true;
    for (let j = 0; j < items.length; j++) {
      const it = items[j];
      gNormal.set(it.nx, it.ny, it.nz).normalize();
      tiltQuat.setFromUnitVectors(upVec, gNormal);
      yawQuat.setFromAxisAngle(yAxis, it.yaw);
      dummy.position.set(it.x, it.y, it.z);
      dummy.quaternion.copy(tiltQuat).multiply(yawQuat);
      dummy.scale.set(it.sx, it.sy, it.sz);
      dummy.updateMatrix();
      im.setMatrixAt(j, dummy.matrix);
      im.setColorAt(j, it.tint);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    stoneGroup.add(im);
  }

  parentGroup.add(stoneGroup);
}

// ---------------------------------------------------------------------------
// 3. Brutalist Fremen Badgir Sandstone & Basalt Wind-Catcher Bastion (x = -21, z = -25)
// ---------------------------------------------------------------------------

/**
 * Creates a brutalist beveled/chamfered monolithic stone or basalt prism with
 * optional vertical wall fluting and stepped vertical profile.
 */
function createChamferedBatteredPrism({
  rxBot,
  rzBot,
  rxTop,
  rzTop,
  chamferBot,
  chamferTop,
  yBot,
  yTop,
  fluteDepth = 0.0,
  fluteFreq = 3.0,
  segSteps = 4
}) {
  const ptsPerSide = 6;
  const ringSegs = 8 * ptsPerSide;
  const rings = [];

  for (let hi = 0; hi <= segSteps; hi++) {
    const t = hi / segSteps;
    const rx = mix(rxBot, rxTop, t);
    const rz = mix(rzBot, rzTop, t);
    const ch = clamp(mix(chamferBot, chamferTop, t), 0.04, Math.min(rx, rz) * 0.85);
    const y = mix(yBot, yTop, t);

    // 8 chamfered octagonal perimeter corner vertices in increasing-theta order (x=+ -> +z -> -x -> -z)
    const corners = [
      { x: rx, z: rz - ch },
      { x: rx - ch, z: rz },
      { x: -(rx - ch), z: rz },
      { x: -rx, z: rz - ch },
      { x: -rx, z: -(rz - ch) },
      { x: -(rx - ch), z: -rz },
      { x: rx - ch, z: -rz },
      { x: rx, z: -(rz - ch) }
    ];

    const ring = [];
    for (let e = 0; e < 8; e++) {
      const cA = corners[e];
      const cB = corners[(e + 1) % 8];
      const isCardinalWall = e % 2 === 1;
      for (let p = 0; p < ptsPerSide; p++) {
        const u = p / ptsPerSide;
        let px = mix(cA.x, cB.x, u);
        let pz = mix(cA.z, cB.z, u);
        if (fluteDepth > 0 && isCardinalWall && u > 0.14 && u < 0.86) {
          const fluteWave = Math.pow(Math.abs(Math.sin(((u - 0.14) / 0.72) * Math.PI * fluteFreq)), 1.4);
          const normLen = Math.hypot(px, pz) || 1.0;
          px -= (px / normLen) * fluteWave * fluteDepth;
          pz -= (pz / normLen) * fluteWave * fluteDepth;
        }
        ring.push({ x: px, y, z: pz, r: 1, g: 1, b: 1 });
      }
    }
    rings.push(ring);
  }

  const tc = { x: 0, y: yTop, z: 0, r: 1, g: 1, b: 1 };
  const bc = { x: 0, y: yBot, z: 0, r: 1, g: 1, b: 1 };
  const geom = buildLoftedPrism(rings, tc, bc);
  computeCreasedNormals(geom, 24);
  return geom;
}

/**
 * Creates a curved helical oxidized-bronze turbine vane for the internal vertical rotor.
 */
function createTurbineScoopVaneGeometry(height = 1.56, radius = 0.86) {
  const shape = new THREE.Shape();
  const r = 0.24;
  shape.absarc(0, 0, r, 0.15, Math.PI - 0.15, false);
  shape.absarc(0, 0, r - 0.038, Math.PI - 0.15, 0.15, true);
  shape.closePath();

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.010,
    bevelSegments: 2,
    curveSegments: 14,
    steps: 16
  });
  geom.rotateX(-Math.PI * 0.5);
  geom.translate(0, -height * 0.5, 0);

  const pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nt = clamp(y / height + 0.5, 0.0, 1.0);
    const radialOffset = radius * 0.64 * (0.85 + 0.15 * Math.sin(nt * Math.PI));
    const twist = (nt - 0.5) * 0.72;
    const ca = Math.cos(twist);
    const sa = Math.sin(twist);
    const lx = x + radialOffset;
    pos.setXYZ(i, lx * ca - z * sa, y, lx * sa + z * ca);
  }
  geom.computeVertexNormals();
  return geom;
}

function createChamferedCollarGeometry(innerR, outerR, height, radialSegs = 16) {
  const chamfer = Math.min(height * 0.24, (outerR - innerR) * 0.35);
  const hh = height * 0.5;
  const profile = [
    new THREE.Vector2(innerR, -hh),
    new THREE.Vector2(outerR - chamfer, -hh),
    new THREE.Vector2(outerR, -hh + chamfer),
    new THREE.Vector2(outerR, hh - chamfer),
    new THREE.Vector2(outerR - chamfer, hh),
    new THREE.Vector2(innerR, hh)
  ];
  const geom = new THREE.LatheGeometry(profile, radialSegs);
  geom.computeVertexNormals();
  return geom;
}

/**
 * Samples a smooth 24-40 segment rounded-chamfer perimeter ring for sculptural Fremen architecture
 * (eliminates flat octagonal facets on curved hoods, moldings, and battered plinths).
 */
function buildRoundedChamferRing(rx, rz, ch, y, {
  arcSegs = 6,
  flatSegs = 2,
  fluteDepth = 0.0,
  fluteFreq = 3.0
} = {}) {
  const safeCh = clamp(ch, 0.01, Math.min(rx, rz) * 0.985);
  const hx = rx - safeCh;
  const hz = rz - safeCh;
  const ring = [];

  const pushArc = (cx, cz, aStart) => {
    for (let i = 0; i < arcSegs; i++) {
      const a = aStart + (i / arcSegs) * (Math.PI * 0.5);
      ring.push({ x: cx + Math.cos(a) * safeCh, y, z: cz + Math.sin(a) * safeCh, r: 1, g: 1, b: 1 });
    }
  };
  const pushFlat = (x0, z0, x1, z1) => {
    for (let i = 0; i < flatSegs; i++) {
      const u = i / flatSegs;
      let px = mix(x0, x1, u);
      let pz = mix(z0, z1, u);
      if (fluteDepth > 0 && u > 0.10 && u < 0.90) {
        const fluteWave = Math.pow(Math.abs(Math.sin(((u - 0.10) / 0.80) * Math.PI * fluteFreq)), 1.4);
        const normLen = Math.hypot(px, pz) || 1.0;
        px -= (px / normLen) * fluteWave * fluteDepth;
        pz -= (pz / normLen) * fluteWave * fluteDepth;
      }
      ring.push({ x: px, y, z: pz, r: 1, g: 1, b: 1 });
    }
  };

  pushArc(hx, hz, 0.0);
  pushFlat(hx, rz, -hx, rz);
  pushArc(-hx, hz, Math.PI * 0.5);
  pushFlat(-rx, hz, -rx, -hz);
  pushArc(-hx, -hz, Math.PI);
  pushFlat(-hx, -rz, hx, -rz);
  pushArc(hx, -hz, Math.PI * 1.5);
  pushFlat(rx, -hz, rx, hz);

  return ring;
}

/**
 * Builds a smoothly contoured 32-segment Fremen architectural loft from profile stops
 * [{ y, r, ch, fluteDepth? }], yielding silky curved domes, bullnose cornices, and moldings.
 */
function createSmoothProfiledLoft(stops, { arcSegs = 6, flatSegs = 2, fluteFreq = 3.0, creaseDeg = 50, topCapY = null } = {}) {
  const rings = stops.map((st) =>
    buildRoundedChamferRing(st.r, st.r, st.ch, st.y, {
      arcSegs,
      flatSegs,
      fluteDepth: st.fluteDepth || 0.0,
      fluteFreq
    })
  );
  const yTop = topCapY !== null ? topCapY : stops[stops.length - 1].y;
  const yBot = stops[0].y;
  const tc = { x: 0, y: yTop, z: 0, r: 1, g: 1, b: 1 };
  const bc = { x: 0, y: yBot, z: 0, r: 1, g: 1, b: 1 };
  const geom = buildLoftedPrism(rings, tc, bc);
  computeCreasedNormals(geom, creaseDeg);
  return geom;
}

/**
 * Builds a smoothly concave-battered monolithic sandstone plinth (-0.92m .. +2.62m)
 * with 40-segment rounded corners and continuous wind-scoured curvature (zero polygonal facets).
 */
function createSmoothBatteredPlinthGeometry() {
  const yStops = [
    -0.92, -0.52, -0.14, 0.18,
    0.37, 0.405, 0.435, 0.47,
    0.72, 0.99, 1.025, 1.055, 1.09,
    1.36, 1.61, 1.645, 1.675, 1.71,
    1.95, 2.15, 2.185, 2.215, 2.25,
    2.45, 2.62
  ];
  const rings = [];

  for (let hi = 0; hi < yStops.length; hi++) {
    const y = yStops[hi];
    const u = clamp((y + 0.92) / (2.62 + 0.92), 0.0, 1.0);
    const tCurve = 1.0 - Math.pow(1.0 - u, 1.48);
    // Crisp recessed horizontal ashlar masonry course reveal seams at y = 0.42, 1.04, 1.66, 2.20
    const seam =
      Math.exp(-Math.pow((y - 0.42) / 0.024, 2.0)) * 0.036 +
      Math.exp(-Math.pow((y - 1.04) / 0.024, 2.0)) * 0.036 +
      Math.exp(-Math.pow((y - 1.66) / 0.024, 2.0)) * 0.034 +
      Math.exp(-Math.pow((y - 2.20) / 0.024, 2.0)) * 0.030;
    // Slight stepped plinth course lip catching top sunlight directly above each reveal seam
    const stepLip =
      (y > 0.44 && y < 0.76 ? 0.018 * (1.0 - smoothstep(0.44, 0.76, y)) : 0.0) +
      (y > 1.06 && y < 1.40 ? 0.018 * (1.0 - smoothstep(1.06, 1.40, y)) : 0.0) +
      (y > 1.68 && y < 1.98 ? 0.016 * (1.0 - smoothstep(1.68, 1.98, y)) : 0.0);
    const r = mix(3.68, 1.98, tCurve) - seam + stepLip;
    const ch = clamp(mix(1.12, 0.62, tCurve), 0.10, r * 0.92);
    const fluteMask = smoothstep(0.18, 0.45, u) * (1.0 - smoothstep(0.90, 1.0, u) * 0.45);
    const fluteDepth = 0.026 * fluteMask;
    const ring = buildRoundedChamferRing(r, r, ch, y, { arcSegs: 6, flatSegs: 4, fluteDepth, fluteFreq: 3.0 });
    const seamAO = clamp(1.0 - seam * 7.2, 0.68, 1.0);
    for (let vi = 0; vi < ring.length; vi++) {
      ring[vi].r = seamAO;
      ring[vi].g = seamAO * 0.96;
      ring[vi].b = seamAO * 0.93;
    }
    rings.push(ring);
  }

  const tc = { x: 0, y: 2.62, z: 0, r: 1, g: 1, b: 1 };
  const bc = { x: 0, y: -0.92, z: 0, r: 1, g: 1, b: 1 };
  const geom = buildLoftedPrism(rings, tc, bc);
  computeCreasedNormals(geom, 32);
  return geom;
}

/**
 * Builds a low-hugging smoothly rounded-battered masonry buttress pier integrated tightly into a bastion corner.
 */
function createHuggingCornerButtressGeometry() {
  const yStops = [
    -0.92, -0.45, 0.02,
    0.38, 0.42, 0.46, 0.76,
    1.00, 1.04, 1.08, 1.38,
    1.62, 1.66, 1.70, 1.95,
    2.16, 2.20, 2.24, 2.55, 2.84, 3.08
  ];
  const arcSegs = 6;
  const rings = [];

  for (let si = 0; si < yStops.length; si++) {
    const y = yStops[si];
    const u = clamp((y + 0.92) / (3.08 + 0.92), 0.0, 1.0);
    const tCurve = 1.0 - Math.pow(1.0 - u, 1.48);
    const seam =
      Math.exp(-Math.pow((y - 0.42) / 0.024, 2.0)) * 0.022 +
      Math.exp(-Math.pow((y - 1.04) / 0.024, 2.0)) * 0.022 +
      Math.exp(-Math.pow((y - 1.66) / 0.024, 2.0)) * 0.020 +
      Math.exp(-Math.pow((y - 2.20) / 0.024, 2.0)) * 0.018;
    const zI = mix(1.48, 1.28, u);
    const zO = mix(2.96, 1.76, tCurve) - seam;
    const w = mix(0.68, 0.44, tCurve) - seam * 0.6;
    const ch = mix(0.24, 0.14, tCurve);
    const ao = clamp(1.0 - seam * 6.0, 0.74, 1.0);
    const ring = [];
    // Smooth rounded outer face across (+w -> -w) at zO
    for (let i = 0; i <= arcSegs; i++) {
      const a = (i / arcSegs) * (Math.PI * 0.5);
      ring.push({ x: (w - ch) + Math.cos(a) * ch, y, z: (zO - ch) + Math.sin(a) * ch, r: ao, g: ao * 0.97, b: ao * 0.94 });
    }
    for (let i = 0; i <= arcSegs; i++) {
      const a = Math.PI * 0.5 + (i / arcSegs) * (Math.PI * 0.5);
      ring.push({ x: -(w - ch) + Math.cos(a) * ch, y, z: (zO - ch) + Math.sin(a) * ch, r: ao, g: ao * 0.97, b: ao * 0.94 });
    }
    ring.push({ x: -w, y, z: zI + ch, r: ao, g: ao * 0.97, b: ao * 0.94 });
    ring.push({ x: -(w - ch), y, z: zI, r: ao, g: ao * 0.97, b: ao * 0.94 });
    ring.push({ x: w - ch, y, z: zI, r: ao, g: ao * 0.97, b: ao * 0.94 });
    ring.push({ x: w, y, z: zI + ch, r: ao, g: ao * 0.97, b: ao * 0.94 });
    rings.push(ring);
  }

  const tc = { x: 0, y: 3.08, z: (1.28 + 1.76) * 0.5, r: 1, g: 1, b: 1 };
  const bc = { x: 0, y: -0.92, z: (1.48 + 2.96) * 0.5, r: 1, g: 1, b: 1 };
  const geom = buildLoftedPrism(rings, tc, bc);
  computeCreasedNormals(geom, 38);
  return geom;
}

function applyVerticalWindStreaks(geom, strength = 0.09) {
  const pos = geom.attributes.position;
  if (!pos) return geom;
  let col = geom.attributes.color;
  if (!col) {
    const arr = new Float32Array(pos.count * 3);
    arr.fill(1.0);
    col = new THREE.BufferAttribute(arr, 3);
    geom.setAttribute('color', col);
  }
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const coarseStreak = vnoise3(x * 4.4, y * 0.20, z * 4.4) - 0.5;
    const fineScour = vnoise3(x * 10.8 + 3.1, y * 0.42, z * 10.8 - 2.7) - 0.5;
    const basalScour = 1.0 + (1.0 - smoothstep(0.0, 4.8, y)) * 0.45;
    const streak = 1.0 + (coarseStreak * 0.68 + fineScour * 0.32) * strength * basalScour;
    col.setXYZ(i, clamp(col.getX(i) * streak, 0, 1), clamp(col.getY(i) * streak, 0, 1), clamp(col.getZ(i) * streak, 0, 1));
  }
  return geom;
}

function buildWindtrapSpire(parentGroup, atmoUniforms = FALLBACK_ATMO_UNIFORMS) {
  const spireX = -21.0;
  const spireZ = -25.0;
  const baseY = getGroundHeight(spireX, spireZ);

  const windtrapGroup = new THREE.Group();
  windtrapGroup.name = 'FremenWindtrapSpire';
  windtrapGroup.position.set(spireX, baseY, spireZ);
  // Crisp +0.04 rad orientation widens sunlit +X flank ~45%+ toward dawn & noon cameras while framing front pilasters
  windtrapGroup.rotation.y = 0.04;

  const stoneMat = enhanceSandstoneMaterial(
    createSandstonePhysicalMaterial({
      vertexColors: true,
      roughness: 0.86
    }),
    {
      strataFreq: 13.0,
      bumpStrength: 0.20,
      dustStrength: 0.20,
      varnishStrength: 0.04,
      sandApronStrength: 0.58,
      apronRange: 0.24,
      apronSlopeMin: 0.62,
      sandFilletStrength: 0.92,
      sandFilletHeight: 0.82,
      dressedStone: 1.0,
      baseOffset: -0.02,
      atmoUniforms
    }
  );

  const slateTrimMat = enhanceSandstoneMaterial(
    createSandstonePhysicalMaterial({
      vertexColors: true,
      roughness: 0.85
    }),
    {
      strataFreq: 15.0,
      bumpStrength: 0.14,
      dustStrength: 0.15,
      varnishStrength: 0.02,
      sandApronStrength: 0.28,
      apronRange: 0.20,
      apronSlopeMin: 0.68,
      dressedStone: 1.0,
      baseOffset: 0.48,
      atmoUniforms
    }
  );

  const bronzeMat = enhanceMetalMaterial(
    new THREE.MeshStandardMaterial({
      color: 0x8d6a47,
      vertexColors: true,
      roughness: 0.58,
      metalness: 0.36
    }),
    'bronze',
    atmoUniforms
  );

  const darkIntakeMat = enhanceMetalMaterial(
    new THREE.MeshStandardMaterial({
      color: 0x2c1f16,
      vertexColors: true,
      roughness: 0.94,
      metalness: 0.04
    }),
    'intake',
    atmoUniforms
  );

  // Strictly zero glow in daylight; subtle recessed warm ember at dusk/night only
  const amberGlowMat = new THREE.MeshStandardMaterial({
    color: 0x1a110b,
    emissive: 0xd15815,
    emissiveIntensity: 0.0,
    roughness: 0.60,
    metalness: 0.05
  });

  // Monolithic Fremen Badgir Sun-Baked Travertine & Muted Slate Wind-Catcher Bastion
  // Sinks solid battered stone plinth -0.92m cleanly into terrainMath.js wind-drifted mound!
  const stoneParts = [];
  const trimParts = [];
  const bronzeParts = [];
  const darkIntakeParts = [];

  // 1. Smoothly Concave-Battered Sun-Baked Travertine Plinth (-0.92m .. +2.62m) — 40-segment smooth rounded corners
  const batteredPlinth = createSmoothBatteredPlinthGeometry();
  stoneParts.push(applyVerticalWindStreaks(preparePart(batteredPlinth, 0xc79968, 0.045), 0.10));
  batteredPlinth.dispose();

  // Warm smooth 32-segment curved sandstone stringcourse molding (+2.58m .. +2.94m)
  const stringcourseStops = [];
  for (let i = 0; i <= 6; i++) {
    const u = i / 6;
    const swell = Math.sin(u * Math.PI);
    const r = mix(2.00, 1.92, u) + swell * 0.16;
    stringcourseStops.push({ y: mix(2.58, 2.94, u), r, ch: r * 0.31 });
  }
  const stringcourseMolding = createSmoothProfiledLoft(stringcourseStops, {
    arcSegs: 6,
    flatSegs: 2,
    creaseDeg: 48
  });
  stoneParts.push(preparePart(stringcourseMolding, 0xc99c6c, 0.04));

  // 4 Low-Hugging Smoothly Rounded Travertine Buttress Piers integrated tightly along bastion corners (-0.92m .. +3.08m)
  const buttressBase = createHuggingCornerButtressGeometry();
  for (let k = 0; k < 4; k++) {
    const a = (k + 0.5) * Math.PI * 0.5;
    const bMesh = buttressBase.clone();
    bMesh.rotateY(a);
    stoneParts.push(applyVerticalWindStreaks(preparePart(bMesh, 0xc19262, 0.045), 0.10));
  }
  buttressBase.dispose();

  // Inner recessed condenser shaft backing (+2.85m .. +7.85m) deeply behind the sandstone jambs & louver baffles
  const coreShaft = createChamferedBatteredPrism({
    rxBot: 0.96,
    rzBot: 0.96,
    rxTop: 0.86,
    rzTop: 0.86,
    chamferBot: 0.26,
    chamferTop: 0.22,
    yBot: 2.85,
    yTop: 7.85,
    segSteps: 3
  });
  darkIntakeParts.push(preparePart(coreShaft, 0xffffff, 0.03));

  // 4 Massive Stepped Sun-Baked Travertine Corner Pilasters (+2.85m .. +9.56m)
  // Crisp dressed stone courses with recessed mortar shadow reveals & vertical moisture-condenser ribs
  const coursePalette = [0xd2a676, 0xba8a59, 0xcca06f, 0xb48353, 0xc79867, 0xbe8e5e, 0xd4a978];
  const courseStops = [2.85, 3.84, 4.86, 5.90, 6.94, 7.78, 8.66, 9.56];
  for (let k = 0; k < 4; k++) {
    const a = (k + 0.5) * Math.PI * 0.5;
    for (let ci = 0; ci < courseStops.length - 1; ci++) {
      const y0 = courseStops[ci];
      const y1 = courseStops[ci + 1];
      const hasMortarGap = ci < courseStops.length - 2;
      const mortarH = hasMortarGap ? 0.042 : 0.0;
      const yBlockTop = y1 - mortarH;
      const t0 = (y0 - 2.85) / (9.56 - 2.85);
      const t1 = (yBlockTop - 2.85) / (9.56 - 2.85);
      const r0 = mix(0.60, 0.48, t0);
      const r1 = mix(0.60, 0.48, t1);
      const cBlock = createChamferedBatteredPrism({
        rxBot: r0,
        rzBot: r0,
        rxTop: r1,
        rzTop: r1,
        chamferBot: r0 * 0.28,
        chamferTop: r1 * 0.28,
        yBot: y0,
        yTop: yBlockTop,
        fluteDepth: 0.022,
        fluteFreq: 2.0,
        segSteps: 3
      });
      cBlock.translate(0, 0, 1.62);
      cBlock.rotateY(a);
      stoneParts.push(
        applyVerticalWindStreaks(preparePart(cBlock, coursePalette[ci % coursePalette.length], 0.03), 0.11)
      );

      if (hasMortarGap) {
        const rm = mix(0.60, 0.48, (y1 - 2.85) / (9.56 - 2.85)) - 0.044;
        const mortarJoint = createChamferedBatteredPrism({
          rxBot: rm,
          rzBot: rm,
          rxTop: rm,
          rzTop: rm,
          chamferBot: rm * 0.28,
          chamferTop: rm * 0.28,
          yBot: yBlockTop - 0.004,
          yTop: y1 + 0.004,
          segSteps: 1
        });
        mortarJoint.translate(0, 0, 1.61);
        mortarJoint.rotateY(a);
        stoneParts.push(preparePart(mortarJoint, 0x6d4728, 0.02));
      }
    }

    // Twin slim vertical battered structural corner ribs framing a recessed moisture-condenser stone flute
    for (const side of [-1, 1]) {
      const cornerRib = createChamferedBatteredPrism({
        rxBot: 0.068,
        rzBot: 0.072,
        rxTop: 0.054,
        rzTop: 0.058,
        chamferBot: 0.020,
        chamferTop: 0.016,
        yBot: 2.86,
        yTop: 9.54,
        segSteps: 4
      });
      cornerRib.translate(side * 0.29, 0, 2.18);
      // Taper rib inward along the tower batter smoothly
      const ribPos = cornerRib.attributes.position;
      for (let vi = 0; vi < ribPos.count; vi++) {
        const ry = ribPos.getY(vi);
        const rt = clamp((ry - 2.86) / (9.54 - 2.86), 0, 1);
        ribPos.setX(vi, ribPos.getX(vi) - side * rt * 0.065);
        ribPos.setZ(vi, ribPos.getZ(vi) - rt * 0.115);
      }
      computeCreasedNormals(cornerRib, 30);
      cornerRib.rotateY(a);
      stoneParts.push(applyVerticalWindStreaks(preparePart(cornerRib, 0xcfa373, 0.03), 0.05));
    }
  }

  // Upper louver chamber recessed shadow throat rings, central core & corner shadow baffles
  const chamberFloorShadow = createChamferedBatteredPrism({
    rxBot: 1.06,
    rzBot: 1.06,
    rxTop: 0.92,
    rzTop: 0.92,
    chamferBot: 0.28,
    chamferTop: 0.22,
    yBot: 7.82,
    yTop: 8.04,
    segSteps: 1
  });
  darkIntakeParts.push(preparePart(chamberFloorShadow, 0xcac0b6, 0.02));

  const chamberCeilingShadow = createChamferedBatteredPrism({
    rxBot: 0.90,
    rzBot: 0.90,
    rxTop: 1.10,
    rzTop: 1.10,
    chamferBot: 0.22,
    chamferTop: 0.28,
    yBot: 9.36,
    yTop: 9.56,
    segSteps: 1
  });
  darkIntakeParts.push(preparePart(chamberCeilingShadow, 0xb8aea4, 0.02));

  const chamberCoreShadow = new THREE.CylinderGeometry(0.38, 0.40, 1.56, 16);
  chamberCoreShadow.translate(0, 8.70, 0);
  darkIntakeParts.push(preparePart(chamberCoreShadow, 0xb0a49a, 0.02));

  for (let k = 0; k < 4; k++) {
    const a = (k + 0.5) * Math.PI * 0.5;
    const innerPierShadow = new THREE.BoxGeometry(0.38, 1.64, 0.38);
    innerPierShadow.translate(0, 8.70, 1.12);
    innerPierShadow.rotateY(a);
    darkIntakeParts.push(preparePart(innerPierShadow, 0xc0b6ac, 0.02));
  }

  // 4 Cardinal Monumental Vertical Badgir Wind-Catcher Bays (y = 2.90m .. 7.66m) + Upper Louvered Turbine Bays (7.88..9.54m)
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI * 0.5;

    // Warm golden sandstone sill & lintel framing the recessed vertical badgir vent bay
    const baySill = createChamferedBatteredPrism({
      rxBot: 1.02,
      rzBot: 0.28,
      rxTop: 0.98,
      rzTop: 0.26,
      chamferBot: 0.05,
      chamferTop: 0.05,
      yBot: 2.88,
      yTop: 3.06,
      segSteps: 1
    });
    baySill.translate(0, 0, 1.28);
    baySill.rotateY(a);
    stoneParts.push(preparePart(baySill, 0xcb9d6c, 0.035));

    const midLintel = createChamferedBatteredPrism({
      rxBot: 1.04,
      rzBot: 0.30,
      rxTop: 1.06,
      rzTop: 0.32,
      chamferBot: 0.05,
      chamferTop: 0.05,
      yBot: 7.56,
      yTop: 7.80,
      segSteps: 1
    });
    midLintel.translate(0, 0, 1.26);
    midLintel.rotateY(a);
    stoneParts.push(preparePart(midLintel, 0xcda272, 0.035));

    // Recessed horizontal masonry reveal frieze groove directly beneath midLintel & capCornice
    const lintelReveal = createChamferedBatteredPrism({
      rxBot: 0.98,
      rzBot: 0.24,
      rxTop: 0.98,
      rzTop: 0.24,
      chamferBot: 0.04,
      chamferTop: 0.04,
      yBot: 7.52,
      yTop: 7.57,
      segSteps: 1
    });
    lintelReveal.translate(0, 0, 1.24);
    lintelReveal.rotateY(a);
    stoneParts.push(preparePart(lintelReveal, 0x865d3a, 0.02));

    // Slim vertical battered structural pilaster ribs + moisture-condenser exterior stone flutes flanking each bay
    for (const side of [-1, 1]) {
      const bayRib = createChamferedBatteredPrism({
        rxBot: 0.080,
        rzBot: 0.095,
        rxTop: 0.066,
        rzTop: 0.078,
        chamferBot: 0.024,
        chamferTop: 0.020,
        yBot: 2.88,
        yTop: 9.54,
        segSteps: 4
      });
      bayRib.translate(side * 0.76, 0, 1.58);
      const bPos = bayRib.attributes.position;
      for (let vi = 0; vi < bPos.count; vi++) {
        const ry = bPos.getY(vi);
        const rt = clamp((ry - 2.88) / (9.54 - 2.88), 0, 1);
        bPos.setX(vi, bPos.getX(vi) - side * rt * 0.045);
        bPos.setZ(vi, bPos.getZ(vi) - rt * 0.140);
      }
      computeCreasedNormals(bayRib, 30);
      bayRib.rotateY(a);
      stoneParts.push(applyVerticalWindStreaks(preparePart(bayRib, 0xd0a474, 0.035), 0.05));

      const condenserFlute = createChamferedBatteredPrism({
        rxBot: 0.044,
        rzBot: 0.068,
        rxTop: 0.036,
        rzTop: 0.056,
        chamferBot: 0.014,
        chamferTop: 0.012,
        yBot: 2.92,
        yTop: 9.50,
        segSteps: 4
      });
      condenserFlute.translate(side * 0.95, 0, 1.77);
      const fPos = condenserFlute.attributes.position;
      for (let vi = 0; vi < fPos.count; vi++) {
        const ry = fPos.getY(vi);
        const rt = clamp((ry - 2.92) / (9.50 - 2.92), 0, 1);
        fPos.setX(vi, fPos.getX(vi) - side * rt * 0.050);
        fPos.setZ(vi, fPos.getZ(vi) - rt * 0.145);
      }
      computeCreasedNormals(condenserFlute, 30);
      condenserFlute.rotateY(a);
      stoneParts.push(applyVerticalWindStreaks(preparePart(condenserFlute, 0xc89a69, 0.035), 0.05));

      // Horizontal masonry course tie-bands on side flanks between ribs (leaving central intake slot clean)
      for (const cy of [4.84, 6.92, 8.64]) {
        const ct = clamp((cy - 2.88) / (9.54 - 2.88), 0, 1);
        const tieBand = createChamferedBatteredPrism({
          rxBot: 0.18,
          rzBot: 0.055,
          rxTop: 0.18,
          rzTop: 0.055,
          chamferBot: 0.018,
          chamferTop: 0.018,
          yBot: cy - 0.020,
          yTop: cy + 0.020,
          segSteps: 1
        });
        tieBand.translate(side * mix(0.88, 0.82, ct), 0, mix(1.73, 1.58, ct));
        tieBand.rotateY(a);
        stoneParts.push(preparePart(tieBand, 0x8a613c, 0.02));
      }
    }

    // Splayed chamfered sandstone side jamb bevels catching warm sunlight into the intake recess
    for (const side of [-1, 1]) {
      const lowerJamb = createChamferedBatteredPrism({
        rxBot: 0.145,
        rzBot: 0.24,
        rxTop: 0.135,
        rzTop: 0.21,
        chamferBot: 0.045,
        chamferTop: 0.042,
        yBot: 2.94,
        yTop: 7.62,
        segSteps: 3
      });
      lowerJamb.rotateY(side * 0.34);
      lowerJamb.translate(side * 0.64, 0, 1.20);
      lowerJamb.rotateY(a);
      stoneParts.push(applyVerticalWindStreaks(preparePart(lowerJamb, 0xc99c6b, 0.035), 0.05));

      // Recessed dark-AO side cheek baffle lining inside lower vent chamber
      const lowerCheekShadow = new THREE.BoxGeometry(0.08, 4.54, 0.22);
      lowerCheekShadow.translate(side * 0.56, 5.28, 1.03);
      lowerCheekShadow.rotateY(a);
      darkIntakeParts.push(preparePart(lowerCheekShadow, 0xb8aea4, 0.02));
    }

    // Recessed dark-AO inner chamber backing plate behind the lower louvers
    const lowerChamberBack = new THREE.BoxGeometry(1.16, 4.56, 0.08);
    lowerChamberBack.translate(0, 5.28, 0.94);
    lowerChamberBack.rotateY(a);
    darkIntakeParts.push(preparePart(lowerChamberBack, 0xa89d92, 0.02));

    // Central sculpted chamfered sandstone divider rib (wide dual intake channels clearly revealing interior louvers!)
    const centerFin = createChamferedBatteredPrism({
      rxBot: 0.070,
      rzBot: 0.22,
      rxTop: 0.058,
      rzTop: 0.19,
      chamferBot: 0.025,
      chamferTop: 0.022,
      yBot: 2.94,
      yTop: 7.64,
      segSteps: 3
    });
    centerFin.translate(0, 0, 1.24);
    centerFin.rotateY(a);
    stoneParts.push(applyVerticalWindStreaks(preparePart(centerFin, 0xd0a474, 0.035), 0.05));

    // Recessed warm-lit weathered bronze & sandstone interior louver bars stepped inside the vertical vent recess
    for (let li = 0; li < 11; li++) {
      const ly = 3.28 + li * 0.40;
      const louverBar = new THREE.BoxGeometry(1.08, 0.066, 0.22);
      // Outward-downward weather-shedding tilt (+0.42 rad) so upper faces catch sun & sky bounce!
      louverBar.rotateX(0.42);
      louverBar.translate(0, ly, 1.12);
      louverBar.rotateY(a);
      if (li % 3 === 1) {
        stoneParts.push(preparePart(louverBar, 0xcfa272, 0.035));
      } else {
        bronzeParts.push(preparePart(louverBar, 0xe8d3b8, 0.04));
      }
    }

    // Vertical dark-bronze tie rods behind the stone divider & louvers
    for (const gx of [-0.32, 0.0, 0.32]) {
      const grilleBar = new THREE.BoxGeometry(0.030, 4.54, 0.065);
      grilleBar.translate(gx, 5.28, 0.99);
      grilleBar.rotateY(a);
      bronzeParts.push(preparePart(grilleBar, 0xd8c2a6, 0.04));
    }

    // Splayed chamfered sandstone jamb bevels framing the sheltered upper turbine chamber bay (y = 7.88m .. 9.54m)
    for (const side of [-1, 1]) {
      const upperJamb = createChamferedBatteredPrism({
        rxBot: 0.125,
        rzBot: 0.19,
        rxTop: 0.118,
        rzTop: 0.18,
        chamferBot: 0.038,
        chamferTop: 0.036,
        yBot: 7.88,
        yTop: 9.54,
        segSteps: 2
      });
      upperJamb.rotateY(side * 0.32);
      upperJamb.translate(side * 0.66, 0, 1.19);
      upperJamb.rotateY(a);
      stoneParts.push(applyVerticalWindStreaks(preparePart(upperJamb, 0xc99c6b, 0.035), 0.05));

      const upperCheekShadow = new THREE.BoxGeometry(0.08, 1.62, 0.24);
      upperCheekShadow.translate(side * 0.58, 8.70, 1.02);
      upperCheekShadow.rotateY(a);
      darkIntakeParts.push(preparePart(upperCheekShadow, 0xb6aca2, 0.02));
    }

    // Visible warm-lit weathered bronze & sandstone angled louver baffle slats across upper chamber (stepped inside recess!)
    for (let ui = 0; ui < 5; ui++) {
      const ly = 8.08 + ui * 0.32;
      const baffle = new THREE.BoxGeometry(1.20, 0.066, 0.24);
      // Fixed outward-downward tilt (+0.42 rad) catching sunlight & warm sky highlights instead of facing down into darkness!
      baffle.rotateX(0.42);
      baffle.translate(0, ly, 1.15);
      baffle.rotateY(a);
      if (ui === 0 || ui === 4) {
        stoneParts.push(preparePart(baffle, 0xcfa171, 0.035));
      } else {
        bronzeParts.push(preparePart(baffle, 0xe8d3b8, 0.04));
      }
    }
    for (const mx of [-0.34, 0.34]) {
      const mullion = new THREE.CylinderGeometry(0.020, 0.020, 1.62, 8);
      mullion.translate(mx, 8.70, 1.16);
      mullion.rotateY(a);
      bronzeParts.push(preparePart(mullion, 0xe4ceb2, 0.04));
    }
  }

  // Smooth 32-segment muted slate turbine deck reveal lip tucked inside midLintel (+7.76m .. +7.92m)
  const shroudFloor = createSmoothProfiledLoft(
    [
      { y: 7.76, r: 1.44, ch: 0.44 },
      { y: 7.82, r: 1.42, ch: 0.43 },
      { y: 7.87, r: 1.39, ch: 0.42 },
      { y: 7.92, r: 1.36, ch: 0.41 }
    ],
    { arcSegs: 6, flatSegs: 2, creaseDeg: 44 }
  );
  trimParts.push(preparePart(shroudFloor, 0x6b5340, 0.04));

  // Smooth 32-segment Curved Overhanging Golden Travertine & Muted Slate Canopy Hood (+9.50m .. +10.78m)
  const soffitStops = [];
  for (let i = 0; i <= 6; i++) {
    const u = i / 6;
    const ease = u * u * (3 - 2 * u);
    const r = mix(1.56, 1.94, ease);
    soffitStops.push({ y: mix(9.50, 9.75, u), r, ch: r * 0.33 });
  }
  const corniceSoffit = createSmoothProfiledLoft(soffitStops, { arcSegs: 6, flatSegs: 2, creaseDeg: 52 });
  trimParts.push(preparePart(corniceSoffit, 0x6b5340, 0.04));

  const corniceStops = [];
  for (let i = 0; i <= 7; i++) {
    const u = i / 7;
    const bullnose = Math.sin(u * Math.PI) * 0.055;
    const r = mix(1.94, 1.72, u * 0.85) + bullnose;
    corniceStops.push({ y: mix(9.74, 10.08, u), r, ch: r * 0.34 });
  }
  const capCornice = createSmoothProfiledLoft(corniceStops, { arcSegs: 6, flatSegs: 2, creaseDeg: 52 });
  stoneParts.push(preparePart(capCornice, 0xd2a878, 0.05));

  const parapetStops = [];
  for (let i = 0; i <= 8; i++) {
    const u = i / 8;
    const archCurve = 1.0 - Math.pow(u, 1.25);
    const r = mix(1.14, 1.56, archCurve);
    const ch = mix(0.49, 0.56, archCurve);
    parapetStops.push({
      y: mix(10.06, 10.42, u),
      r,
      ch,
      fluteDepth: 0.020 * (1.0 - u * 0.6)
    });
  }
  const capParapet = createSmoothProfiledLoft(parapetStops, { arcSegs: 6, flatSegs: 2, creaseDeg: 54 });
  stoneParts.push(preparePart(capParapet, 0xc89a68, 0.05));

  const domeStops = [];
  for (let i = 0; i <= 10; i++) {
    const u = i / 10;
    // Smooth elliptical vaulted dome hood tapering cleanly toward apex (zero faceted octagon cap!)
    const domeCos = Math.pow(Math.cos(u * Math.PI * 0.44), 0.82);
    const r = 1.15 * domeCos;
    const ch = mix(r * 0.44, r * 0.94, smoothstep(0.15, 0.95, u));
    domeStops.push({ y: mix(10.40, 10.76, Math.sin(u * Math.PI * 0.5)), r, ch });
  }
  const capRoof = createSmoothProfiledLoft(domeStops, {
    arcSegs: 6,
    flatSegs: 2,
    creaseDeg: 58,
    topCapY: 10.78
  });
  trimParts.push(preparePart(capRoof, 0x6b5340, 0.04));

  const stoneBodyMesh = new THREE.Mesh(mergePreparedParts(stoneParts), stoneMat);
  stoneBodyMesh.castShadow = true;
  stoneBodyMesh.receiveShadow = true;
  windtrapGroup.add(stoneBodyMesh);

  const trimMesh = new THREE.Mesh(mergePreparedParts(trimParts), slateTrimMat);
  trimMesh.castShadow = true;
  trimMesh.receiveShadow = true;
  windtrapGroup.add(trimMesh);

  const bronzeStaticMesh = new THREE.Mesh(mergePreparedParts(bronzeParts), bronzeMat);
  bronzeStaticMesh.castShadow = true;
  bronzeStaticMesh.receiveShadow = true;
  windtrapGroup.add(bronzeStaticMesh);

  const darkIntakeMesh = new THREE.Mesh(mergePreparedParts(darkIntakeParts), darkIntakeMat);
  darkIntakeMesh.castShadow = true;
  darkIntakeMesh.receiveShadow = true;
  windtrapGroup.add(darkIntakeMesh);

  // Subtle organic wind-drifted sandstone talus/sand collar wrapping the Windtrap plinth footing (-21, -25)
  const driftCollarMat = enhanceSandstoneMaterial(
    createSandstonePhysicalMaterial({
      vertexColors: true,
      roughness: 0.92
    }),
    {
      strataFreq: 8.0,
      bumpStrength: 0.04,
      dustStrength: 0.0,
      varnishStrength: 0.0,
      pureSandMix: 0.96,
      baseOffset: 0.0,
      atmoUniforms
    }
  );
  const wtCos = Math.cos(windtrapGroup.rotation.y);
  const wtSin = Math.sin(windtrapGroup.rotation.y);
  const collarProfile = [
    { scale: 1.50, lift: 0.00, bury: 0.24 },
    { scale: 1.34, lift: 0.05, bury: 0.0 },
    { scale: 1.18, lift: 0.20, bury: 0.0 },
    { scale: 1.05, lift: 0.42, bury: 0.0 },
    { scale: 0.90, lift: 0.56, bury: 0.0 }
  ];
  const collarRings = [];
  const collarBaseR = 3.04;
  const collarBaseCh = 0.92;
  for (let ri = 0; ri < collarProfile.length; ri++) {
    const cp = collarProfile[ri];
    const baseRing = buildRoundedChamferRing(collarBaseR * cp.scale, collarBaseR * cp.scale, collarBaseCh * cp.scale, 0.0, {
      arcSegs: 7,
      flatSegs: 3
    });
    for (let vi = 0; vi < baseRing.length; vi++) {
      const v = baseRing[vi];
      const wx = spireX + v.x * wtCos + v.z * wtSin;
      const wz = spireZ - v.x * wtSin + v.z * wtCos;
      const localTerrainY = getGroundHeight(wx, wz) - baseY;
      const leeDot = (v.x * wtCos + v.z * wtSin) * WIND_COS + (-v.x * wtSin + v.z * wtCos) * WIND_SIN;
      const leeNorm = clamp(leeDot / Math.max(1.0, Math.hypot(v.x, v.z)), -1.0, 1.0);
      const driftWave = (fbm3(wx * 0.45, 0.5, wz * 0.45, 2) - 0.5) * 0.16;
      const pathClear = smoothstep(0.65, 1.55, getPathDistance(wx, wz).dist);
      const moundLift = Math.max(0.0, (cp.lift + (0.5 + 0.5 * leeNorm) * cp.lift * 0.45 + driftWave * (cp.lift > 0.05 ? 1.0 : 0.25)) * pathClear);
      v.y = localTerrainY + moundLift - cp.bury;
    }
    collarRings.push(baseRing);
  }
  const collarGeom = buildLoftedPrism(collarRings, null, null);
  computeCreasedNormals(collarGeom, 55);
  const driftCollarMesh = new THREE.Mesh(collarGeom, driftCollarMat);
  driftCollarMesh.castShadow = false;
  driftCollarMesh.receiveShadow = true;
  windtrapGroup.add(driftCollarMesh);

  // Quiet Internal Dark Spinning Bronze Turbine sheltered under cornice (y = 8.70m)
  const rotorGroup = new THREE.Group();
  rotorGroup.name = 'WindtrapRotor';
  rotorGroup.position.set(0, 8.70, 0);

  const rotorBasaltParts = [];
  const rotorBronzeParts = [];

  const driveShaft = new THREE.CylinderGeometry(0.11, 0.13, 1.72, 12);
  rotorBasaltParts.push(preparePart(driveShaft, 0x6b5340, 0.04));

  for (const hy of [-0.72, 0.0, 0.72]) {
    const hub = createChamferedCollarGeometry(0.10, 0.26, 0.15, 12);
    hub.translate(0, hy, 0);
    rotorBronzeParts.push(preparePart(hub, 0xc49c70, 0.04));
  }

  const vaneBase = createTurbineScoopVaneGeometry(1.48, 0.86);
  for (let s = 0; s < 4; s++) {
    const a = (s / 4) * Math.PI * 2;
    const vane = vaneBase.clone();
    vane.rotateY(a);
    rotorBronzeParts.push(preparePart(vane, 0xc49c70, 0.04));

    for (const sy of [-0.58, 0.58]) {
      const arm = new THREE.BoxGeometry(0.56, 0.06, 0.08);
      arm.translate(0.32, sy, 0);
      arm.rotateY(a);
      rotorBasaltParts.push(preparePart(arm, 0x6b5340, 0.04));
    }
  }
  vaneBase.dispose();

  const rotorBasaltMesh = new THREE.Mesh(mergePreparedParts(rotorBasaltParts), darkIntakeMat);
  rotorBasaltMesh.castShadow = true;
  rotorBasaltMesh.receiveShadow = true;
  rotorGroup.add(rotorBasaltMesh);

  const rotorBronzeMesh = new THREE.Mesh(mergePreparedParts(rotorBronzeParts), bronzeMat);
  rotorBronzeMesh.castShadow = true;
  rotorBronzeMesh.receiveShadow = true;
  rotorGroup.add(rotorBronzeMesh);

  windtrapGroup.add(rotorGroup);

  // Subtle interior turbine-chamber condenser glow ONLY at dusk/night (strictly 0.0 in daylight, no vertical slit!)
  const chamberGlowMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.36, 12), amberGlowMat);
  chamberGlowMesh.position.set(0, 8.10, 0);
  windtrapGroup.add(chamberGlowMesh);

  const lanternLight = new THREE.PointLight(0xd96820, 0.0, 10.0, 2.0);
  lanternLight.position.set(0, 8.20, 0);
  lanternLight.castShadow = false;
  windtrapGroup.add(lanternLight);

  parentGroup.add(windtrapGroup);

  let rotorAngle = 0;
  return function updateWindtrap(dt, worldState) {
    const windSpeed = worldState ? worldState.windSpeed : 0.45;
    const elapsed = worldState ? worldState.elapsed : 0;

    const omega = 0.48 + windSpeed * 1.15;
    rotorAngle = (rotorAngle + dt * omega) % (Math.PI * 2);
    rotorGroup.rotation.y = rotorAngle;

    const sunY = worldState && worldState.sunDir ? worldState.sunDir.y : 0.25;
    const eclipse = worldState ? worldState.eclipseStrength || 0 : 0;
    const duskNight = clamp(1.0 - smoothstep(-0.08, 0.02, sunY), 0, 1);
    const glowFactor = Math.max(duskNight, eclipse * 0.35);
    const flicker = 0.94 + 0.06 * Math.sin(elapsed * 4.2) * Math.cos(elapsed * 2.7);
    amberGlowMat.emissiveIntensity = glowFactor * 0.16 * flicker;
    lanternLight.intensity = glowFactor * 0.42 * flicker;
  };
}

// ---------------------------------------------------------------------------
// 4. Brutalist Fremen Thumper (worldState.thumper.position)
// ---------------------------------------------------------------------------

function createHelicalSpringGeometry(turns = 8, radius = 0.165, wireRadius = 0.024, restHeight = 0.68) {
  const pts = [];
  const steps = turns * 14;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ang = t * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(ang) * radius, t * restHeight, Math.sin(ang) * radius));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  return new THREE.TubeGeometry(curve, steps, wireRadius, 8, false);
}

function createShockwaveRingMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uProgress: { value: 1.0 },
      uOpacity: { value: 0.0 },
      uTime: { value: 0.0 }
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uProgress;
      uniform float uOpacity;
      uniform float uTime;
      varying vec2 vUv;
      ${NOISE_GLSL}

      void main() {
        vec2 centered = (vUv - 0.5) * 2.0;
        float r = length(centered);
        if (r > 1.0) discard;

        float ang = atan(centered.y, centered.x);
        float dustNoise = fbm2(vec2(cos(ang) * 3.5 + uTime * 0.6, sin(ang) * 3.5 - uProgress * 4.0));

        float ringRadius = mix(0.14, 0.92, uProgress);
        float bandWidth = mix(0.08, 0.16, uProgress);
        float outerWave = exp(-pow((r - ringRadius) / bandWidth, 2.0));
        float secondaryWave = exp(-pow((r - ringRadius * 0.68) / (bandWidth * 0.65), 2.0)) * 0.55;

        float energy = (outerWave + secondaryWave) * (0.65 + 0.55 * dustNoise);
        float radialFade = smoothstep(1.0, 0.80, r);
        float alpha = energy * radialFade * uOpacity;
        if (alpha < 0.005) discard;

        vec3 dustCol = vec3(0.86, 0.64, 0.38);
        vec3 shockAmber = vec3(1.0, 0.72, 0.30);
        vec3 col = mix(dustCol, shockAmber, clamp(outerWave * 0.85, 0.0, 1.0));
        gl_FragColor = vec4(col, alpha);
      }
    `
  });
}

function buildFremenThumper(parentGroup, worldState, atmoUniforms = FALLBACK_ATMO_UNIFORMS) {
  const thumperRoot = new THREE.Group();
  thumperRoot.name = 'FremenThumper';

  const initPos = worldState && worldState.thumper ? worldState.thumper.position : { x: 8.5, z: -14.5 };
  const initGroundY = getGroundHeight(initPos.x, initPos.z);
  thumperRoot.position.set(initPos.x, initGroundY, initPos.z);

  const thumperTilted = new THREE.Group();
  thumperTilted.rotation.set(0.05, 0.45, -0.04);
  thumperRoot.add(thumperTilted);

  const darkHousingMat = enhanceMetalMaterial(
    new THREE.MeshStandardMaterial({
      color: 0x56493f,
      vertexColors: true,
      roughness: 0.64,
      metalness: 0.42
    }),
    'bronze',
    atmoUniforms
  );

  const ochreBrassMat = enhanceMetalMaterial(
    new THREE.MeshStandardMaterial({
      color: 0x76624b,
      vertexColors: true,
      roughness: 0.56,
      metalness: 0.48
    }),
    'brass',
    atmoUniforms
  );

  const collarStoneMat = enhanceSandstoneMaterial(
    createSandstonePhysicalMaterial({
      vertexColors: true,
      roughness: 0.90
    }),
    {
      strataFreq: 12.0,
      bumpStrength: 0.24,
      dustStrength: 0.18,
      varnishStrength: 0.06,
      sandApronStrength: 0.42,
      apronRange: 0.20,
      apronSlopeMin: 0.66,
      baseOffset: 0.20,
      atmoUniforms
    }
  );

  const thumperGravelMat = enhanceSandstoneMaterial(
    createSandstonePhysicalMaterial({
      roughness: 0.92
    }),
    {
      strataFreq: 14.0,
      bumpStrength: 0.22,
      dustStrength: 0.22,
      varnishStrength: 0.10,
      sandApronStrength: 0.0,
      baseOffset: 0.0,
      atmoUniforms
    }
  );

  const pulseCoreMat = new THREE.MeshStandardMaterial({
    color: 0x52453b,
    emissive: 0xd96e1e,
    emissiveIntensity: 0.0,
    roughness: 0.72,
    metalness: 0.28
  });

  // 1. Scattered Gravel Embedded Directly into terrainMath.js Crater Mound Rim around 0.48m Base Collar
  const gRand = mulberry32(9917);
  const gravelBase = createScreeFragmentGeometry(991).geom;
  const gravelCount = 18;
  const gravelIM = new THREE.InstancedMesh(gravelBase, thumperGravelMat, gravelCount);
  gravelIM.castShadow = true;
  gravelIM.receiveShadow = true;
  const gDummy = new THREE.Object3D();
  const gTint = new THREE.Color();
  for (let i = 0; i < gravelCount; i++) {
    const a = (i / gravelCount) * Math.PI * 2 + (gRand() - 0.5) * 0.35;
    const rad = 0.48 + gRand() * 0.64;
    const gx = Math.cos(a) * rad;
    const gz = Math.sin(a) * rad;
    const localY = getGroundHeight(initPos.x + gx, initPos.z + gz) - initGroundY;
    const sc = 0.048 + gRand() * 0.056;
    gDummy.position.set(gx, localY + sc * 0.03, gz);
    gDummy.rotation.set((gRand() - 0.5) * 0.35, gRand() * Math.PI * 2, (gRand() - 0.5) * 0.35);
    gDummy.scale.set(sc * (0.9 + gRand() * 0.4), sc * 0.75, sc * (0.85 + gRand() * 0.4));
    gDummy.updateMatrix();
    gravelIM.setMatrixAt(i, gDummy.matrix);
    gTint.setHSL(0.068 + (gRand() - 0.5) * 0.01, 0.40 + gRand() * 0.08, 0.32 + gRand() * 0.06);
    gravelIM.setColorAt(i, gTint);
  }
  gravelIM.instanceMatrix.needsUpdate = true;
  if (gravelIM.instanceColor) gravelIM.instanceColor.needsUpdate = true;
  thumperRoot.add(gravelIM);

  // 2. Brutalist Sandstone-and-Dark-Bronze Anchor Collar (r ~ 0.48m) Seated Inside Crater + Unified Gunmetal Housing
  const stoneCollarParts = [];
  const baseSandstoneRing = createChamferedBatteredPrism({
    rxBot: 0.49,
    rzBot: 0.49,
    rxTop: 0.43,
    rzTop: 0.43,
    chamferBot: 0.14,
    chamferTop: 0.12,
    yBot: -0.34,
    yTop: 0.19,
    segSteps: 2
  });
  stoneCollarParts.push(preparePart(baseSandstoneRing, 0xb6895d, 0.05));

  for (let k = 0; k < 4; k++) {
    const gusset = createChamferedBatteredPrism({
      rxBot: 0.11,
      rzBot: 0.15,
      rxTop: 0.08,
      rzTop: 0.09,
      chamferBot: 0.025,
      chamferTop: 0.02,
      yBot: -0.08,
      yTop: 0.30,
      segSteps: 1
    });
    gusset.translate(0, 0, 0.34);
    gusset.rotateY((k * Math.PI) / 2);
    stoneCollarParts.push(preparePart(gusset, 0xa87c52, 0.05));
  }

  const collarStoneMesh = new THREE.Mesh(mergePreparedParts(stoneCollarParts), collarStoneMat);
  collarStoneMesh.castShadow = true;
  collarStoneMesh.receiveShadow = true;
  thumperTilted.add(collarStoneMesh);

  // Unified Weathered Gunmetal-Bronze Barrel, Collar Rings, Structural Tie-Bars & Guide Cage (no striped lighthouse!)
  const housingParts = [];
  const stake = new THREE.CylinderGeometry(0.14, 0.04, 1.38, 8);
  stake.translate(0, -0.08, 0);
  housingParts.push(preparePart(stake, 0xffffff, 0.05));

  const buriedFooting = new THREE.CylinderGeometry(0.28, 0.20, 0.48, 8);
  buriedFooting.translate(0, -0.22, 0);
  housingParts.push(preparePart(buriedFooting, 0xffffff, 0.04));

  const baseBronzeFlange = createChamferedCollarGeometry(0.14, 0.445, 0.095, 8);
  baseBronzeFlange.translate(0, 0.20, 0);
  housingParts.push(preparePart(baseBronzeFlange, 0xf2ebe2, 0.05));

  for (let k = 0; k < 4; k++) {
    const brace = new THREE.BoxGeometry(0.065, 0.24, 0.18);
    brace.rotateX(-0.35);
    brace.translate(0, 0.24, 0.34);
    brace.rotateY((k * Math.PI) / 2 + Math.PI * 0.25);
    housingParts.push(preparePart(brace, 0xf0e8de, 0.05));
  }

  const housingLower = createChamferedCollarGeometry(0.0, 0.22, 0.30, 12);
  housingLower.translate(0, 0.36, 0);
  housingParts.push(preparePart(housingLower, 0xffffff, 0.04));

  const lowerRing = createChamferedCollarGeometry(0.16, 0.275, 0.080, 12);
  lowerRing.translate(0, 0.49, 0);
  housingParts.push(preparePart(lowerRing, 0xeee4d8, 0.05));

  const housingCore = new THREE.CylinderGeometry(0.195, 0.195, 0.62, 12);
  housingCore.translate(0, 0.66, 0);
  housingParts.push(preparePart(housingCore, 0xffffff, 0.04));

  const midRing = createChamferedCollarGeometry(0.16, 0.285, 0.080, 12);
  midRing.translate(0, 0.74, 0);
  housingParts.push(preparePart(midRing, 0xeee4d8, 0.05));

  const housingUpper = createChamferedCollarGeometry(0.0, 0.235, 0.20, 12);
  housingUpper.translate(0, 0.90, 0);
  housingParts.push(preparePart(housingUpper, 0xffffff, 0.04));

  for (let r = 0; r < 8; r++) {
    const rib = new THREE.BoxGeometry(0.046, 0.56, 0.068);
    rib.translate(0, 0.62, 0.225);
    rib.rotateY((r / 8) * Math.PI * 2);
    housingParts.push(preparePart(rib, 0xffffff, 0.05));
  }

  // 3 sturdy full-height vertical guide channels & upper lugs unifying the silhouette vertically
  for (let r = 0; r < 3; r++) {
    const channel = new THREE.BoxGeometry(0.052, 0.86, 0.056);
    channel.translate(0, 0.64, 0.245);
    channel.rotateY((r / 3) * Math.PI * 2);
    housingParts.push(preparePart(channel, 0xf2eae0, 0.04));

    const rod = new THREE.CylinderGeometry(0.026, 0.026, 0.64, 8);
    rod.translate(0, 1.38, 0.225);
    rod.rotateY((r / 3) * Math.PI * 2);
    housingParts.push(preparePart(rod, 0xffffff, 0.04));

    const lug = createChamferedCollarGeometry(0.0, 0.050, 0.085, 8);
    lug.translate(0, 1.66, 0.225);
    lug.rotateY((r / 3) * Math.PI * 2);
    housingParts.push(preparePart(lug, 0xffffff, 0.04));
  }

  // Stepped dark gunmetal-bronze upper anvil cap
  const crownAnvilLower = createChamferedCollarGeometry(0.12, 0.355, 0.095, 8);
  crownAnvilLower.translate(0, 1.65, 0);
  housingParts.push(preparePart(crownAnvilLower, 0xf2eae0, 0.05));

  const crownMidTier = createChamferedCollarGeometry(0.0, 0.285, 0.11, 8);
  crownMidTier.translate(0, 1.72, 0);
  housingParts.push(preparePart(crownMidTier, 0xffffff, 0.04));

  const crownAnvilTop = createChamferedCollarGeometry(0.0, 0.225, 0.085, 8);
  crownAnvilTop.translate(0, 1.79, 0);
  housingParts.push(preparePart(crownAnvilTop, 0xf2eae0, 0.05));

  const staticHousingMesh = new THREE.Mesh(mergePreparedParts(housingParts), darkHousingMat);
  staticHousingMesh.castShadow = true;
  staticHousingMesh.receiveShadow = true;
  thumperTilted.add(staticHousingMesh);

  // 3. Subtle Brushed Weathered Bronze Highlights on Functional Anvil Impact Lip & Crown Pin
  const brassParts = [];

  // Mid stepped impact anvil plate (subdued weathered bronze)
  const anvilPlate = createChamferedCollarGeometry(0.10, 0.365, 0.115, 12);
  anvilPlate.translate(0, 1.04, 0);
  brassParts.push(preparePart(anvilPlate, 0xe8d9c6, 0.05));

  const crownFinial = createChamferedCollarGeometry(0.0, 0.115, 0.065, 6);
  crownFinial.translate(0, 1.85, 0);
  brassParts.push(preparePart(crownFinial, 0xf6ead8, 0.04));

  const staticBrassMesh = new THREE.Mesh(mergePreparedParts(brassParts), ochreBrassMat);
  staticBrassMesh.castShadow = true;
  staticBrassMesh.receiveShadow = true;
  thumperTilted.add(staticBrassMesh);

  const pulseRingMesh = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.026, 8, 16), pulseCoreMat);
  pulseRingMesh.rotation.x = Math.PI * 0.5;
  pulseRingMesh.position.set(0, 1.11, 0);
  thumperTilted.add(pulseRingMesh);

  // 4. Sliding Weathered Dark Bronze Hammer Collar with Subtle Brushed Lip
  const hammerParts = [];
  const hammerBody = createChamferedCollarGeometry(0.10, 0.315, 0.165, 12);
  hammerParts.push(preparePart(hammerBody, 0xd8c8b6, 0.05));
  const hammerLip = createChamferedCollarGeometry(0.18, 0.345, 0.062, 12);
  hammerLip.translate(0, -0.068, 0);
  hammerParts.push(preparePart(hammerLip, 0xf4e8d8, 0.05));
  const hammerTop = createChamferedCollarGeometry(0.12, 0.255, 0.068, 12);
  hammerTop.translate(0, 0.105, 0);
  hammerParts.push(preparePart(hammerTop, 0xd8c8b6, 0.04));

  const hammerGroup = new THREE.Mesh(mergePreparedParts(hammerParts), ochreBrassMat);
  hammerGroup.castShadow = true;
  hammerGroup.receiveShadow = true;
  const hammerRestY = 1.23;
  const hammerStroke = 0.26;
  hammerGroup.position.set(0, hammerRestY, 0);
  thumperTilted.add(hammerGroup);

  // 5. Dynamic Helical Tension Spring
  const crownAnchorY = 1.62;
  const restSpringLen = 0.30;
  const springGeom = createHelicalSpringGeometry(7, 0.155, 0.024, restSpringLen);
  springGeom.translate(0, -restSpringLen, 0);
  const springMesh = new THREE.Mesh(springGeom, ochreBrassMat);
  springMesh.castShadow = true;
  springMesh.position.set(0, crownAnchorY, 0);
  thumperTilted.add(springMesh);

  // 6. Pooled Expanding Dust / Shockwave Glow Rings (ONLY visible when thumper active!)
  const ringSlots = [];
  const ringPlaneGeom = new THREE.PlaneGeometry(1.0, 1.0);
  ringPlaneGeom.rotateX(-Math.PI * 0.5);

  for (let i = 0; i < 3; i++) {
    const mat = createShockwaveRingMaterial();
    const mesh = new THREE.Mesh(ringPlaneGeom, mat);
    mesh.visible = false;
    mesh.renderOrder = 6;
    parentGroup.add(mesh);
    ringSlots.push({ mesh, mat, age: 99, maxAge: 1.05, active: false });
  }

  parentGroup.add(thumperRoot);

  const _up = new THREE.Vector3(0, 1, 0);
  const _groundNormal = new THREE.Vector3();
  const _ringQuat = new THREE.Quaternion();
  let lastRingCycle = -1;
  let nextSlot = 0;
  let impactRecoil = 0;

  return function updateThumper(dt, worldState) {
    if (!worldState || !worldState.thumper) return;
    const tState = worldState.thumper;
    const px = tState.position.x;
    const pz = tState.position.z;
    const groundY = getGroundHeight(px, pz);
    thumperRoot.position.set(px, groundY, pz);

    let lift = 0;
    if (tState.active) {
      const phase = tState.pulsePhase;
      const shifted = phase - 0.25;
      const cycleIdx = Math.floor(shifted);
      const u = shifted - cycleIdx;

      if (cycleIdx !== lastRingCycle && u < 0.35) {
        lastRingCycle = cycleIdx;
        impactRecoil = 1.0;
        const slot = ringSlots[nextSlot];
        nextSlot = (nextSlot + 1) % ringSlots.length;
        slot.active = true;
        slot.age = 0;
        getGroundNormal(px, pz, _groundNormal);
        _ringQuat.setFromUnitVectors(_up, _groundNormal);
        slot.mesh.position.set(px, groundY + 0.09, pz);
        slot.mesh.quaternion.copy(_ringQuat);
        slot.mesh.visible = true;
      }

      if (u < 0.08) {
        lift = Math.sin((u / 0.08) * Math.PI) * 0.06;
      } else if (u < 0.85) {
        const w = (u - 0.08) / 0.77;
        lift = 0.5 - 0.5 * Math.cos(w * Math.PI);
      } else {
        const s = (u - 0.85) / 0.15;
        lift = Math.max(0, 1.0 - Math.pow(s, 2.35));
      }
    } else {
      lastRingCycle = -1;
      lift = 0;
      if (tState.pulseStrength <= 0.001) {
        for (let i = 0; i < ringSlots.length; i++) {
          ringSlots[i].active = false;
          ringSlots[i].mesh.visible = false;
        }
      }
    }

    impactRecoil *= Math.pow(0.002, dt);
    const vibY = tState.active ? impactRecoil * Math.sin(worldState.elapsed * 95.0) * 0.012 : 0;
    thumperTilted.position.y = (tState.active ? -impactRecoil * 0.02 : 0) + vibY;

    const hammerY = hammerRestY + lift * hammerStroke;
    hammerGroup.position.y = hammerY;

    const hammerTopY = hammerY + 0.11;
    const currentSpringLen = Math.max(0.08, crownAnchorY - hammerTopY);
    springMesh.scale.y = currentSpringLen / restSpringLen;

    pulseCoreMat.emissiveIntensity = tState.active ? 0.35 + tState.pulseStrength * 2.5 : 0.0;

    for (let i = 0; i < ringSlots.length; i++) {
      const slot = ringSlots[i];
      if (!slot.active) continue;
      slot.age += dt;
      const p = slot.age / slot.maxAge;
      if (p >= 1.0) {
        slot.active = false;
        slot.mesh.visible = false;
        continue;
      }
      const easeOut = 1.0 - Math.pow(1.0 - p, 2.2);
      const scale = mix(1.2, 13.5, easeOut);
      slot.mesh.scale.set(scale, 1.0, scale);
      slot.mat.uniforms.uProgress.value = p;
      slot.mat.uniforms.uOpacity.value =
        Math.sin(clamp(p * 3.5, 0, 1) * Math.PI * 0.5) * Math.pow(1.0 - p, 1.35) * 0.82;
      slot.mat.uniforms.uTime.value = worldState.elapsed;
    }
  };
}

// ---------------------------------------------------------------------------
// Public Entry Point
// ---------------------------------------------------------------------------

export function createGeologyAndProps(scene, worldState) {
  const group = new THREE.Group();
  group.name = 'ArrakisGeologyAndProps';

  const atmoUniforms = createAtmoUniforms(worldState);
  syncAtmoUniforms(atmoUniforms, worldState);

  const rockAnchors = buildRockOutcrops(group, atmoUniforms);
  buildCurbingPathAndPebbles(group, rockAnchors, atmoUniforms);
  const updateWindtrap = buildWindtrapSpire(group, atmoUniforms);
  const updateThumper = buildFremenThumper(group, worldState, atmoUniforms);

  if (scene) {
    scene.add(group);
  }

  return {
    group,
    update(dt) {
      const safeDt = Math.min(Math.max(dt || 0, 0), 0.1);
      syncAtmoUniforms(atmoUniforms, worldState);
      updateWindtrap(safeDt, worldState);
      updateThumper(safeDt, worldState);
    }
  };
}
