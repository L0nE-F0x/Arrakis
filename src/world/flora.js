import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { NOISE_GLSL } from '../shaders/noise.glsl.js';
import {
  CISTERN_CENTER,
  WATER_LEVEL,
  getEntryWalkDistance,
  getGroundHeight,
  getPathDistance,
  getTerrainInfo,
  smoothstep
} from './terrainMath.js';

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

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function tintGeometry(geom, hex, shadeBottom = 1.0, shadeTop = 1.0, uvTagX = 0.0) {
  const nonIndexed = geom.index ? geom.toNonIndexed() : geom.clone();
  if (!nonIndexed.attributes.normal) nonIndexed.computeVertexNormals();
  const pos = nonIndexed.attributes.position;
  nonIndexed.computeBoundingBox();
  const minY = nonIndexed.boundingBox.min.y;
  const maxY = Math.max(minY + 1e-4, nonIndexed.boundingBox.max.y);
  const base = new THREE.Color(hex);
  const colors = new Float32Array(pos.count * 3);
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const u = clamp((pos.getY(i) - minY) / (maxY - minY), 0, 1);
    const s = mix(shadeBottom, shadeTop, u);
    colors[i * 3] = base.r * s;
    colors[i * 3 + 1] = base.g * s;
    colors[i * 3 + 2] = base.b * s;
    uvs[i * 2] = uvTagX;
    uvs[i * 2 + 1] = u;
  }
  nonIndexed.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  nonIndexed.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return nonIndexed;
}

// Sculpted 3D curved botanical blade (used for reeds, ghost-grass, agave leaves, cupped petals)
function buildCurvedBladeGeometry({
  length = 1.0,
  widthBase = 0.04,
  widthMid = 0.055,
  widthTip = 0.003,
  bend = 0.28,
  cup = 0.012,
  thickness = 0.0,
  segs = 7,
  hexBottom = 0x2c4a2e,
  hexTop = 0x6f9454,
  uvTagX = 0.0
}) {
  const positions = [];
  const colors = [];
  const uvs = [];
  const indices = [];

  const cBot = new THREE.Color(hexBottom);
  const cTop = new THREE.Color(hexTop);
  const cTmp = new THREE.Color();

  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const wProfile =
      u < 0.45
        ? mix(widthBase, widthMid, u / 0.45)
        : mix(widthMid, widthTip, Math.pow((u - 0.45) / 0.55, 0.85));
    const y = length * (u - 0.16 * bend * u * u * u);
    const z = length * bend * u * u;
    const cupDepth = cup * Math.sin(u * Math.PI);

    cTmp.copy(cBot).lerp(cTop, Math.pow(u, 0.82));

    positions.push(-wProfile, y, z + cupDepth);
    positions.push(0, y + thickness * (1.0 - u * 0.7), z - cupDepth * 0.5);
    positions.push(wProfile, y, z + cupDepth);

    for (const vx of [0, 0.5, 1]) {
      const edgeLift = vx === 0.5 ? 0.92 : 1.05;
      colors.push(cTmp.r * edgeLift, cTmp.g * edgeLift, cTmp.b * edgeLift);
      uvs.push(uvTagX > 0.0 ? uvTagX : vx, u);
    }
  }

  for (let i = 0; i < segs; i++) {
    const r0 = i * 3;
    const r1 = (i + 1) * 3;
    indices.push(r0, r1, r0 + 1, r0 + 1, r1, r1 + 1);
    indices.push(r0 + 1, r1 + 1, r0 + 2, r0 + 2, r1 + 1, r1 + 2);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  const out = geom.toNonIndexed();
  out.computeVertexNormals();
  return out;
}

// 1. Weeping Desert Tamarisk compound feathery pinnate frond spray
function createTamariskSprayGeometry() {
  const parts = [];
  const rand = mulberry32(4101);

  const spinePts = [];
  for (let i = 0; i <= 6; i++) {
    const u = i / 6;
    spinePts.push(new THREE.Vector3(Math.sin(u * 2.2) * 0.035, -u * 1.28, u * u * 0.24));
  }
  const spineGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(spinePts), 8, 0.0065, 4, false);
  parts.push(tintGeometry(spineGeo, 0x5c4632, 1.0, 0.85));

  // 30 delicate narrow feathery desert-tamarisk lancelets cascading down the drooping rachis
  const leafletCount = 30;
  for (let i = 0; i < leafletCount; i++) {
    const u = (i + 0.3) / leafletCount;
    const anchorY = -u * 1.22;
    const anchorZ = u * u * 0.22;
    const side = i % 2 === 0 ? 1 : -1;
    const blade = buildCurvedBladeGeometry({
      length: 0.22 + rand() * 0.14,
      widthBase: 0.006,
      widthMid: 0.015,
      widthTip: 0.0018,
      bend: 0.22 + rand() * 0.18,
      cup: 0.004,
      segs: 4,
      hexBottom: 0x3f5438,
      hexTop: 0x7d965c
    });
    blade.rotateX(Math.PI * 0.82 + (rand() - 0.5) * 0.26);
    blade.rotateZ(side * (0.26 + rand() * 0.34));
    blade.rotateY(i * 1.9 + (rand() - 0.5) * 0.45);
    blade.translate(Math.sin(u * 2.2) * 0.035, anchorY, anchorZ);
    parts.push(blade);
  }

  return mergeGeometries(parts, false);
}

// Gnarled desert Tamarisk skeleton with flared branch collars, closed tapered tips & clear celestial crown aperture
function buildTamariskTreeSkeleton(treeSpec, seed) {
  const rand = mulberry32(seed);
  const barkParts = [];
  const sprayAnchors = [];

  const { x, z, height = 6.8, leanX = 0.0, leanZ = 0.0, crownGapDir = null } = treeSpec;
  const groundY = getGroundHeight(x, z);

  const trunkSteps = 14;
  const trunkPts = [];
  for (let i = 0; i <= trunkSteps; i++) {
    const u = i / trunkSteps;
    const twistX = Math.sin(u * 3.4 + seed) * 0.20 * u + leanX * u * 1.25;
    const twistZ = Math.cos(u * 2.9 + seed * 0.7) * 0.18 * u + leanZ * u * 1.25;
    trunkPts.push(new THREE.Vector3(twistX, -0.45 + u * height * 0.62, twistZ));
  }
  const trunkCurve = new THREE.CatmullRomCurve3(trunkPts);

  // Tapered fissured bark tube with flared base junction collar & sealed tip (zero floating/uncapped grey pipes!)
  const buildTaperedBranch = (curve, rBot, rTop, tubularSegs, radialSegs, twistSeed, collarFlare = 1.0) => {
    const frames = curve.computeFrenetFrames(tubularSegs, false);
    const positions = [];
    const indices = [];
    for (let i = 0; i <= tubularSegs; i++) {
      const u = i / tubularSegs;
      const pt = curve.getPoint(u);
      const N = frames.normals[i];
      const B = frames.binormals[i];
      const collar = 1.0 + (collarFlare - 1.0) * Math.exp(-u * 9.0);
      const tipPinch = u > 0.92 ? 1.0 - Math.pow((u - 0.92) / 0.08, 2.0) * 0.85 : 1.0;
      const rBase = mix(rBot, rTop, Math.pow(u, 0.76)) * collar * tipPinch;
      for (let j = 0; j <= radialSegs; j++) {
        const ang = (j / radialSegs) * Math.PI * 2;
        const barkFlute = 1.0 + 0.15 * Math.sin(ang * 5.0 + u * 8.5 + twistSeed);
        const r = rBase * barkFlute;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        positions.push(
          pt.x + (N.x * ca + B.x * sa) * r,
          pt.y + (N.y * ca + B.y * sa) * r,
          pt.z + (N.z * ca + B.z * sa) * r
        );
      }
    }
    const stride = radialSegs + 1;
    for (let i = 0; i < tubularSegs; i++) {
      for (let j = 0; j < radialSegs; j++) {
        const a = i * stride + j;
        const b = (i + 1) * stride + j;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    return tintGeometry(g, 0x6e523b, 0.82, 1.08);
  };

  barkParts.push(buildTaperedBranch(trunkCurve, 0.36 * (height / 6.8), 0.11 * (height / 6.8), 16, 10, seed, 1.38));

  // Organic root buttress flares sinking smoothly into desert sand
  for (let r = 0; r < 5; r++) {
    const ra = (r / 5) * Math.PI * 2 + rand() * 0.45;
    const rootOrigin = trunkCurve.getPoint(0.16);
    const rootCurve = new THREE.CatmullRomCurve3([
      rootOrigin.clone(),
      new THREE.Vector3(rootOrigin.x + Math.cos(ra) * 0.36, 0.14, rootOrigin.z + Math.sin(ra) * 0.36),
      new THREE.Vector3(rootOrigin.x + Math.cos(ra) * 0.78, -0.36, rootOrigin.z + Math.sin(ra) * 0.78)
    ]);
    barkParts.push(buildTaperedBranch(rootCurve, 0.15, 0.04, 7, 6, seed + r, 1.25));
  }

  const boughCount = crownGapDir !== null ? 7 : 6;
  for (let b = 0; b < boughCount; b++) {
    let azim = (b / boughCount) * Math.PI * 2 + (rand() - 0.5) * 0.35;
    if (crownGapDir !== null) {
      const delta = Math.atan2(Math.sin(azim - crownGapDir), Math.cos(azim - crownGapDir));
      if (Math.abs(delta) < 0.62) {
        azim = crownGapDir + (delta >= 0 ? 0.68 : -0.68);
      }
    }

    const startU = 0.52 + (b / boughCount) * 0.44;
    const origin = trunkCurve.getPoint(Math.min(0.96, startU));
    const trunkTangent = trunkCurve.getTangent(Math.min(0.96, startU));
    const reach = (2.15 + rand() * 1.40) * (height / 6.8);
    const rise = (1.45 + rand() * 1.15) * (height / 6.8);

    // Embed start inside trunk core & curve smoothly upward before arching out (zero detached cylinder sticks!)
    const bPts = [
      origin.clone().addScaledVector(trunkTangent, -0.12),
      new THREE.Vector3(
        origin.x + Math.cos(azim) * reach * 0.24,
        origin.y + rise * 0.46,
        origin.z + Math.sin(azim) * reach * 0.24
      ),
      new THREE.Vector3(
        origin.x + Math.cos(azim + 0.10) * reach * 0.68,
        origin.y + rise * 0.94,
        origin.z + Math.sin(azim + 0.10) * reach * 0.68
      ),
      new THREE.Vector3(
        origin.x + Math.cos(azim + 0.20) * reach * 1.08,
        origin.y + rise * 0.62,
        origin.z + Math.sin(azim + 0.20) * reach * 1.08
      )
    ];
    const bCurve = new THREE.CatmullRomCurve3(bPts);
    barkParts.push(buildTaperedBranch(bCurve, 0.12 * (height / 6.8), 0.018, 12, 7, seed + b * 7, 1.42));

    const subCount = 4;
    for (let s = 0; s < subCount; s++) {
      const su = 0.36 + (s / (subCount - 1)) * 0.60;
      const sOrigin = bCurve.getPoint(su);
      const bTang = bCurve.getTangent(su);
      const sAzim = azim + (s % 2 === 0 ? 0.44 : -0.44) + (rand() - 0.5) * 0.22;
      const sReach = 0.72 + rand() * 0.58;
      const sEnd = new THREE.Vector3(
        sOrigin.x + Math.cos(sAzim) * sReach,
        sOrigin.y + 0.20 - rand() * 0.42,
        sOrigin.z + Math.sin(sAzim) * sReach
      );
      const sCurve = new THREE.CatmullRomCurve3([
        sOrigin.clone().addScaledVector(bTang, -0.06),
        new THREE.Vector3(
          mix(sOrigin.x, sEnd.x, 0.45),
          mix(sOrigin.y, sEnd.y, 0.45) + 0.22,
          mix(sOrigin.z, sEnd.z, 0.45)
        ),
        sEnd
      ]);
      barkParts.push(buildTaperedBranch(sCurve, 0.044, 0.006, 8, 5, seed + b * 19 + s, 1.35));

      for (let k = 0; k < 7; k++) {
        const ku = 0.25 + (k / 6) * 0.75;
        const spPt = sCurve.getPoint(ku);
        const wx = x + spPt.x + (rand() - 0.5) * 0.22;
        const wy = groundY + spPt.y + (rand() - 0.5) * 0.14;
        const wz = z + spPt.z + (rand() - 0.5) * 0.22;

        // Keep central celestial sky aperture unobstructed for 03_canopy_upward / 03_canopy_sky!
        if (crownGapDir !== null) {
          // Ray from canopy camera (5.15, ~2.3, -9.8) toward celestial triad (2.4, 15.8, -28.0)
          const camX = 5.15, camY = 2.35, camZ = -9.8;
          const rayX = -0.13, rayY = 0.60, rayZ = -0.79;
          const dx = wx - camX, dy = (wy - 0.65) - camY, dz = wz - camZ;
          const proj = dx * rayX + dy * rayY + dz * rayZ;
          if (proj > 0.8 && proj < 14.0) {
            const perpSq = (dx * dx + dy * dy + dz * dz) - proj * proj;
            if (perpSq < 4.6) continue;
          }
        }

        sprayAnchors.push({
          x: wx,
          y: wy,
          z: wz,
          yaw: rand() * Math.PI * 2,
          tiltX: (rand() - 0.5) * 0.28,
          tiltZ: (rand() - 0.5) * 0.28,
          scale: (0.78 + rand() * 0.44) * (height / 6.8),
          hueShift: (rand() - 0.5) * 0.04
        });
      }
    }
  }

  const mergedBark = mergeGeometries(barkParts, false);
  mergedBark.translate(x, groundY, z);
  return { barkGeom: mergedBark, sprayAnchors };
}

// 2. Riparian Plume Reed & Sedge Clump
function createPlumeReedClumpGeometry(seed) {
  const rand = mulberry32(seed);
  const parts = [];

  for (let i = 0; i < 14; i++) {
    const ang = (i / 14) * Math.PI * 2 + (rand() - 0.5) * 0.3;
    const len = 0.62 + rand() * 0.50;
    const blade = buildCurvedBladeGeometry({
      length: len,
      widthBase: 0.014,
      widthMid: 0.021,
      widthTip: 0.002,
      bend: 0.34 + rand() * 0.26,
      cup: 0.006,
      segs: 6,
      hexBottom: 0x384d2e,
      hexTop: 0x7f8e50
    });
    blade.rotateY(ang);
    blade.translate(Math.cos(ang) * 0.05, -0.06, Math.sin(ang) * 0.05);
    parts.push(blade);
  }

  for (let c = 0; c < 3; c++) {
    const ca = (c / 3) * Math.PI * 2 + rand() * 0.8;
    const h = 1.15 + rand() * 0.44;
    const lean = 0.14 + rand() * 0.14;
    const culmPts = [
      new THREE.Vector3(Math.cos(ca) * 0.04, -0.08, Math.sin(ca) * 0.04),
      new THREE.Vector3(Math.cos(ca) * (0.04 + lean * 0.35), h * 0.52, Math.sin(ca) * (0.04 + lean * 0.35)),
      new THREE.Vector3(Math.cos(ca) * (0.04 + lean), h, Math.sin(ca) * (0.04 + lean))
    ];
    const culmCurve = new THREE.CatmullRomCurve3(culmPts);
    const stem = new THREE.TubeGeometry(culmCurve, 8, 0.0085, 5, false);
    parts.push(tintGeometry(stem, 0x7c804a, 0.75, 1.1));

    const tip = culmPts[2];
    for (let p = 0; p < 12; p++) {
      const pu = p / 11;
      const pa = p * 2.39996;
      const plumeBlade = buildCurvedBladeGeometry({
        length: 0.16 * (1.0 - pu * 0.45),
        widthBase: 0.010,
        widthMid: 0.022,
        widthTip: 0.003,
        bend: 0.35,
        cup: 0.004,
        segs: 4,
        hexBottom: 0xc5ae78,
        hexTop: 0xf4e2b8
      });
      plumeBlade.rotateX(0.32 * (1.0 - pu * 0.5));
      plumeBlade.rotateY(pa);
      plumeBlade.translate(
        tip.x + Math.cos(ca) * pu * 0.05,
        tip.y - 0.06 + pu * 0.28,
        tip.z + Math.sin(ca) * pu * 0.05
      );
      parts.push(plumeBlade);
    }
  }

  return mergeGeometries(parts, false);
}

// 3. Macro Inkvine / Saffron Mullein / Twilight Lupine Flower Spike (echoing reference/frame_08.jpg!)
function createInkvineSpikeGeometry(seed, isBiolumViolet = false) {
  const rand = mulberry32(seed);
  const parts = [];
  const stalkH = 1.38 + rand() * 0.24;
  const curveX = (rand() - 0.5) * 0.10;
  const curveZ = (rand() - 0.5) * 0.10;

  const stalkCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.06, 0),
    new THREE.Vector3(curveX * 0.4, stalkH * 0.45, curveZ * 0.4),
    new THREE.Vector3(curveX, stalkH, curveZ)
  ]);
  const stalkGeo = new THREE.TubeGeometry(stalkCurve, 12, 0.014, 6, false);
  parts.push(tintGeometry(stalkGeo, 0x3f5a35, 0.78, 1.08));

  for (let l = 0; l < 9; l++) {
    const la = (l / 9) * Math.PI * 2 + (rand() - 0.5) * 0.25;
    const leaf = buildCurvedBladeGeometry({
      length: 0.34 + rand() * 0.14,
      widthBase: 0.022,
      widthMid: 0.065,
      widthTip: 0.008,
      bend: 0.45,
      cup: 0.014,
      segs: 5,
      hexBottom: 0x2e4829,
      hexTop: 0x557642
    });
    leaf.rotateX(0.55 + rand() * 0.25);
    leaf.rotateY(la);
    leaf.translate(0, 0.02 + (l % 3) * 0.03, 0);
    parts.push(leaf);
  }

  const floretCount = 26;
  const tagX = isBiolumViolet ? 2.2 : 2.0;
  for (let f = 0; f < floretCount; f++) {
    const u = f / (floretCount - 1);
    const spU = 0.28 + u * 0.70;
    const pt = stalkCurve.getPoint(spU);
    const phi = f * 2.39996 + seed;
    const bellScale = mix(1.08, 0.34, Math.pow(u, 1.12));

    // Closed-base flared 3D bell floret with soft ruffled mouth
    const bellGeo = new THREE.CylinderGeometry(0.038 * bellScale, 0.008 * bellScale, 0.098 * bellScale, 8, 2, false);
    bellGeo.translate(0, -0.046 * bellScale, 0);
    bellGeo.rotateZ(1.10 - u * 0.38);
    bellGeo.rotateY(phi);
    bellGeo.translate(pt.x + Math.cos(phi) * 0.024, pt.y, pt.z + Math.sin(phi) * 0.024);

    const tintedBell = tintGeometry(bellGeo, 0xffffff, 0.76, 1.12, tagX);
    const uvAttr = tintedBell.attributes.uv;
    for (let k = 0; k < uvAttr.count; k++) {
      uvAttr.setXY(k, tagX, u);
    }
    parts.push(tintedBell);
  }

  return mergeGeometries(parts, false);
}

// 4. Arrakis Desert Rose & Night-Blooming Cerulean Spice-Lily Bush (overlapping cupped petals + calyx base, zero gap holes!)
function createDesertRoseBushGeometry(seed, isNightLily = false) {
  const rand = mulberry32(seed);
  const parts = [];

  const leafCount = isNightLily ? 13 : 16;
  for (let i = 0; i < leafCount; i++) {
    const la = (i / leafCount) * Math.PI * 2 + (rand() - 0.5) * 0.3;
    const leaf = buildCurvedBladeGeometry({
      length: (isNightLily ? 0.38 : 0.32) + rand() * 0.16,
      widthBase: 0.018,
      widthMid: isNightLily ? 0.044 : 0.056,
      widthTip: 0.006,
      bend: 0.38 + rand() * 0.22,
      cup: 0.012,
      segs: 5,
      hexBottom: isNightLily ? 0x1f423d : 0x304c2c,
      hexTop: isNightLily ? 0x4b7d70 : 0x5c7f47
    });
    leaf.rotateX(0.35 + rand() * 0.35);
    leaf.rotateY(la);
    leaf.translate(0, 0.02, 0);
    parts.push(leaf);
  }

  const stemCount = isNightLily ? 4 : 5;
  for (let s = 0; s < stemCount; s++) {
    const sa = (s / stemCount) * Math.PI * 2 + rand() * 0.7;
    const rOut = s === 0 ? 0.03 : 0.11 + rand() * 0.12;
    const h = (isNightLily ? 0.50 : 0.60) + rand() * 0.26;
    const tip = new THREE.Vector3(Math.cos(sa) * rOut, h, Math.sin(sa) * rOut);
    const sCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, -0.04, 0),
      new THREE.Vector3(tip.x * 0.45, h * 0.52, tip.z * 0.45),
      tip
    ]);
    const stemGeo = new THREE.TubeGeometry(sCurve, 7, 0.0085, 5, false);
    parts.push(tintGeometry(stemGeo, 0x3e5e36, 0.80, 1.05));

    // Tilt blossom head gracefully outward (25..38 deg) so viewer sees into the rich cupped flower face!
    const headGroupParts = [];

    // Solid green sepal calyx cup sealing the underside completely (zero yellow gap-triangles!)
    const calyx = new THREE.ConeGeometry(0.038, 0.036, 8);
    calyx.rotateX(Math.PI);
    calyx.translate(0, -0.008, 0);
    headGroupParts.push(tintGeometry(calyx, 0x35542f, 0.8, 1.05));

    const petalCount = isNightLily ? 10 : 15;
    const innerCount = isNightLily ? 5 : 7;
    for (let p = 0; p < petalCount; p++) {
      const ring = p < innerCount ? 0 : 1;
      const ringTotal = ring === 0 ? innerCount : petalCount - innerCount;
      const idxInRing = ring === 0 ? p : p - innerCount;
      const pa = (idxInRing / ringTotal) * Math.PI * 2 + ring * 0.42;
      const petal = buildCurvedBladeGeometry({
        length: isNightLily ? (ring === 0 ? 0.13 : 0.16) : (ring === 0 ? 0.095 : 0.122),
        widthBase: isNightLily ? 0.024 : 0.032,
        widthMid: isNightLily ? 0.048 : 0.062,
        widthTip: isNightLily ? 0.010 : 0.044,
        bend: isNightLily ? 0.30 : 0.26,
        cup: 0.018,
        segs: 5,
        hexBottom: 0xc8c8c8,
        hexTop: 0xffffff,
        uvTagX: isNightLily ? 3.0 : 2.0
      });
      petal.rotateX((isNightLily ? 0.58 : 0.46) + ring * 0.30);
      petal.rotateY(pa);
      petal.translate(0, ring === 0 ? 0.006 : 0.0, 0);
      headGroupParts.push(petal);
    }

    // Velvet receptacle + glowing stamen crown
    const core = new THREE.SphereGeometry(isNightLily ? 0.030 : 0.026, 8, 6);
    core.scale(1, 0.62, 1);
    core.translate(0, 0.014, 0);
    headGroupParts.push(
      tintGeometry(core, isNightLily ? 0x9ef4ff : 0xd99226, 0.85, 1.18, isNightLily ? 3.5 : 0.0)
    );

    const headMerged = mergeGeometries(headGroupParts, false);
    const tiltAmt = s === 0 ? 0.32 : 0.48;
    headMerged.rotateZ(-Math.cos(sa) * tiltAmt);
    headMerged.rotateX(Math.sin(sa) * tiltAmt);
    headMerged.translate(tip.x, tip.y, tip.z);
    parts.push(headMerged);
  }

  return mergeGeometries(parts, false);
}

// 5. Sculpted Glaucous Blue-Agave Succulent Rosette with marginal dew-channels
function createAgaveRosetteGeometry(seed, withStalk = false) {
  const rand = mulberry32(seed);
  const parts = [];
  const bladeCount = 22;

  for (let i = 0; i < bladeCount; i++) {
    const u = i / (bladeCount - 1);
    const phi = i * 2.39996 + seed;
    const blade = buildCurvedBladeGeometry({
      length: mix(0.74, 0.38, u) * (0.92 + rand() * 0.16),
      widthBase: 0.062,
      widthMid: 0.098,
      widthTip: 0.004,
      bend: mix(0.38, 0.12, u),
      cup: 0.028,
      thickness: 0.022,
      segs: 6,
      hexBottom: 0x2b4b46,
      hexTop: 0x6c9c90,
      uvTagX: 2.65 // Subtle nocturnal dew-channel luminescence
    });
    blade.rotateX(mix(1.12, 0.18, u));
    blade.rotateY(phi);
    blade.translate(0, 0.02 + u * 0.06, 0);
    parts.push(blade);
  }

  if (withStalk) {
    const stalkH = 2.45;
    const stalk = new THREE.CylinderGeometry(0.018, 0.042, stalkH, 7);
    stalk.translate(0, stalkH * 0.5, 0);
    parts.push(tintGeometry(stalk, 0x626b48, 0.78, 1.05));

    for (let p = 0; p < 7; p++) {
      const pu = p / 6;
      const py = 1.45 + pu * 0.95;
      const pa = p * 2.2;
      const armLen = 0.26 * (1.0 - pu * 0.46);
      const arm = new THREE.CylinderGeometry(0.008, 0.014, armLen, 5);
      arm.rotateZ(1.15);
      arm.rotateY(pa);
      arm.translate(Math.cos(pa) * armLen * 0.45, py, Math.sin(pa) * armLen * 0.45);
      parts.push(tintGeometry(arm, 0x707850, 0.85, 1.05));

      for (let b = 0; b < 5; b++) {
        const ba = (b / 5) * Math.PI * 2 + pu;
        const bell = new THREE.CylinderGeometry(0.024, 0.006, 0.058, 6, 1, false);
        bell.rotateZ(2.65);
        bell.rotateY(ba);
        bell.translate(
          Math.cos(pa) * armLen * 0.92 + Math.cos(ba) * 0.035,
          py + 0.015 + (b % 2) * 0.018,
          Math.sin(pa) * armLen * 0.92 + Math.sin(ba) * 0.035
        );
        parts.push(tintGeometry(bell, 0xead28e, 0.78, 1.12));
      }
    }
  }

  return mergeGeometries(parts, false);
}

// 6A. Clustered Ribbed Golden-Spined Desert Barrel Cactus (Echinocactus) — replaces cartoon 2-arm Saguaro!
function createBarrelCactusClusterGeometry(seed) {
  const rand = mulberry32(seed);
  const parts = [];

  const heads = [
    { x: 0.0, z: 0.0, r: 0.28, h: 0.58, tiltX: 0.06, tiltZ: -0.04 },
    { x: 0.28, z: 0.16, r: 0.19, h: 0.38, tiltX: -0.14, tiltZ: 0.18 },
    { x: -0.22, z: 0.20, r: 0.16, h: 0.31, tiltX: 0.16, tiltZ: 0.15 }
  ];

  const cBase = new THREE.Color(0x6c6244); // Dusty sand-encrusted root collar
  const cMid = new THREE.Color(0x52643e);  // Weathered desert sage-olive body
  const cSpine = new THREE.Color(0xc8ad6c); // Sun-bleached golden areole spine crest
  const cTmp = new THREE.Color();

  for (let hi = 0; hi < heads.length; hi++) {
    const hd = heads[hi];
    const uSegs = 28;
    const vSegs = 14;
    const positions = [];
    const colors = [];
    const uvs = [];
    const indices = [];

    for (let iv = 0; iv <= vSegs; iv++) {
      const v = iv / vSegs;
      const prof = Math.sin(Math.pow(v, 0.68) * Math.PI * 0.96);
      const y = -0.05 + v * hd.h;
      for (let iu = 0; iu <= uSegs; iu++) {
        const ang = (iu / uSegs) * Math.PI * 2;
        const ribWave = Math.cos(ang * 13.0);
        const ribSharp = Math.pow(0.5 + 0.5 * ribWave, 1.8);
        const r = hd.r * prof * (0.86 + 0.18 * ribSharp);
        positions.push(Math.cos(ang) * r, y, Math.sin(ang) * r);

        cTmp.copy(cBase).lerp(cMid, smoothstep(0.05, 0.38, v)).lerp(cSpine, ribSharp * 0.52 * smoothstep(0.12, 0.85, v));
        colors.push(cTmp.r, cTmp.g, cTmp.b);
        uvs.push(0.0, v);
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
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    const out = g.toNonIndexed();
    out.rotateX(hd.tiltX + (rand() - 0.5) * 0.06);
    out.rotateZ(hd.tiltZ + (rand() - 0.5) * 0.06);
    out.translate(hd.x, 0, hd.z);
    out.computeVertexNormals();
    parts.push(out);

    // Woolly saffron-cream crown ring on primary barrel
    if (hi === 0) {
      for (let p = 0; p < 9; p++) {
        const pa = (p / 9) * Math.PI * 2;
        const petal = buildCurvedBladeGeometry({
          length: 0.085,
          widthBase: 0.016,
          widthMid: 0.028,
          widthTip: 0.008,
          bend: 0.24,
          cup: 0.008,
          segs: 3,
          hexBottom: 0xc89238,
          hexTop: 0xf6e6b8
        });
        petal.rotateX(0.52);
        petal.rotateY(pa);
        petal.translate(hd.x, hd.h - 0.06, hd.z);
        parts.push(petal);
      }
    }
  }

  return mergeGeometries(parts, false);
}

// 6B. Asymmetrical Weathered Organ-Pipe / Desert Spear Cactus Clump (zero cartoon 2-arm goalposts!)
function createOrganPipeCactusGeometry(seed) {
  const rand = mulberry32(seed);
  const parts = [];
  const spears = [
    { h: 1.48 + rand() * 0.28, rB: 0.115, rT: 0.095, dx: 0.0, dz: 0.0, leanX: 0.06, leanZ: -0.05 },
    { h: 1.05 + rand() * 0.22, rB: 0.098, rT: 0.082, dx: 0.14, dz: 0.08, leanX: 0.24, leanZ: 0.14 },
    { h: 0.74 + rand() * 0.18, rB: 0.086, rT: 0.072, dx: -0.13, dz: 0.09, leanX: -0.22, leanZ: 0.18 }
  ];

  const cDust = new THREE.Color(0x706246);
  const cOlive = new THREE.Color(0x50623f);
  const cRidge = new THREE.Color(0xa69666);
  const cTmp = new THREE.Color();

  for (const sp of spears) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(sp.dx * 0.4, -0.08, sp.dz * 0.4),
      new THREE.Vector3(sp.dx + sp.leanX * 0.35, sp.h * 0.48, sp.dz + sp.leanZ * 0.35),
      new THREE.Vector3(sp.dx + sp.leanX * 0.72, sp.h, sp.dz + sp.leanZ * 0.72)
    ]);
    const segs = 14;
    const radial = 22;
    const frames = curve.computeFrenetFrames(segs, false);
    const positions = [];
    const colors = [];
    const uvs = [];
    const indices = [];

    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const pt = curve.getPoint(u);
      const N = frames.normals[i];
      const B = frames.binormals[i];
      const dome = u > 0.86 ? Math.sqrt(Math.max(0.01, 1.0 - Math.pow((u - 0.86) / 0.14, 2.0))) : 1.0;
      const rEnv = mix(sp.rB, sp.rT, u) * dome;
      for (let j = 0; j <= radial; j++) {
        const ang = (j / radial) * Math.PI * 2;
        const rib = Math.pow(0.5 + 0.5 * Math.cos(ang * 11.0), 1.6);
        const r = rEnv * (0.86 + 0.18 * rib);
        positions.push(
          pt.x + (N.x * Math.cos(ang) + B.x * Math.sin(ang)) * r,
          pt.y + (N.y * Math.cos(ang) + B.y * Math.sin(ang)) * r,
          pt.z + (N.z * Math.cos(ang) + B.z * Math.sin(ang)) * r
        );
        cTmp.copy(cDust).lerp(cOlive, smoothstep(0.06, 0.36, u)).lerp(cRidge, rib * 0.42);
        colors.push(cTmp.r, cTmp.g, cTmp.b);
        uvs.push(0.0, u);
      }
    }
    const stride = radial + 1;
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < radial; j++) {
        const a = i * stride + j;
        const b = (i + 1) * stride + j;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    const out = g.toNonIndexed();
    out.computeVertexNormals();
    parts.push(out);
  }

  return mergeGeometries(parts, false);
}

// 7. Silvery Ghost-Grass / Frosted Desert Sage Tussock
function createGhostGrassTussockGeometry(seed) {
  const rand = mulberry32(seed);
  const parts = [];
  const count = 28;
  for (let i = 0; i < count; i++) {
    const u = i / count;
    const phi = i * 2.39996 + (rand() - 0.5) * 0.25;
    const blade = buildCurvedBladeGeometry({
      length: 0.34 + rand() * 0.26,
      widthBase: 0.010,
      widthMid: 0.015,
      widthTip: 0.0015,
      bend: 0.36 + rand() * 0.30,
      cup: 0.004,
      segs: 5,
      hexBottom: 0x4b5c54,
      hexTop: 0xb2c4bc
    });
    blade.rotateX(mix(0.22, 0.92, u));
    blade.rotateY(phi);
    blade.translate(Math.cos(phi) * 0.03, -0.03, Math.sin(phi) * 0.03);
    parts.push(blade);
  }
  return mergeGeometries(parts, false);
}

// Custom fissured desert bark shader with warm sand-collar root blend & sky/ground bounce (never crushes to #0a0605 black!)
function createDesertBarkMaterial(sharedUniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.0
  });
  mat.customProgramCacheKey = () => 'arrakis-desert-bark-v3';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = sharedUniforms.uSunDir;
    shader.uniforms.uSunColor = sharedUniforms.uSunColor;
    shader.uniforms.uNight = sharedUniforms.uNight;
    shader.uniforms.uEclipse = sharedUniforms.uEclipse;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBarkWorldPos;\nvarying vec3 vBarkWorldNormal;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vBarkWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vBarkWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        ${NOISE_GLSL}
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uNight;
        uniform float uEclipse;
        varying vec3 vBarkWorldPos;
        varying vec3 vBarkWorldNormal;`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Fibrous vertical desert-tamarisk bark fissures + windblown sand-dust root collar
        float barkGrain = fbm3(vec3(vBarkWorldPos.x * 9.5, vBarkWorldPos.y * 2.4, vBarkWorldPos.z * 9.5));
        float barkRidge = 0.76 + 0.44 * barkGrain;
        diffuseColor.rgb *= barkRidge;
        float sandBase = 1.0 - smoothstep(0.95, 2.25, vBarkWorldPos.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.58, 0.40, 0.24), sandBase * 0.55 * (1.0 - uNight * 0.7));
        diffuseColor.rgb *= (1.0 - uEclipse * 0.55);`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        // Suppress 1px nocturnal directional specular firefly stipple on sub-pixel curved leaf blades!
        roughnessFactor = mix(roughnessFactor, 0.99, uNight);`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // Warm desert sand bounce & dawn rim fill so trunks never crush to flat black silhouettes
        float sunUpB = smoothstep(-0.06, 0.20, uSunDir.y) * (1.0 - uEclipse * 0.85);
        float rimB = pow(1.0 - clamp(abs(dot(normalize(vBarkWorldNormal), normalize(cameraPosition - vBarkWorldPos))), 0.0, 1.0), 2.2);
        vec3 warmSandBounce = mix(vec3(0.018, 0.024, 0.045), vec3(0.11, 0.068, 0.038) + uSunColor * 0.06 * rimB, sunUpB);
        totalEmissiveRadiance += diffuseColor.rgb * warmSandBounce;`
      );
  };
  return mat;
}

// Shared botanical shader: wind sway + subsurface translucency + eclipse/twilight dimming + multi-species nocturnal bioluminescence
function createBotanicalMaterial(sharedUniforms, options = {}) {
  const {
    swayAmp = 0.08,
    swayHeightRef = 1.0,
    isCanopySpray = false,
    roughness = 0.72
  } = options;

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness,
    metalness: 0.0,
    side: THREE.DoubleSide
  });

  mat.customProgramCacheKey = () =>
    `arrakis-botanical-v3-${isCanopySpray ? 'spray' : 'ground'}-${swayAmp.toFixed(3)}`;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uWindDir = sharedUniforms.uWindDir;
    shader.uniforms.uWindSpeed = sharedUniforms.uWindSpeed;
    shader.uniforms.uSunDir = sharedUniforms.uSunDir;
    shader.uniforms.uSunColor = sharedUniforms.uSunColor;
    shader.uniforms.uSunIntensity = sharedUniforms.uSunIntensity;
    shader.uniforms.uNight = sharedUniforms.uNight;
    shader.uniforms.uEclipse = sharedUniforms.uEclipse;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform vec2 uWindDir;
        uniform float uWindSpeed;
        varying vec3 vFloraWorldPos;
        varying vec2 vFloraTagUv;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vFloraTagUv = uv;
        vec4 floraInstOrigin = vec4(0.0, 0.0, 0.0, 1.0);
        #ifdef USE_INSTANCING
          floraInstOrigin = instanceMatrix * floraInstOrigin;
        #endif
        floraInstOrigin = modelMatrix * floraInstOrigin;
        float phaseSeed = floraInstOrigin.x * 0.73 + floraInstOrigin.z * 0.59;
        float flex = ${isCanopySpray
          ? 'clamp(-transformed.y / 1.30, 0.0, 1.25)'
          : `pow(clamp(transformed.y / ${swayHeightRef.toFixed(2)}, 0.0, 1.35), 1.55)`};
        float gust = sin(uTime * (1.85 + uWindSpeed * 1.35) + phaseSeed) * 0.68
                   + cos(uTime * (3.40 + uWindSpeed * 1.90) + phaseSeed * 1.7) * 0.32;
        float swayMag = ${swayAmp.toFixed(4)} * (0.45 + 0.95 * uWindSpeed) * flex * (0.35 + 0.65 * gust);
        transformed.x += uWindDir.x * swayMag;
        transformed.z += uWindDir.y * swayMag;
        vec4 floraWp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          floraWp = instanceMatrix * floraWp;
        #endif
        vFloraWorldPos = (modelMatrix * floraWp).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uSunIntensity;
        uniform float uNight;
        uniform float uEclipse;
        uniform float uTime;
        varying vec3 vFloraWorldPos;
        varying vec2 vFloraTagUv;`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Harmonize non-bioluminescent daytime petals during eclipse totality & deep twilight/night (zero glowing daytime-bright corner sprites!)
        float twilAtten = 1.0 - smoothstep(-0.08, 0.06, uSunDir.y);
        if (vFloraTagUv.x < 2.5) {
          diffuseColor.rgb *= mix(1.0, 0.36, clamp(uEclipse * 0.92 + twilAtten * 0.65, 0.0, 1.0));
        }`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        // Suppress 1px nocturnal directional specular firefly stipple on sub-pixel curved leaf blades!
        roughnessFactor = mix(roughnessFactor, 0.99, uNight);`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec3 viewRayF = normalize(vFloraWorldPos - cameraPosition);
        vec3 sunDirF = normalize(uSunDir);
        float sunUpF = smoothstep(-0.03, 0.16, sunDirF.y) * (1.0 - uEclipse * 0.95);
        float backScatter = pow(max(dot(viewRayF, sunDirF), 0.0), 2.4) * sunUpF * clamp(uSunIntensity / 2.6, 0.0, 1.25);
        // Warm translucent chlorophyll & golden-hour petal rim-backlighting
        totalEmissiveRadiance += diffuseColor.rgb * uSunColor * (backScatter * 0.46);

        // Subtle cool silver-cyan moonlight rim lift at night
        totalEmissiveRadiance += diffuseColor.rgb * vec3(0.035, 0.055, 0.105) * uNight * (1.0 - uEclipse);

        // Multi-Species Nocturnal Bioluminescence (05_night_bloom & 07_night_moons!):
        if (uNight > 0.05) {
          float pulse = 0.86 + 0.14 * sin(uTime * 1.9 + vFloraWorldPos.x * 2.3 + vFloraWorldPos.z * 1.7);
          if (vFloraTagUv.x >= 2.8) {
            // 1) Night-Blooming Cerulean Spice-Lilies: smooth radial nectar-to-tip bioluminescence (zero zebra stripes!)
            float petalGrad = pow(clamp(1.0 - vFloraTagUv.y * 0.72, 0.0, 1.0), 1.6);
            float coreBoost = vFloraTagUv.x > 3.2 ? 2.6 : mix(0.38, 1.35, petalGrad);
            vec3 bioTint = vFloraTagUv.x > 3.2 ? vec3(0.45, 1.15, 1.65) : mix(vec3(0.10, 0.52, 0.96), vec3(0.28, 0.92, 1.42), petalGrad);
            totalEmissiveRadiance += bioTint * uNight * coreBoost * pulse * 0.78;
          } else if (vFloraTagUv.x >= 2.5) {
            // 2) Blue-Agave Condensation Channels: delicate aquamarine dew-tip luminescence!
            float tipGlow = smoothstep(0.52, 0.98, vFloraTagUv.y);
            totalEmissiveRadiance += vec3(0.10, 0.55, 0.78) * uNight * tipGlow * pulse * 0.52;
          } else if (vFloraTagUv.x >= 2.1) {
            // 3) Sietch Twilight Lupine / Inkvine Bell Rims: soft bioluminescent violet-magenta pollen glow!
            float rimGlow = smoothstep(0.35, 0.95, 1.0 - vFloraTagUv.y);
            totalEmissiveRadiance += vec3(0.62, 0.24, 0.98) * uNight * rimGlow * pulse * 0.68;
          }
        }`
      );
  };

  return mat;
}

export function createFloraSystem(scene, worldState) {
  const group = new THREE.Group();
  group.name = 'ArrakisFloraSystem';

  const sharedUniforms = {
    uTime: { value: worldState ? worldState.elapsed : 0 },
    uWindDir: { value: new THREE.Vector2(1, 0).copy(worldState?.windDir ?? { x: 1, y: 0 }) },
    uWindSpeed: { value: worldState ? worldState.windSpeed : 0.45 },
    uSunDir: { value: new THREE.Vector3(0.2, 0.25, -0.94).copy(worldState?.sunDir ?? { x: 0.2, y: 0.25, z: -0.94 }) },
    uSunColor: { value: worldState ? worldState.sunColor.clone() : new THREE.Color(0xffcfa0) },
    uSunIntensity: { value: worldState ? worldState.sunIntensity : 3.0 },
    uNight: { value: 0 },
    uEclipse: { value: worldState ? worldState.eclipseStrength : 0 }
  };

  // -------------------------------------------------------------------------
  // 1. Gnarled Weeping Desert Tamarisk Grove & Hero Canopy Trees
  //    West trees positioned behind yardang cam (1.8, 13.2) so 04_yardang_noon is 100% unobstructed!
  // -------------------------------------------------------------------------
  const tamariskSpecs = [
    { x: -8.8, z: 16.6, height: 6.8, leanX: 0.34, leanZ: -0.20 },
    { x: -12.6, z: 12.8, height: 6.2, leanX: 0.24, leanZ: -0.14 },
    // East Cistern Bank Grove: frames right side of 01_cistern_dawn while keeping north Erg gap open!
    { x: 7.4, z: 7.8, height: 7.1, leanX: -0.34, leanZ: -0.14 },
    { x: 9.0, z: 1.6, height: 6.4, leanX: -0.26, leanZ: 0.14 },
    // Hero Canopy Upward Shot Arching Pair (03_canopy_upward / 03_canopy_sky: cam (5.15, -9.8) -> (2.4, 15.8, -28.0))
    { x: 2.85, z: -12.4, height: 8.8, leanX: -0.22, leanZ: -0.16, crownGapDir: -1.68 },
    { x: 7.45, z: -12.8, height: 8.2, leanX: -0.44, leanZ: -0.18, crownGapDir: -1.96 }
  ];

  const allBarkGeoms = [];
  const allSprays = [];
  for (let i = 0; i < tamariskSpecs.length; i++) {
    const built = buildTamariskTreeSkeleton(tamariskSpecs[i], 5100 + i * 37);
    allBarkGeoms.push(built.barkGeom);
    for (const sp of built.sprayAnchors) allSprays.push(sp);
  }

  const barkMat = createDesertBarkMaterial(sharedUniforms);
  const barkMesh = new THREE.Mesh(mergeGeometries(allBarkGeoms, false), barkMat);
  barkMesh.castShadow = true;
  barkMesh.receiveShadow = true;
  group.add(barkMesh);

  const sprayGeo = createTamariskSprayGeometry();
  const sprayMat = createBotanicalMaterial(sharedUniforms, {
    swayAmp: 0.10,
    isCanopySpray: true,
    roughness: 0.68
  });
  const sprayIM = new THREE.InstancedMesh(sprayGeo, sprayMat, allSprays.length);
  sprayIM.castShadow = true;
  sprayIM.receiveShadow = true;

  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  for (let i = 0; i < allSprays.length; i++) {
    const s = allSprays[i];
    dummy.position.set(s.x, s.y, s.z);
    dummy.rotation.set(s.tiltX, s.yaw, s.tiltZ);
    dummy.scale.setScalar(s.scale);
    dummy.updateMatrix();
    sprayIM.setMatrixAt(i, dummy.matrix);
    tmpColor.setHSL(0.24 + s.hueShift, 0.24, 0.95);
    sprayIM.setColorAt(i, tmpColor);
  }
  sprayIM.instanceMatrix.needsUpdate = true;
  if (sprayIM.instanceColor) sprayIM.instanceColor.needsUpdate = true;
  group.add(sprayIM);

  // Segment-distance helper to keep hero camera sightlines 100% clear of reed/plant obstruction!
  const segDist = (px, pz, ax, az, bx, bz) => {
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    const t = clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1);
    return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
  };

  const isClearForPlant = (px, pz, minWalkClear = 0.95, isReed = false) => {
    if (getPathDistance(px, pz).dist < minWalkClear) return false;
    if (getEntryWalkDistance(px, pz).dist < minWalkClear) return false;
    // 1. Muad'Dib foraging stage (3.16, 8.92) & camera sightline from (3.86, 10.06)
    if (segDist(px, pz, 3.86, 10.06, 3.05, 8.75) < 0.78) return false;
    // 2. Macro Flora camera (6.75, 6.45) -> Hero Trio (4.2, 4.1): keep lens near-field 100% free of reeds!
    if (segDist(px, pz, 6.75, 6.45, 5.25, 5.15) < (isReed ? 2.15 : 1.05)) return false;
    if (isReed && segDist(px, pz, 6.75, 6.45, 3.85, 3.95) < 1.65) return false;
    // 3. Night Bloom camera (3.35, 12.35) -> Cistern reflection corridor
    if (segDist(px, pz, 3.35, 12.35, 1.65, 8.8) < (isReed ? 1.55 : 0.92)) return false;
    // 4. Central south sandy reflection lane & HUD right-border clean zone
    if (Math.abs(px - 0.35) < 1.65 && pz > 5.5 && pz < 16.5) return false;
    if (px > 5.2 && pz > 10.2 && pz < 15.0) return false; // Prevent right-margin petal clip in 08_hud_overview
    if (px > -3.2 && px < 1.8 && pz > 8.8 && pz < 15.0) return false;
    return true;
  };

  // -------------------------------------------------------------------------
  // 2. Riparian Plume Reeds & Blooming Erg Ridge Plumes
  // -------------------------------------------------------------------------
  const reedRand = mulberry32(6201);
  const reedVariants = [createPlumeReedClumpGeometry(601), createPlumeReedClumpGeometry(602)];
  const reedItems = [];

  for (let i = 0; i < 260; i++) {
    const theta = reedRand() * Math.PI * 2;
    const inSouthGap = Math.abs(Math.atan2(Math.sin(theta - 1.58), Math.cos(theta - 1.58))) < 0.58;
    const inNorthGap = Math.abs(Math.atan2(Math.sin(theta + 1.57), Math.cos(theta + 1.57))) < 0.54;
    if (inSouthGap || inNorthGap) continue;

    let shoreR = 5.0;
    for (let r = 2.2; r <= 8.5; r += 0.1) {
      const tx = CISTERN_CENTER.x + Math.cos(theta) * r;
      const tz = CISTERN_CENTER.z + Math.sin(theta) * r;
      if (getGroundHeight(tx, tz) >= WATER_LEVEL) {
        shoreR = r;
        break;
      }
    }
    const rPos = shoreR - 0.38 + Math.pow(reedRand(), 0.85) * 1.75;
    const px = CISTERN_CENTER.x + Math.cos(theta) * rPos;
    const pz = CISTERN_CENTER.z + Math.sin(theta) * rPos;
    if (!isClearForPlant(px, pz, 0.95, true)) continue;
    const info = getTerrainInfo(px, pz);
    if (info.waterDepth > 0.20) continue;

    reedItems.push({
      variant: i % 2,
      x: px,
      y: info.height - 0.04,
      z: pz,
      yaw: reedRand() * Math.PI * 2,
      scale: 0.56 + reedRand() * 0.38,
      lightness: 0.92 + reedRand() * 0.16
    });
  }

  // Sunlit Blooming Erg Ridge golden plume reeds (z = -24.2 .. -27.5, directly framed in 04_erg_golden while 10m behind horizon cam!)
  for (let i = 0; i < 26; i++) {
    const u = i / 25;
    const px = mix(-4.2, 4.8, u) + (reedRand() - 0.5) * 1.4;
    const pz = mix(-26.8, -24.0, u) + (reedRand() - 0.5) * 1.6;
    const info = getTerrainInfo(px, pz);
    reedItems.push({
      variant: i % 2,
      x: px,
      y: info.height - 0.05,
      z: pz,
      yaw: reedRand() * Math.PI * 2,
      scale: 0.68 + reedRand() * 0.36,
      lightness: 0.96 + reedRand() * 0.14
    });
  }

  const reedMat = createBotanicalMaterial(sharedUniforms, {
    swayAmp: 0.095,
    swayHeightRef: 1.25,
    roughness: 0.76
  });
  for (let v = 0; v < reedVariants.length; v++) {
    const subset = reedItems.filter((it) => it.variant === v);
    if (!subset.length) continue;
    const im = new THREE.InstancedMesh(reedVariants[v], reedMat, subset.length);
    im.castShadow = true;
    im.receiveShadow = true;
    for (let j = 0; j < subset.length; j++) {
      const it = subset[j];
      dummy.position.set(it.x, it.y, it.z);
      dummy.rotation.set(0, it.yaw, 0);
      dummy.scale.setScalar(it.scale);
      dummy.updateMatrix();
      im.setMatrixAt(j, dummy.matrix);
      tmpColor.setRGB(it.lightness, it.lightness, it.lightness * 0.96);
      im.setColorAt(j, tmpColor);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    group.add(im);
  }

  // -------------------------------------------------------------------------
  // 3. Towering Macro Inkvine, Saffron Mullein & Sietch Bioluminescent Lupine Spikes
  // -------------------------------------------------------------------------
  const makeColoredSpikeVariant = (seed, bellBottomHex, bellTopHex, isBiolum = false) => {
    const base = createInkvineSpikeGeometry(seed, isBiolum);
    const pos = base.attributes.position;
    const col = base.attributes.color;
    const uv = base.attributes.uv;
    const cBot = new THREE.Color(bellBottomHex);
    const cTop = new THREE.Color(bellTopHex);
    const cMix = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      if (uv.getX(i) > 1.5) {
        cMix.copy(cBot).lerp(cTop, clamp(uv.getY(i), 0, 1));
        col.setXYZ(i, cMix.r, cMix.g, cMix.b);
      }
    }
    return base;
  };

  // Muted, naturalistic desert-adapted floral pigments (rich crimson-rust, warm saffron-ochre, twilight indigo-violet)
  const spikeVariants = [
    makeColoredSpikeVariant(701, 0x6e1834, 0xc44268, false), // Arrakis Inkvine
    makeColoredSpikeVariant(702, 0xa86c16, 0xebb838, false), // Desert Saffron Mullein
    makeColoredSpikeVariant(703, 0x3b2266, 0x8458d4, true)   // Sietch Bioluminescent Lupine
  ];

  const spikeRand = mulberry32(7309);
  const spikeItems = [];
  const addSpikeCluster = (cx, cz, radius, count, minScale = 0.78, maxScale = 1.18, saffronBias = 0.30, skipClear = false) => {
    for (let i = 0; i < count; i++) {
      const a = spikeRand() * Math.PI * 2;
      const r = Math.pow(spikeRand(), 0.7) * radius;
      const px = cx + Math.cos(a) * r;
      const pz = cz + Math.sin(a) * r;
      if (!skipClear && !isClearForPlant(px, pz, 0.72)) continue;
      const info = getTerrainInfo(px, pz);
      if (info.isWater) continue;
      const roll = spikeRand();
      const variant = roll < saffronBias ? 1 : roll < saffronBias + 0.44 * (1 - saffronBias) ? 0 : 2;
      spikeItems.push({
        variant,
        x: px,
        y: info.height - 0.02,
        z: pz,
        yaw: spikeRand() * Math.PI * 2,
        tiltX: (spikeRand() - 0.5) * 0.08,
        tiltZ: (spikeRand() - 0.5) * 0.08,
        scale: minScale + spikeRand() * (maxScale - minScale)
      });
    }
  };

  // Curated Hero Macro Flora Stage (cam (6.75, 6.45) -> (3.85, 3.95)): unobstructed Inkvine & Saffron Mullein spires!
  for (const hs of [
    { v: 0, x: 4.55, z: 4.15, s: 1.18 },
    { v: 1, x: 4.82, z: 3.72, s: 1.14 },
    { v: 0, x: 4.22, z: 3.65, s: 1.08 },
    { v: 2, x: 4.68, z: 4.52, s: 1.04 },
    { v: 1, x: 4.35, z: 4.68, s: 0.98 }
  ]) {
    spikeItems.push({
      variant: hs.v,
      x: hs.x,
      y: getGroundHeight(hs.x, hs.z) - 0.02,
      z: hs.z,
      yaw: spikeRand() * Math.PI * 2,
      tiltX: 0.03,
      tiltZ: -0.02,
      scale: hs.s
    });
  }
  addSpikeCluster(3.85, 2.85, 1.35, 14, 0.82, 1.16, 0.36);

  // Opening Cistern Dawn Foreground Framing (01_cistern_dawn: cam (0.55, 13.6) looking north)
  addSpikeCluster(-2.15, 11.8, 1.35, 14, 0.80, 1.16, 0.32);
  addSpikeCluster(2.65, 11.4, 1.25, 12, 0.78, 1.12, 0.32);
  addSpikeCluster(-3.85, 9.4, 1.65, 12, 0.74, 1.12, 0.28);
  addSpikeCluster(4.15, 9.2, 1.55, 12, 0.74, 1.12, 0.28);

  // Muad'Dib Foraging Clearing backdrop
  addSpikeCluster(2.35, 7.90, 0.95, 9, 0.70, 1.04, 0.35);
  addSpikeCluster(4.35, 8.45, 0.85, 8, 0.68, 1.00, 0.35);

  // North-West & North-East Oasis Pockets (reflected in night cistern!)
  addSpikeCluster(-5.4, 3.2, 2.0, 12, 0.75, 1.12, 0.20);
  addSpikeCluster(5.0, -1.6, 1.9, 12, 0.75, 1.10, 0.20);

  // Sunlit Blooming Erg Ridge Spikes (04_erg_golden foreground ridge at z = -24..-27!)
  addSpikeCluster(-2.2, -25.4, 2.2, 14, 0.74, 1.12, 0.52, true);
  addSpikeCluster(2.4, -24.6, 2.4, 16, 0.76, 1.15, 0.52, true);

  const spikeMat = createBotanicalMaterial(sharedUniforms, {
    swayAmp: 0.075,
    swayHeightRef: 1.45,
    roughness: 0.68
  });
  for (let v = 0; v < spikeVariants.length; v++) {
    const subset = spikeItems.filter((it) => it.variant === v);
    if (!subset.length) continue;
    const im = new THREE.InstancedMesh(spikeVariants[v], spikeMat, subset.length);
    im.castShadow = true;
    im.receiveShadow = true;
    for (let j = 0; j < subset.length; j++) {
      const it = subset[j];
      dummy.position.set(it.x, it.y, it.z);
      dummy.rotation.set(it.tiltX, it.yaw, it.tiltZ);
      dummy.scale.setScalar(it.scale);
      dummy.updateMatrix();
      im.setMatrixAt(j, dummy.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
    group.add(im);
  }

  // -------------------------------------------------------------------------
  // 4. Arrakis Desert Roses & Bioluminescent Night-Blooming Cerulean Spice-Lilies
  // -------------------------------------------------------------------------
  const makeColoredBush = (seed, petalBot, petalTop, isNightLily = false) => {
    const g = createDesertRoseBushGeometry(seed, isNightLily);
    const pos = g.attributes.position;
    const col = g.attributes.color;
    const uv = g.attributes.uv;
    const cB = new THREE.Color(petalBot);
    const cT = new THREE.Color(petalTop);
    const cM = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const tag = uv.getX(i);
      if (tag > 1.5 && tag < 3.2) {
        cM.copy(cB).lerp(cT, clamp(uv.getY(i), 0, 1));
        col.setXYZ(i, cM.r, cM.g, cM.b);
      }
    }
    return g;
  };

  const roseVariants = [
    makeColoredBush(801, 0x8e2438, 0xe2687e, false), // Desert Terracotta-Rose
    makeColoredBush(802, 0xa24222, 0xea905a, false), // Sun-Baked Apricot-Poppy
    makeColoredBush(803, 0x2c7ca8, 0xdcf8ff, true)   // Bioluminescent Cerulean Spice-Lily
  ];

  const roseRand = mulberry32(8419);
  const roseItems = [];
  const addRosePatch = (cx, cz, radius, count, nightLilyRatio = 0.25, skipClear = false) => {
    for (let i = 0; i < count; i++) {
      const a = roseRand() * Math.PI * 2;
      const r = Math.pow(roseRand(), 0.75) * radius;
      const px = cx + Math.cos(a) * r;
      const pz = cz + Math.sin(a) * r;
      if (!skipClear && !isClearForPlant(px, pz, 0.65)) continue;
      const info = getTerrainInfo(px, pz);
      if (info.waterDepth > 0.04) continue;
      const roll = roseRand();
      const variant = roll < nightLilyRatio ? 2 : roll < nightLilyRatio + 0.52 * (1 - nightLilyRatio) ? 0 : 1;
      roseItems.push({
        variant,
        x: px,
        y: info.height - 0.02,
        z: pz,
        yaw: roseRand() * Math.PI * 2,
        scale: 0.78 + roseRand() * 0.42
      });
    }
  };

  // Curated Macro Flora Hero Desert Roses (02_macro_flora: tilted cleanly toward (6.75, 6.45))
  for (const hr of [
    { v: 0, x: 5.05, z: 4.55, s: 1.08 },
    { v: 1, x: 4.75, z: 4.88, s: 0.96 },
    { v: 2, x: 5.22, z: 4.18, s: 1.02 }
  ]) {
    roseItems.push({
      variant: hr.v,
      x: hr.x,
      y: getGroundHeight(hr.x, hr.z) - 0.02,
      z: hr.z,
      yaw: 0.85,
      scale: hr.s
    });
  }
  addRosePatch(4.15, 3.45, 1.35, 14, 0.45);

  // Night Bloom Hero Foreground Bank (05_night_bloom: cam (3.35, 12.35) looking across cistern!)
  for (const nb of [
    { v: 2, x: 4.25, z: 10.45, s: 0.84 },
    { v: 2, x: 3.92, z: 9.75, s: 0.80 },
    { v: 2, x: 2.15, z: 10.85, s: 0.78 },
    { v: 0, x: 4.45, z: 10.05, s: 0.82 }
  ]) {
    roseItems.push({
      variant: nb.v,
      x: nb.x,
      y: getGroundHeight(nb.x, nb.z) - 0.02,
      z: nb.z,
      yaw: roseRand() * Math.PI * 2,
      scale: nb.s
    });
  }

  // Opening Cistern Dawn foreground borders (01_cistern_dawn)
  addRosePatch(-1.95, 12.2, 1.25, 12, 0.35);
  addRosePatch(2.45, 11.8, 1.15, 12, 0.42);
  // Shoreline bioluminescent Spice-Lily pockets reflecting vividly in the cistern at night!
  addRosePatch(-3.5, 7.2, 1.5, 14, 0.78);
  addRosePatch(3.6, 6.8, 1.5, 14, 0.78);
  addRosePatch(-2.4, -1.9, 1.8, 16, 0.85);
  addRosePatch(2.6, -1.7, 1.8, 16, 0.85);
  // Muad'Dib foraging flowers (02_macro_muaddib)
  addRosePatch(3.58, 9.52, 0.82, 7, 0.30);
  addRosePatch(2.52, 8.82, 0.78, 7, 0.30);
  // Sunlit Blooming Erg Ridge blossoms (04_erg_golden, 10m behind horizon cam!)
  addRosePatch(-2.4, -25.6, 2.2, 14, 0.20, true);
  addRosePatch(2.2, -24.8, 2.4, 16, 0.20, true);

  const roseMat = createBotanicalMaterial(sharedUniforms, {
    swayAmp: 0.062,
    swayHeightRef: 0.85,
    roughness: 0.62
  });
  for (let v = 0; v < roseVariants.length; v++) {
    const subset = roseItems.filter((it) => it.variant === v);
    if (!subset.length) continue;
    const im = new THREE.InstancedMesh(roseVariants[v], roseMat, subset.length);
    im.castShadow = true;
    im.receiveShadow = true;
    for (let j = 0; j < subset.length; j++) {
      const it = subset[j];
      dummy.position.set(it.x, it.y, it.z);
      dummy.rotation.set(0, it.yaw, 0);
      dummy.scale.setScalar(it.scale);
      dummy.updateMatrix();
      im.setMatrixAt(j, dummy.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
    group.add(im);
  }

  // -------------------------------------------------------------------------
  // 5. Blue-Agave Rosettes, Century Stalks, Ribbed Barrel Cacti & Organ-Pipe Spears
  //    (Strictly on dry elevated banks & rocky outcrops — NEVER in wet pond mud!)
  // -------------------------------------------------------------------------
  const xerophyteMat = createBotanicalMaterial(sharedUniforms, {
    swayAmp: 0.016,
    swayHeightRef: 1.6,
    roughness: 0.78
  });

  const agavePlainGeo = createAgaveRosetteGeometry(901, false);
  const agaveStalkGeo = createAgaveRosetteGeometry(902, true);
  const barrelCactusGeo = createBarrelCactusClusterGeometry(903);
  const organPipeGeo = createOrganPipeCactusGeometry(904);

  const xeroRand = mulberry32(9511);
  const agavePlainList = [];
  const agaveStalkList = [];
  const barrelList = [];
  const organPipeList = [];

  const curatedXerophytes = [
    // Macro Flora Hero Foreground Trio (02_macro_flora: 1.5..2.1m right-front of cam (6.75, 6.45)!)
    { kind: 'agave', x: 5.42, z: 5.22, scale: 1.18 },
    { kind: 'barrel', x: 5.88, z: 4.62, scale: 1.15 },
    { kind: 'organ', x: 5.25, z: 3.45, scale: 0.94 },
    // Night Bloom Foreground Agave (05_night_bloom: aquamarine dew-channels!)
    { kind: 'agave', x: 4.35, z: 11.25, scale: 0.96 },
    // Muad'Dib shot backdrop (100% clear of camera-to-mouse sightline!)
    { kind: 'agave', x: 2.28, z: 9.25, scale: 0.78 },
    { kind: 'barrel', x: 2.12, z: 8.15, scale: 0.86 },
    { kind: 'agave', x: 4.68, z: 8.85, scale: 0.74 },
    // Cistern Dawn dry elevated flanks
    { kind: 'agave', x: -2.65, z: 12.6, scale: 0.95 },
    { kind: 'agave', x: 2.95, z: 12.2, scale: 0.90 },
    { kind: 'stalk', x: -7.6, z: 11.2, scale: 1.05 },
    { kind: 'stalk', x: 7.8, z: 9.8, scale: 1.02 },
    // Blooming Erg Ridge silhouettes (04_erg_golden: z = -24..-27, 10m behind horizon cam!)
    { kind: 'agave', x: -3.2, z: -25.8, scale: 1.02 },
    { kind: 'barrel', x: -1.1, z: -25.2, scale: 1.05 },
    { kind: 'agave', x: 1.4, z: -24.6, scale: 0.98 },
    { kind: 'organ', x: 3.8, z: -24.4, scale: 0.92 },
    { kind: 'stalk', x: 4.9, z: -24.8, scale: 0.95 }
  ];

  for (const cx of curatedXerophytes) {
    const info = getTerrainInfo(cx.x, cx.z);
    if (info.isWater) continue;
    const rec = { x: cx.x, y: info.height - 0.04, z: cx.z, yaw: xeroRand() * Math.PI * 2, scale: cx.scale };
    if (cx.kind === 'agave') agavePlainList.push(rec);
    else if (cx.kind === 'stalk') agaveStalkList.push(rec);
    else if (cx.kind === 'barrel') barrelList.push(rec);
    else organPipeList.push(rec);
  }

  // Sparse naturalistic outer-basin xerophytes tucked strictly near dry rocky rises (r > 13.5m, clear of open sand flats!)
  for (let i = 0; i < 32; i++) {
    const a = xeroRand() * Math.PI * 2;
    const r = 13.8 + xeroRand() * 12.0;
    const px = Math.cos(a) * r;
    const pz = 2.0 + Math.sin(a) * r;
    if (!isClearForPlant(px, pz, 1.65)) continue;
    // Keep open northern Erg gap, canopy upward foreground, & central Yardang sand apron clean!
    if (Math.abs(px) < 11.5 && pz < -6.0) continue;
    if (px > -16.0 && px < 2.0 && pz > -8.0 && pz < 12.0) continue;
    const info = getTerrainInfo(px, pz);
    if (info.isWater || info.moisture > 0.05 || info.height < WATER_LEVEL + 0.45) continue;
    const roll = xeroRand();
    const rec = { x: px, y: info.height - 0.04, z: pz, yaw: xeroRand() * Math.PI * 2, scale: 0.78 + xeroRand() * 0.38 };
    if (roll < 0.48) agavePlainList.push(rec);
    else if (roll < 0.64) barrelList.push(rec);
    else if (roll < 0.82) organPipeList.push(rec);
    else agaveStalkList.push(rec);
  }

  for (const [geo, list] of [
    [agavePlainGeo, agavePlainList],
    [agaveStalkGeo, agaveStalkList],
    [barrelCactusGeo, barrelList],
    [organPipeGeo, organPipeList]
  ]) {
    if (!list.length) continue;
    const im = new THREE.InstancedMesh(geo, xerophyteMat, list.length);
    im.castShadow = true;
    im.receiveShadow = true;
    for (let j = 0; j < list.length; j++) {
      const it = list[j];
      dummy.position.set(it.x, it.y, it.z);
      dummy.rotation.set(0, it.yaw, 0);
      dummy.scale.setScalar(it.scale);
      dummy.updateMatrix();
      im.setMatrixAt(j, dummy.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
    group.add(im);
  }

  // -------------------------------------------------------------------------
  // 6. Silvery Ghost-Grass & Frosted Desert Sage Tussocks
  // -------------------------------------------------------------------------
  const ghostGeo = createGhostGrassTussockGeometry(991);
  const ghostMat = createBotanicalMaterial(sharedUniforms, {
    swayAmp: 0.072,
    swayHeightRef: 0.55,
    roughness: 0.74
  });
  const ghostRand = mulberry32(9973);
  const ghostItems = [];

  const addGhostRing = (cx, cz, radius, count, skipClear = false) => {
    for (let i = 0; i < count; i++) {
      const a = ghostRand() * Math.PI * 2;
      const r = Math.pow(ghostRand(), 0.75) * radius;
      const px = cx + Math.cos(a) * r;
      const pz = cz + Math.sin(a) * r;
      if (!skipClear && !isClearForPlant(px, pz, 0.58)) continue;
      const info = getTerrainInfo(px, pz);
      if (info.isWater) continue;
      ghostItems.push({
        x: px,
        y: info.height - 0.02,
        z: pz,
        yaw: ghostRand() * Math.PI * 2,
        scale: 0.75 + ghostRand() * 0.52
      });
    }
  };

  addGhostRing(-1.95, 12.4, 1.4, 14);
  addGhostRing(2.45, 12.0, 1.3, 12);
  addGhostRing(4.85, 4.45, 1.5, 14);
  addGhostRing(3.25, 9.35, 1.4, 12);
  // Blooming Erg Ridge silvery ghost-grass (04_erg_golden!)
  addGhostRing(-2.5, -25.6, 2.5, 18, true);
  addGhostRing(2.5, -24.8, 2.6, 18, true);
  addGhostRing(0.0, 3.8, 10.2, 42);

  if (ghostItems.length > 0) {
    const ghostIM = new THREE.InstancedMesh(ghostGeo, ghostMat, ghostItems.length);
    ghostIM.castShadow = true;
    ghostIM.receiveShadow = true;
    for (let j = 0; j < ghostItems.length; j++) {
      const it = ghostItems[j];
      dummy.position.set(it.x, it.y, it.z);
      dummy.rotation.set(0, it.yaw, 0);
      dummy.scale.setScalar(it.scale);
      dummy.updateMatrix();
      ghostIM.setMatrixAt(j, dummy.matrix);
    }
    ghostIM.instanceMatrix.needsUpdate = true;
    group.add(ghostIM);
  }

  if (scene) {
    scene.add(group);
  }

  function update() {
    if (!worldState) return;
    sharedUniforms.uTime.value = worldState.elapsed;
    sharedUniforms.uWindDir.value.copy(worldState.windDir);
    sharedUniforms.uWindSpeed.value = worldState.windSpeed;
    sharedUniforms.uSunDir.value.copy(worldState.sunDir);
    sharedUniforms.uSunColor.value.copy(worldState.sunColor);
    sharedUniforms.uSunIntensity.value = worldState.sunIntensity;
    sharedUniforms.uNight.value = 1.0 - smoothstep(-0.14, 0.06, worldState.sunDir.y);
    sharedUniforms.uEclipse.value = worldState.eclipseStrength;
  }

  return { group, update };
}
