import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { NOISE_GLSL } from '../shaders/noise.glsl.js';
import { CISTERN_CENTER, WATER_LEVEL, getTerrainInfo, smoothstep } from './terrainMath.js';

const TERRAIN_SEGS = 540;
const TERRAIN_RADIUS = 480.0;
const TERRAIN_CENTER_X = 0.0;
const TERRAIN_CENTER_Z = -6.0;

const WATER_WIDTH = 19;
const WATER_HEIGHT = 22;
const WATER_SEGS_X = 140;
const WATER_SEGS_Z = 140;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function warpAxis(a) {
  return TERRAIN_RADIUS * (0.11 * a + 0.32 * Math.pow(a, 1.55) + 0.57 * Math.pow(a, 2.45));
}

function invertWarpAxis(absOffset) {
  const target = clamp(absOffset, 0.0, TERRAIN_RADIUS);
  let lo = 0.0;
  let hi = 1.0;
  for (let it = 0; it < 18; it++) {
    const mid = 0.5 * (lo + hi);
    if (warpAxis(mid) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function sampleTerrainMeshHeight(geometry, wx, wz) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const dx = wx - TERRAIN_CENTER_X;
  const dz = wz - TERRAIN_CENTER_Z;
  const nx = Math.sign(dx) * invertWarpAxis(Math.abs(dx));
  // PlaneGeometry before rotateX(-PI/2) has x in [-1, 1] left->right, y in [+1, -1] top->bottom;
  // after rotateX(-PI/2), local y becomes -z, so z runs -TERRAIN_RADIUS (row 0) -> +TERRAIN_RADIUS (row TERRAIN_SEGS).
  const nz = Math.sign(dz) * invertWarpAxis(Math.abs(dz));
  const fx = clamp((nx + 1.0) * 0.5 * TERRAIN_SEGS, 0.0, TERRAIN_SEGS - 1e-5);
  const fz = clamp((nz + 1.0) * 0.5 * TERRAIN_SEGS, 0.0, TERRAIN_SEGS - 1e-5);
  const col = Math.min(Math.floor(fx), TERRAIN_SEGS - 1);
  const row = Math.min(Math.floor(fz), TERRAIN_SEGS - 1);

  if (index) {
    const triBase = (row * TERRAIN_SEGS + col) * 6;
    for (let t = 0; t < 2; t++) {
      const i0 = index.getX(triBase + t * 3);
      const i1 = index.getX(triBase + t * 3 + 1);
      const i2 = index.getX(triBase + t * 3 + 2);
      const x0 = pos.getX(i0), z0 = pos.getZ(i0);
      const x1 = pos.getX(i1), z1 = pos.getZ(i1);
      const x2 = pos.getX(i2), z2 = pos.getZ(i2);
      const denom = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
      if (Math.abs(denom) < 1e-10) continue;
      const w0 = ((z1 - z2) * (wx - x2) + (x2 - x1) * (wz - z2)) / denom;
      const w1 = ((z2 - z0) * (wx - x2) + (x0 - x2) * (wz - z2)) / denom;
      const w2 = 1.0 - w0 - w1;
      if (w0 >= -1e-4 && w1 >= -1e-4 && w2 >= -1e-4) {
        return w0 * pos.getY(i0) + w1 * pos.getY(i1) + w2 * pos.getY(i2);
      }
    }
  }
  const cols = TERRAIN_SEGS + 1;
  const tx = fx - col;
  const tz = fz - row;
  const idx00 = row * cols + col;
  const idx10 = idx00 + 1;
  const idx01 = idx00 + cols;
  const idx11 = idx01 + 1;
  const h0 = pos.getY(idx00) * (1.0 - tx) + pos.getY(idx10) * tx;
  const h1 = pos.getY(idx01) * (1.0 - tx) + pos.getY(idx11) * tx;
  return h0 * (1.0 - tz) + h1 * tz;
}

function populateTerrainGeometry(geometry) {
  geometry.rotateX(-Math.PI / 2);

  const pos = geometry.attributes.position;
  const count = pos.count;

  const rockArr = new Float32Array(count);
  const moistureArr = new Float32Array(count);
  const pathArr = new Float32Array(count);
  const spiceArr = new Float32Array(count);
  const crestArr = new Float32Array(count);
  const slipArr = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const nx = pos.getX(i);
    const nz = pos.getZ(i);
    const ax = Math.abs(nx);
    const az = Math.abs(nz);

    const wx = TERRAIN_CENTER_X + Math.sign(nx) * warpAxis(ax);
    const wz = TERRAIN_CENTER_Z + Math.sign(nz) * warpAxis(az);
    const info = getTerrainInfo(wx, wz);

    pos.setXYZ(i, wx, info.height, wz);

    rockArr[i] = info.rockMask;
    moistureArr[i] = info.moisture;
    pathArr[i] = info.pathMask;
    spiceArr[i] = info.spiceRichness;
    crestArr[i] = info.duneCrest;
    slipArr[i] = info.slipFace;
  }

  // Gentle midground/distant (>42m) Nyquist 3x3 binomial filter prevents diagonal triangle ridge beading while keeping foreground crisp
  const cols = TERRAIN_SEGS + 1;
  const srcY = new Float32Array(count);
  const srcCrest = new Float32Array(crestArr);
  const srcSlip = new Float32Array(slipArr);
  for (let i = 0; i < count; i++) srcY[i] = pos.getY(i);
  for (let row = 1; row < TERRAIN_SEGS; row++) {
    for (let col = 1; col < TERRAIN_SEGS; col++) {
      const idx = row * cols + col;
      const r = Math.hypot(pos.getX(idx) - TERRAIN_CENTER_X, pos.getZ(idx) - TERRAIN_CENTER_Z);
      const aaW = 0.48 * smoothstep(42.0, 150.0, r);
      if (aaW <= 0.002) continue;
      const topRow = (row - 1) * cols + col;
      const midRow = idx;
      const botRow = (row + 1) * cols + col;
      const filteredY =
        (srcY[topRow - 1] + 2.0 * srcY[topRow] + srcY[topRow + 1] +
          2.0 * (srcY[midRow - 1] + 2.0 * srcY[midRow] + srcY[midRow + 1]) +
          srcY[botRow - 1] + 2.0 * srcY[botRow] + srcY[botRow + 1]) / 16.0;
      pos.setY(idx, srcY[idx] + (filteredY - srcY[idx]) * aaW);

      const maskAA = 0.42 * smoothstep(52.0, 160.0, r);
      if (maskAA > 0.002) {
        const fCrest =
          (srcCrest[topRow - 1] + 2.0 * srcCrest[topRow] + srcCrest[topRow + 1] +
            2.0 * (srcCrest[midRow - 1] + 2.0 * srcCrest[midRow] + srcCrest[midRow + 1]) +
            srcCrest[botRow - 1] + 2.0 * srcCrest[botRow] + srcCrest[botRow + 1]) / 16.0;
        const fSlip =
          (srcSlip[topRow - 1] + 2.0 * srcSlip[topRow] + srcSlip[topRow + 1] +
            2.0 * (srcSlip[midRow - 1] + 2.0 * srcSlip[midRow] + srcSlip[midRow + 1]) +
            srcSlip[botRow - 1] + 2.0 * srcSlip[botRow] + srcSlip[botRow + 1]) / 16.0;
        crestArr[idx] = srcCrest[idx] + (fCrest - srcCrest[idx]) * maskAA;
        slipArr[idx] = srcSlip[idx] + (fSlip - srcSlip[idx]) * maskAA;
      }
    }
  }

  geometry.setAttribute('aRock', new THREE.BufferAttribute(rockArr, 1));
  geometry.setAttribute('aMoisture', new THREE.BufferAttribute(moistureArr, 1));
  geometry.setAttribute('aPath', new THREE.BufferAttribute(pathArr, 1));
  geometry.setAttribute('aSpice', new THREE.BufferAttribute(spiceArr, 1));
  geometry.setAttribute('aCrest', new THREE.BufferAttribute(crestArr, 1));
  geometry.setAttribute('aSlip', new THREE.BufferAttribute(slipArr, 1));

  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
}

function createTerrainMaterial(sharedUniforms) {
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.91,
    metalness: 0.0,
    ior: 1.5,
    specularIntensity: 0.035,
    specularColor: new THREE.Color(0xf6d5b0),
    diffuseRoughness: 0.78,
    envMapIntensity: 0.25
  });

  material.customProgramCacheKey = () => 'arrakis-terrain-pbr-v16-trail-selfshadow';

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
#include <common>
attribute float aRock;
attribute float aMoisture;
attribute float aPath;
attribute float aSpice;
attribute float aCrest;
attribute float aSlip;

uniform float uTime;
uniform vec3 uWormPos;
uniform float uWormTremor;
uniform sampler2D uTrailMap;
uniform vec2 uTrailOrigin;
uniform float uTrailSize;
uniform float uTrailEnabled;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vRock;
varying float vMoisture;
varying float vPath;
varying float vSpice;
varying float vCrest;
varying float vSlip;
`
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
#include <begin_vertex>
vec4 arrakisPreWorld = modelMatrix * vec4( transformed, 1.0 );
vec2 wormDeltaV = arrakisPreWorld.xz - uWormPos.xz;
float wormDistV = length( wormDeltaV );
if ( arrakisPreWorld.z < -26.0 && wormDistV < 26.0 && uWormTremor > 0.01 ) {
  float wFalloff = exp( -wormDistV * 0.13 ) * smoothstep( 26.0, 4.0, wormDistV );
  transformed.y += sin( wormDistV * 0.85 - uTime * 7.2 ) * wFalloff * uWormTremor * 0.56;
}
if ( uTrailEnabled > 0.5 && aRock < 0.75 ) {
  vec2 tvUv = ( arrakisPreWorld.xz - uTrailOrigin ) / uTrailSize + 0.5;
  if ( tvUv.x > 0.03 && tvUv.x < 0.97 && tvUv.y > 0.03 && tvUv.y < 0.97 ) {
    float tDisp = ( texture2D( uTrailMap, tvUv ).r - 0.5 ) * 2.0;
    transformed.y += tDisp * 0.048 * ( 1.0 - aRock );
  }
}
`
      )
      .replace(
        '#include <worldpos_vertex>',
        /* glsl */ `
#include <worldpos_vertex>
vRock = aRock;
vMoisture = aMoisture;
vPath = aPath;
vSpice = aSpice;
vCrest = aCrest;
vSlip = aSlip;
vec4 arrakisWorldPos = modelMatrix * vec4( transformed, 1.0 );
vWorldPos = arrakisWorldPos.xyz;
vWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
#include <common>
${NOISE_GLSL}

uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindSpeed;
uniform float uSaltation;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uHorizonColor;
uniform vec3 uZenithColor;
uniform float uFogDensity;
uniform float uEclipse;
uniform float uMirage;
uniform float uSpiceBlow;
uniform vec3 uSpiceOrigin;
uniform vec3 uThumperPos;
uniform float uThumperPulse;
uniform float uThumperTrail;
uniform vec3 uWormPos;
uniform float uWormTremor;
uniform sampler2D uTrailMap;
uniform vec2 uTrailOrigin;
uniform float uTrailSize;
uniform float uTrailEnabled;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vRock;
varying float vMoisture;
varying float vPath;
varying float vSpice;
varying float vCrest;
varying float vSlip;

vec2 triRippleValDeriv( float phase, float crestPos, float tipSmooth ) {
  float p = fract( phase * 0.15915494 );
  float cPos = clamp( crestPos, 0.15, 0.85 );
  float t = p < cPos
    ? ( p / cPos )
    : ( ( 1.0 - p ) / ( 1.0 - cPos ) );
  float dtDp = p < cPos
    ? ( 1.0 / cPos )
    : ( -1.0 / ( 1.0 - cPos ) );

  // Asymmetric eolian ripple profile: broader wind-swept trough, crisper lee-brink crest
  float e0 = clamp( tipSmooth * 1.24, 0.045, 0.44 );
  float e1 = clamp( tipSmooth * 0.62, 0.028, 0.38 );
  float span = max( 1.0 - 0.5 * ( e0 + e1 ), 0.001 );
  float g;
  float dgDt;
  if ( t < e0 ) {
    g = 0.5 * t * t / ( e0 * span );
    dgDt = t / ( e0 * span );
  } else if ( t > 1.0 - e1 ) {
    float u = 1.0 - t;
    g = 1.0 - 0.5 * u * u / ( e1 * span );
    dgDt = u / ( e1 * span );
  } else {
    g = ( t - 0.5 * e0 ) / span;
    dgDt = 1.0 / span;
  }

  float val = g * 2.0 - 1.0;
  float dValDPhase = dgDt * dtDp * 0.31830989;
  return vec2( val, dValDPhase );
}

float evalRippleMeander( float uA, float uC ) {
  vec2 sUv = vec2( uA * 0.088, uC * 0.135 );
  float sw1 = fbm2( sUv + vec2( 2.7, -4.1 ) ) - 0.5;
  float sw2 = vnoise2( vec2( uA * 0.18, uC * 0.24 ) + vec2( -6.3, 8.2 ) ) - 0.5;
  float dr1 = fbm2( vec2( uA * 0.048, uC * 0.082 ) + vec2( 9.1, -3.7 ) ) - 0.5;
  return sw1 * 0.96 + sw2 * 0.20 + dr1 * 0.58;
}
`
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
#include <map_fragment>

vec3 n0 = normalize( vWorldNormal );
vec3 viewVec = cameraPosition - vWorldPos;
float viewDist = length( viewVec );
vec3 V = viewVec / max( viewDist, 0.0001 );

// Footprint-aware anti-aliasing across grazing slopes & distant Erg dunes
vec3 dpdx = dFdx( vWorldPos );
vec3 dpdy = dFdy( vWorldPos );
float pxSize = max( length( dpdx ), length( dpdy ) );

// Core terrain masks (continuous capillary dampness across heightAboveWater with zero 1px glossy meniscus seam)
float rockEdgeDrift = ( fbm2( vWorldPos.xz * 0.28 + vec2( 4.1, -6.3 ) ) - 0.5 ) * 0.22;
float rockFactor = smoothstep( 0.10, 0.52, vRock + rockEdgeDrift * smoothstep( 0.02, 0.20, vRock ) * ( 1.0 - smoothstep( 0.58, 0.90, vRock ) ) );
float pathFactor = smoothstep( 0.10, 0.56, vPath );
float nearWaterMargin = smoothstep( 0.04, 0.40, vMoisture );
float cisternRadial = length( vWorldPos.xz - vec2( ${CISTERN_CENTER.x.toFixed(2)}, ${CISTERN_CENTER.z.toFixed(2)} ) );
float bankProximity = 1.0 - smoothstep( 7.5, 11.5, cisternRadial );
float bankMoisture = clamp( max( nearWaterMargin, bankProximity * 0.92 ), 0.0, 1.0 );
float heightAboveWater = vWorldPos.y - ${WATER_LEVEL.toFixed(2)};

// 1. Coherent Asymmetric Eolian Wind-Ripples, Secondary Micro-Ripples, Sastrugi Mid-Slopes & Smooth Quartz Grit
vec2 wDir = length( uWindDir ) > 0.0001 ? normalize( uWindDir ) : vec2( 1.0, 0.0 );
vec2 wPerp = vec2( -wDir.y, wDir.x );
float creep = uTime * ( 0.032 + uWindSpeed * 0.12 );

float rippleFootprint = max( length( vec2( dot( dpdx.xz, wDir ), dot( dpdy.xz, wDir ) ) ), pxSize * 0.45 );
float detailFade = smoothstep( 0.175, 0.020, pxSize ) * ( 1.0 - smoothstep( 12.0, 34.0, viewDist ) );
float rippleFade = smoothstep( 0.145, 0.018, rippleFootprint ) * ( 1.0 - smoothstep( 14.0, 34.0, viewDist ) );
float microRippleFade = smoothstep( 0.056, 0.011, rippleFootprint ) * ( 1.0 - smoothstep( 6.5, 16.5, viewDist ) );
float swellFade = smoothstep( 0.75, 0.10, pxSize ) * ( 1.0 - smoothstep( 28.0, 66.0, viewDist ) );
float sastrugiFade = smoothstep( 1.40, 0.22, pxSize ) * smoothstep( 8.0, 20.0, viewDist ) * ( 1.0 - smoothstep( 92.0, 128.0, viewDist ) );
float grainBumpFade = smoothstep( 0.088, 0.008, pxSize ) * ( 1.0 - smoothstep( 5.5, 19.0, viewDist ) );
float fineGrainFade = smoothstep( 0.034, 0.006, pxSize ) * ( 1.0 - smoothstep( 3.0, 12.0, viewDist ) );
float strataFade = smoothstep( 0.85, 0.14, pxSize ) * ( 1.0 - smoothstep( 120.0, 420.0, viewDist ) );

float slipSmooth = smoothstep( 0.10, 0.46, vSlip );
// Preserve 100% crisp sand ripples & micro-grain right through wet shore & shallow submerged bed
float sandMask = ( 1.0 - rockFactor ) * ( 1.0 - pathFactor * 0.85 );
float crestCalm = 1.0 - smoothstep( 0.68, 0.96, vCrest ) * 0.52;

// Wind-coherent transverse axes with organic flowing drift and Y-bifurcations (zero diamond moire)
float uAlong = dot( vWorldPos.xz, wDir );
float uCross = dot( vWorldPos.xz, wPerp );
float alongMeander = evalRippleMeander( uAlong, uCross );

// Richer patch-scale/phase breakup & wind-aligned gust-scoured pockets
float streakNoise = fbm2( vec2( uAlong * 0.115, uCross * 0.24 ) + vec2( 5.2, -2.8 ) ) * 0.65
                  + vnoise2( vec2( uAlong * 0.24, uCross * 0.38 ) + vec2( -4.1, 6.3 ) ) * 0.35;
float patchMask = mix( 0.24, 1.0, smoothstep( 0.16, 0.80, streakNoise ) );
float rippleAmp = sandMask * patchMask * ( 1.0 - slipSmooth ) * crestCalm;

// Coherent wind ripples with organic meandering and gentle +-3.2 deg (tan = 0.056) flowing forks
vec2 dir1 = normalize( wDir + wPerp * 0.056 );
vec2 dir2 = normalize( wDir - wPerp * 0.056 );

float ripVal = 0.0;
float ripFineVal = 0.0;
vec2 ripGradXZ = vec2( 0.0 );

if ( rippleFade > 0.005 && rippleAmp > 0.005 ) {
  float epsM = 0.04;
  float mA = evalRippleMeander( uAlong + epsM, uCross );
  float mC = evalRippleMeander( uAlong, uCross + epsM );
  float dMeanderDAlong = ( mA - alongMeander ) / epsM;
  float dMeanderDCross = ( mC - alongMeander ) / epsM;
  vec2 meanderGrad = wDir * dMeanderDAlong + wPerp * dMeanderDCross;

  float patchScale = 1.0 + ( fbm2( vec2( uAlong * 0.12, uCross * 0.18 ) + vec2( -7.3, 4.9 ) ) - 0.5 ) * 0.18;
  float phaseBreak1 = ( fbm2( vec2( uAlong * 0.16, uCross * 0.26 ) + vec2( -9.3, 5.1 ) ) - 0.5 ) * 0.18;
  float phaseBreak2 = ( fbm2( vec2( uAlong * 0.18, uCross * 0.28 ) + vec2( 11.7, -8.4 ) ) - 0.5 ) * 0.20;

  vec2 effDir1 = dir1 + meanderGrad;
  vec2 effDir2 = dir2 + meanderGrad * 0.94;

  float tipSmooth = mix( 0.28, 0.064, smoothstep( 0.14, 0.84, rippleFade ) );
  float freq1 = 31.2 * patchScale;
  float freq2 = 31.9 * ( 2.0 - patchScale );
  float phase1 = ( dot( vWorldPos.xz, dir1 ) + alongMeander + phaseBreak1 - creep ) * freq1;
  float phase2 = ( dot( vWorldPos.xz, dir2 ) + alongMeander * 0.94 + phaseBreak2 - creep * 1.04 ) * freq2 + 1.35;

  vec2 rip1 = triRippleValDeriv( phase1, 0.76, tipSmooth );
  vec2 rip2 = triRippleValDeriv( phase2, 0.75, tipSmooth );

  float branchNoise = fbm2( vec2( uAlong * 0.16, uCross * 0.28 ) + vec2( -3.4, 7.1 ) )
                    + ( vnoise2( vec2( uAlong * 0.30, uCross * 0.42 ) ) - 0.5 ) * 0.18;
  float bifBlend = smoothstep( 0.44, 0.56, branchNoise );
  float forkSoft = 1.0 - 0.32 * 4.0 * bifBlend * ( 1.0 - bifBlend );

  ripVal = mix( rip1.x, rip2.x, bifBlend ) * forkSoft;
  ripGradXZ = mix( effDir1 * rip1.y, effDir2 * rip2.y * 1.04, bifBlend ) * forkSoft;

  // Crisp secondary micro-ripple (~0.095m wavelength) layered cleanly within 0..16m
  if ( microRippleFade > 0.005 ) {
    vec2 dirFine = normalize( wDir - wPerp * 0.032 );
    vec2 effDirFine = dirFine + meanderGrad * 1.02;
    vec2 ripFine = triRippleValDeriv( ( dot( vWorldPos.xz, dirFine ) + alongMeander * 1.05 + phaseBreak1 * 0.5 - creep * 1.20 ) * 66.0 + 0.85, 0.74, clamp( tipSmooth * 1.12, 0.045, 0.40 ) );
    ripFineVal = ripFine.x;
    ripGradXZ += effDirFine * ( ripFine.y * 0.30 * microRippleFade );
  }
}

// Smooth multi-scale capillary shore dampness across heightAboveWater with organic wicking (rich dark wet-sand collar)
float capMacro = fbm2( vWorldPos.xz * 0.55 + vec2( -1.8, 3.4 ) );
float capEdgeNoise = fbm2( vWorldPos.xz * 2.10 + vec2( 3.7, -5.2 ) ) * 0.64
                   + vnoise2( vWorldPos.xz * 5.20 - vec2( 2.1, 4.9 ) ) * 0.36;
float troughWick = clamp( -ripVal, -1.0, 1.0 ) * 0.016 * ( 1.0 - rockFactor ) * ( 1.0 - pathFactor * 0.5 );
float capTop = 0.095 + capMacro * 0.125 + ( capEdgeNoise - 0.5 ) * 0.045 + troughWick;
float pathWetAtten = 1.0 - pathFactor * 0.25 * smoothstep( 0.02, 0.10, heightAboveWater );
float wetFactor = clamp( ( 1.0 - smoothstep( -0.03, capTop, heightAboveWater ) ) * bankMoisture * pathWetAtten, 0.0, 1.0 );

// Gentle ~3.5m wind-coherent sand drift swells for organic foreground undulation
float swellVal = 0.0;
vec2 swellGradXZ = vec2( 0.0 );
if ( swellFade > 0.005 && sandMask > 0.005 ) {
  float swPhaseA = ( uAlong + alongMeander * 0.85 ) * 1.72 + sin( uCross * 0.36 ) * 0.45;
  float swPhaseB = ( dot( vWorldPos.xz, dir2 ) + alongMeander * 0.65 ) * 1.38 + 1.4;
  swellVal = sin( swPhaseA ) * 0.64 + sin( swPhaseB ) * 0.36;
  swellGradXZ = dir1 * ( cos( swPhaseA ) * 1.72 * 0.64 ) + dir2 * ( cos( swPhaseB ) * 1.38 * 0.36 );
}
float swellAmp = 0.028 * swellFade * sandMask * ( 1.0 - slipSmooth * 0.65 ) * ( 1.0 - wetFactor * 0.28 );

// Medium-scale (1.5-4.5m) wind-carved sastrugi ribs & broad eolian drift streaks bridging 18..120m mid-slopes
float sasVal = 0.0;
float driftStreak = 0.0;
vec2 sasGradXZ = vec2( 0.0 );
if ( sastrugiFade > 0.005 && sandMask > 0.005 ) {
  vec2 sasDir1 = normalize( wDir * 0.88 + wPerp * 0.47 );
  vec2 sasDir2 = normalize( wDir * 0.46 - wPerp * 0.89 );
  float sasWarp = ( fbm2( vec2( uAlong * 0.055, uCross * 0.088 ) + vec2( 3.9, -6.2 ) ) - 0.5 ) * 2.15;
  float sasTip = mix( 0.36, 0.16, smoothstep( 0.20, 0.88, sastrugiFade ) );
  vec2 sas1 = triRippleValDeriv( ( dot( vWorldPos.xz, sasDir1 ) + sasWarp ) * 2.25, 0.72, sasTip );
  vec2 sas2 = triRippleValDeriv( ( dot( vWorldPos.xz, sasDir2 ) + sasWarp * 0.75 ) * 1.58 + 1.15, 0.70, sasTip );
  float sasPocket = smoothstep( 0.20, 0.80, fbm2( vec2( uAlong * 0.032, uCross * 0.145 ) + vec2( -5.1, 8.4 ) ) );

  float d0 = fbm2( vec2( uAlong * 0.030, uCross * 0.235 ) + vec2( 7.3, -2.1 ) ) - 0.5;
  float dC = fbm2( vec2( uAlong * 0.030, ( uCross + 0.22 ) * 0.235 ) + vec2( 7.3, -2.1 ) ) - 0.5;
  driftStreak = d0;
  float dDriftDCross = ( dC - d0 ) / 0.22;

  float sasMix = mix( 0.38, 0.72, sasPocket );
  sasVal = mix( sas2.x, sas1.x, sasMix ) * ( 0.45 + 0.55 * sasPocket );
  sasGradXZ = mix( sasDir2 * sas2.y, sasDir1 * sas1.y, sasMix ) * ( 0.45 + 0.55 * sasPocket )
            + wPerp * ( dDriftDCross * 0.52 );
}
float sasSlope = 0.090 * sastrugiFade * sandMask * ( 1.0 - slipSmooth * 0.72 ) * ( 1.0 - wetFactor );

// Subtle high-frequency continuous quartz micro-grain normal relief fading cleanly by 19m (zero floor() grid!)
float grainAmp = 0.056 * grainBumpFade * sandMask * ( 1.0 - wetFactor * 0.45 ) * ( 1.0 - slipSmooth * 0.45 );
float gDx = 0.0;
float gDz = 0.0;
if ( grainAmp > 0.0005 ) {
  vec2 gUv = vWorldPos.xz * 38.0;
  mat2 gRot = mat2( 0.80, -0.60, 0.60, 0.80 );
  float epsG = 0.12;
  float g0 = vnoise2( gUv ) * 0.62 + vnoise2( gRot * gUv * 2.15 + vec2( 5.7, -3.1 ) ) * 0.38 * fineGrainFade;
  float gX = vnoise2( gUv + vec2( epsG, 0.0 ) ) * 0.62 + vnoise2( gRot * ( gUv + vec2( epsG, 0.0 ) ) * 2.15 + vec2( 5.7, -3.1 ) ) * 0.38 * fineGrainFade;
  float gZ = vnoise2( gUv + vec2( 0.0, epsG ) ) * 0.62 + vnoise2( gRot * ( gUv + vec2( 0.0, epsG ) ) * 2.15 + vec2( 5.7, -3.1 ) ) * 0.38 * fineGrainFade;
  gDx = ( gX - g0 ) * ( grainAmp / epsG );
  gDz = ( gZ - g0 ) * ( grainAmp / epsG );
}

float closeCrisp = 1.0 - smoothstep( 6.0, 18.0, viewDist );
float ripSlope = mix( 0.112, 0.182, closeCrisp ) * rippleFade * rippleAmp;
vec3 totalGrad = vec3(
  ripGradXZ.x * ripSlope + swellGradXZ.x * swellAmp + sasGradXZ.x * sasSlope + gDx,
  0.0,
  ripGradXZ.y * ripSlope + swellGradXZ.y * swellAmp + sasGradXZ.y * sasSlope + gDz
);

// Warm-vs-cool high-contrast Arrakis sand palette (with suppressed nocturnal/eclipse crest highlight)
float macroSandVar = fbm2( vWorldPos.xz * 0.025 + vec2( 4.2, -7.1 ) );
vec2 gmUv = vec2( vWorldPos.x * 0.80 - vWorldPos.z * 0.60, vWorldPos.x * 0.60 + vWorldPos.z * 0.80 );
float grainMicro = vnoise2( vWorldPos.xz * 18.0 ) * 0.42 + vnoise2( gmUv * 42.0 + vec2( 3.1, -2.7 ) ) * 0.36 + vnoise2( gmUv * 78.0 - vec2( 6.4, 1.9 ) ) * 0.22;
vec3 sandTrough = vec3( 0.46, 0.27, 0.125 );
vec3 sandMid    = vec3( 0.64, 0.42, 0.205 );
vec3 sandCrest  = vec3( 0.84, 0.60, 0.315 );
vec3 sandSlip   = vec3( 0.36, 0.19, 0.088 );

vec3 sunDirM = normalize( uSunDir );
float zenithLumaM = dot( uZenithColor, vec3( 0.2126, 0.7152, 0.0722 ) );
float nightGateM = 1.0 - smoothstep( -0.02, 0.14, sunDirM.y );
float eclipseGateM = max( uEclipse, ( 1.0 - smoothstep( 0.045, 0.14, zenithLumaM ) ) * smoothstep( -0.04, 0.12, sunDirM.y ) * ( 1.0 - smoothstep( 2.0, 2.7, uSunIntensity ) ) );
float darkGateM = clamp( max( nightGateM, eclipseGateM ), 0.0, 1.0 );

float silhouetteAA = mix( 1.0, smoothstep( 0.008, 0.095, max( dot( n0, V ), 0.0 ) ), smoothstep( 115.0, 240.0, viewDist ) );
vec3 sandColor = mix( sandTrough, sandMid, smoothstep( 0.22, 0.76, macroSandVar ) );
float crestHighlight = smoothstep( 0.28, 0.90, vCrest ) * ( 1.0 - smoothstep( 0.14, 0.38, vSlip ) ) * silhouetteAA;
sandColor = mix( sandColor, sandCrest, crestHighlight * mix( 0.92, 0.06, darkGateM ) );
float leePack = smoothstep( 0.10, 0.44, vSlip );
float sunUpM = smoothstep( 0.02, 0.18, sunDirM.y );
float leeSunLit = smoothstep( 0.16, 0.50, dot( n0, sunDirM ) ) * sunUpM;
sandColor = mix( sandColor, sandSlip, leePack * mix( 0.74, 0.22, leeSunLit ) );

// Crisp crest brink curl & down-slope avalanche slipface chutes (faded smoothly at grazing ridge silhouettes)
float brinkViewFade = smoothstep( 0.08, 0.28, abs( dot( n0, V ) ) );
float crestZone = smoothstep( 0.48, 0.94, vCrest );
float brinkMask = crestZone * leePack * sandMask * ( 1.0 - wetFactor ) * brinkViewFade;
float windApproach = crestZone * ( 1.0 - leePack ) * sandMask * ( 1.0 - wetFactor ) * smoothstep( 0.45, 0.10, pxSize ) * brinkViewFade;
float horizLen = length( n0.xz );
float horizMask = smoothstep( 0.04, 0.18, horizLen );
if ( horizLen > 0.015 ) {
  vec2 horizDir = n0.xz / horizLen;
  vec2 horizPerp = vec2( -horizDir.y, horizDir.x );
  // Subtle windward crest tilt sunward & crisp slipface angle-of-repose curl
  totalGrad -= vec3( horizDir.x, 0.0, horizDir.y ) * ( ( 0.065 * windApproach + 0.26 * brinkMask ) * horizMask );
  if ( leePack > 0.01 && detailFade > 0.01 ) {
    float sAlong = dot( vWorldPos.xz, horizDir );
    float sCross = dot( vWorldPos.xz, horizPerp );
    float chute = vnoise2( vec2( sAlong * 0.38, sCross * 3.8 ) ) - 0.5;
    float chuteG = ( vnoise2( vec2( sAlong * 0.38, ( sCross + 0.06 ) * 3.8 ) ) - 0.5 - chute ) / 0.06;
    totalGrad += vec3( horizPerp.x, 0.0, horizPerp.y ) * ( chuteG * 0.012 * leePack * sandMask * detailFade );
    sandColor *= ( 1.0 + chute * 0.036 * leePack * detailFade );
  }
}

float rippleShade = ( ripVal * 0.78 * rippleFade + ripFineVal * 0.22 * microRippleFade ) * rippleAmp;
float sastrugiShade = ( sasVal * 0.056 + driftStreak * 0.115 ) * sastrugiFade * sandMask * ( 1.0 - slipSmooth * 0.55 );
sandColor *= ( 1.0 + rippleShade * mix( 0.078, 0.115, closeCrisp ) + swellVal * 0.042 * swellFade * sandMask + sastrugiShade );
float grainMix = detailFade * ( 1.0 - slipSmooth * 0.80 );
sandColor *= mix( 1.0, 0.905 + 0.19 * grainMicro, grainMix );

// Finer continuous wind-swept quartz grain shimmer on sunlit slopes (zero floor() grid!)
float sunFaceM = smoothstep( -0.04, 0.38, dot( n0, sunDirM ) );
float sparkFade = smoothstep( 0.045, 0.006, pxSize ) * ( 1.0 - smoothstep( 5.0, 24.0, viewDist ) );
float sp1 = vnoise2( gmUv * 58.0 + vec2( 2.3, -1.9 ) );
float sp2 = vnoise2( gmUv.yx * 92.0 - vec2( 5.4, 3.7 ) );
float quartzSparkle = pow( clamp( sp1 * sp2 * 1.48, 0.0, 1.0 ), 7.0 )
                    * sparkFade * sunFaceM * ( 1.0 - darkGateM ) * sandMask * ( 1.0 - slipSmooth * 0.75 );

float sandRoughness = clamp(
  0.915 - crestHighlight * 0.025 + leePack * 0.025 + ( grainMicro - 0.5 ) * 0.030 - max( rippleShade, 0.0 ) * 0.015 - quartzSparkle * 0.32,
  0.56,
  0.95
);

vec3 baseAlbedo = sandColor;
float terrainRoughness = sandRoughness;

// 2. Sedimentary Yardang Sandstone Strata (vRock > 0.08)
if ( rockFactor > 0.005 ) {
  float strataWarp = fbm2( vWorldPos.xz * 0.065 ) * 1.4 + vnoise2( vWorldPos.xz * 0.24 ) * 0.26;
  float sy = vWorldPos.y + strataWarp * 0.46;

  float bed1 = sin( sy * 3.4 );
  float bed2 = sin( sy * 9.8 + vnoise2( vWorldPos.xz * 0.45 ) * 1.2 );
  float bed3 = sin( sy * 23.0 + vnoise2( vWorldPos.xz * 1.15 ) * 1.7 );
  float strataMix = bed1 * 0.5 + bed2 * 0.32 + bed3 * 0.18;

  float ledgeShelf = smoothstep( -0.35, 0.45, bed1 ) * 0.6 + smoothstep( -0.2, 0.5, bed2 ) * 0.4;
  float crevice = smoothstep( 0.64, 0.96, abs( sin( sy * 5.2 + 0.4 ) ) );
  float crackNoise = abs( vnoise2( vec2( vWorldPos.x * 0.72 + vWorldPos.z * 0.64, sy * 0.38 ) ) - 0.5 ) * 2.0;
  float vCrack = 1.0 - smoothstep( 0.02, 0.13, crackNoise );

  vec3 rockRust       = vec3( 0.22, 0.062, 0.024 );
  vec3 rockTerracotta = vec3( 0.38, 0.122, 0.045 );
  vec3 rockOchre      = vec3( 0.48, 0.210, 0.084 );
  vec3 rockPaleCap    = vec3( 0.56, 0.300, 0.138 );
  vec3 desertVarnish  = vec3( 0.072, 0.036, 0.025 );

  vec3 rockColor = mix( rockRust, rockTerracotta, smoothstep( -0.6, 0.2, strataMix ) );
  rockColor = mix( rockColor, rockOchre, smoothstep( 0.0, 0.65, ledgeShelf ) );
  rockColor = mix( rockColor, rockPaleCap, smoothstep( 0.52, 0.94, bed2 ) * 0.55 );

  float upFacing = clamp( n0.y, 0.0, 1.0 );
  float varnishMask = smoothstep( 0.44, 0.84, upFacing ) * smoothstep( 0.22, 0.72, vnoise2( vWorldPos.xz * 0.28 + 5.1 ) ) * smoothstep( 0.30, 0.75, ledgeShelf );
  rockColor = mix( rockColor, desertVarnish, varnishMask * 0.74 );

  float rockAO = clamp( 1.0 - crevice * 0.46 - vCrack * 0.52, 0.32, 1.0 );
  rockColor *= rockAO;

  float grit1 = vnoise3( vWorldPos * 6.5 );
  float grit2 = vnoise3( vWorldPos * 19.0 );
  rockColor *= ( 0.85 + 0.30 * grit1 );

  // Trapped windblown sand on flat rock shelves
  float trappedSand = pow( upFacing, 3.0 ) * smoothstep( 0.42, 0.82, fbm2( vWorldPos.xz * 0.34 + 11.2 ) ) * ( 1.0 - smoothstep( 0.45, 0.92, vRock ) );
  rockColor = mix( rockColor, sandColor, trappedSand * 0.65 );

  // Vertical strata & pitted rock grit normal perturbation
  float dStrataDy = ( cos( sy * 3.4 ) * 1.7 + cos( sy * 9.8 + vnoise2( vWorldPos.xz * 0.45 ) * 1.2 ) * 2.8 ) * 0.18 * strataFade;
  float gritDx = ( vnoise3( vWorldPos * 7.5 + vec3( 0.05, 0.0, 0.0 ) ) - grit1 ) * 2.2 * detailFade;
  float gritDz = ( vnoise3( vWorldPos * 7.5 + vec3( 0.0, 0.0, 0.05 ) ) - grit1 ) * 2.2 * detailFade;
  vec3 rockGrad = vec3( gritDx, dStrataDy, gritDz );

  float rockRough = clamp( mix( 0.92, 0.64, varnishMask * 0.65 ) - grit2 * 0.06 + crevice * 0.06, 0.60, 0.97 );
  rockRough = mix( rockRough, sandRoughness, trappedSand * 0.65 );

  baseAlbedo = mix( baseAlbedo, rockColor, rockFactor );
  terrainRoughness = mix( terrainRoughness, rockRough, rockFactor );
  totalGrad = mix( totalGrad, rockGrad, rockFactor );
}

// 3. Sun-Baked Compacted Sandstone-Gravel Qanat Walk & Windtrap Trail
if ( pathFactor > 0.005 ) {
  float northDissolve = smoothstep( -22.0, -13.0, vWorldPos.z );
  float trailDrift = fbm2( vWorldPos.xz * 0.42 - wDir * 0.6 );
  float effectivePath = smoothstep( 0.10, 0.66, vPath ) * smoothstep( 0.14, 0.70, trailDrift * 0.42 + vPath * 0.80 ) * northDissolve;

  float trackTone = fbm2( vWorldPos.xz * 1.15 + vec2( 2.3, -5.1 ) );
  float finePebble = vnoise2( vWorldPos.xz * 19.5 ) * 0.55 + vnoise2( vWorldPos.xz * 44.0 + vec2( 4.1, -1.7 ) ) * 0.45;
  vec3 crushedLimestoneSand = mix(
    sandColor * vec3( 1.06, 1.02, 0.96 ),
    vec3( 0.74, 0.54, 0.32 ),
    0.34
  );
  vec3 packedSand = mix(
    sandColor * vec3( 0.96, 0.94, 0.90 ),
    crushedLimestoneSand * ( 0.93 + 0.14 * finePebble * detailFade ),
    smoothstep( 0.18, 0.78, trackTone )
  );
  float edgeBankAO = 1.0 - smoothstep( 0.12, 0.45, vPath ) * ( 1.0 - smoothstep( 0.55, 0.92, vPath ) ) * 0.055;

  baseAlbedo = mix( baseAlbedo, packedSand, effectivePath * 0.72 ) * edgeBankAO;
  terrainRoughness = mix( terrainRoughness, clamp( sandRoughness + 0.03, 0.86, 0.96 ), effectivePath * 0.64 );
  totalGrad *= mix( 1.0, 0.22, effectivePath );
}

// 4. Dynamic Seismic Thumper Ripples & Shai-Hulud Churning Trench
float thumpEnv = max( uThumperPulse, uThumperTrail );
if ( thumpEnv > 0.005 ) {
  vec2 dT = vWorldPos.xz - uThumperPos.xz;
  float distT = length( dT );
  if ( distT < 46.0 ) {
    vec2 dirT = dT / max( distT, 0.001 );
    float falloff = exp( -distT * 0.062 ) * smoothstep( 46.0, 5.0, distT ) * ( 1.0 - rockFactor * 0.72 );
    float wavePhase = distT * 2.6 - uTime * 19.0;
    float shock = sin( wavePhase );
    float dShock = cos( wavePhase ) * 2.6;
    float amp = 0.28 * thumpEnv * falloff;
    totalGrad += vec3( dirT.x * dShock * amp, 0.0, dirT.y * dShock * amp );
    baseAlbedo += vec3( 0.052, 0.034, 0.016 ) * max( shock, 0.0 ) * thumpEnv * falloff;
  }
}

if ( uWormTremor > 0.01 ) {
  vec2 dW = vWorldPos.xz - uWormPos.xz;
  float distW = length( dW );
  if ( distW < 42.0 ) {
    vec2 dirW = dW / max( distW, 0.001 );
    float wFalloff = exp( -distW * 0.072 ) * smoothstep( 42.0, 5.0, distW ) * uWormTremor;
    float churn = fbm2( vWorldPos.xz * 0.28 + uTime * 0.55 );
    float wPhase = distW * 1.15 - uTime * 7.5 + churn * 3.2;
    float dWPhase = cos( wPhase ) * 1.15;
    float wAmp = 0.46 * wFalloff;
    totalGrad += vec3( dirW.x * dWPhase * wAmp, 0.0, dirW.y * dWPhase * wAmp );

    float trenchCore = exp( -distW * 0.16 ) * uWormTremor;
    baseAlbedo = mix( baseAlbedo, baseAlbedo * 0.54, trenchCore * 0.85 );
    terrainRoughness = mix( terrainRoughness, 0.96, wFalloff * 0.7 );
  }
}

// 4b. Real-Time Dynamic Sand Footprints, Dune-Slide Chutes & Thumper Impact Craters
vec3 sunDirW = normalize( uSunDir );
float trailRimSpark = 0.0;
if ( uTrailEnabled > 0.5 && rockFactor < 0.85 && viewDist < 42.0 ) {
  vec2 tUv = ( vWorldPos.xz - uTrailOrigin ) / uTrailSize + 0.5;
  if ( tUv.x > 0.02 && tUv.x < 0.98 && tUv.y > 0.02 && tUv.y < 0.98 ) {
    float trailEdge = smoothstep( 0.02, 0.09, tUv.x ) * smoothstep( 0.98, 0.91, tUv.x )
                    * smoothstep( 0.02, 0.09, tUv.y ) * smoothstep( 0.98, 0.91, tUv.y );
    float trailDistFade = 1.0 - smoothstep( 26.0, 42.0, viewDist );
    float tWeight = trailEdge * trailDistFade * ( 1.0 - rockFactor * 0.85 );

    vec2 tSample = texture2D( uTrailMap, tUv ).rg;
    float tHeight = ( tSample.r - 0.5 ) * 2.0; // -1 recessed pit .. +1 raised rim
    float tComp = tSample.g;                   // 0 untouched .. 1 compacted

    // Exact neutral baseline (R=128 -> tHeight=0.00392, G=0 -> tComp=0.0) skips 100% cleanly
    if ( abs( tHeight ) > 0.008 || tComp > 0.012 ) {
      const float TRAIL_NEUTRAL = 128.0 / 255.0;
      float tHeightC = ( tSample.r - TRAIL_NEUTRAL ) * 2.0;
      float trailAct = clamp(
        max( ( abs( tHeight ) - 0.008 ) / 0.024, ( tComp - 0.012 ) / 0.032 ),
        0.0,
        1.0
      );

      // Footprint-adaptive kernel prevents grazing-angle stair-stepping & ridge silhouette aliasing
      float texStep = clamp( max( 1.60 / 512.0, pxSize * 0.62 / uTrailSize ), 1.60 / 512.0, 3.50 / 512.0 );
      float hL = ( texture2D( uTrailMap, tUv - vec2( texStep, 0.0 ) ).r - TRAIL_NEUTRAL ) * 2.0;
      float hR = ( texture2D( uTrailMap, tUv + vec2( texStep, 0.0 ) ).r - TRAIL_NEUTRAL ) * 2.0;
      float hD = ( texture2D( uTrailMap, tUv - vec2( 0.0, texStep ) ).r - TRAIL_NEUTRAL ) * 2.0;
      float hU = ( texture2D( uTrailMap, tUv + vec2( 0.0, texStep ) ).r - TRAIL_NEUTRAL ) * 2.0;
      float worldSpan = 2.0 * texStep * uTrailSize;
      vec2 tGrad = vec2( ( hR - hL ) / worldSpan, ( hU - hD ) / worldSpan );
      float tGradMag = length( tGrad );
      if ( tGradMag > 2.45 ) {
        tGrad *= 2.45 / tGradMag;
      }

      float trailGrazingAA = smoothstep( 0.05, 0.22, abs( dot( n0, V ) ) );
      float effWeight = tWeight * trailAct * ( 1.0 - wetFactor * 0.65 );
      float normWeight = effWeight * trailGrazingAA;

      float pitDepth = clamp( -tHeightC, 0.0, 1.0 );
      float rimLift = clamp( tHeightC, 0.0, 1.0 );

      // Damp wind ripples cleanly inside fresh boot sole / slide chute & carve crisp 3D normal relief
      // (perturbed world normal automatically responds to Canopus sun, twin moons & nocturnal Glowglobe PointLight)
      float rippleSuppress = clamp( ( tComp * 0.88 + pitDepth * 0.35 ) * effWeight, 0.0, 0.94 );
      totalGrad.xz *= ( 1.0 - rippleSuppress );
      totalGrad.xz += tGrad * ( 0.54 * normWeight );

      // Directional sun micro-self-shadowing (dot(tGrad, sunDirW.xz)) gated cleanly by sun elevation
      float trailSunGate = smoothstep( -0.01, 0.09, sunDirW.y ) * ( 1.0 - darkGateM * 0.92 );
      float lowSunRelief = mix( 1.38, 0.62, smoothstep( 0.10, 0.58, sunDirW.y ) );
      float dirSlope = dot( tGrad, sunDirW.xz );
      float slopeShadow = clamp( dirSlope * 0.56 * lowSunRelief, 0.0, 1.0 );
      float slopeSunCatch = clamp( -dirSlope * 0.52 * lowSunRelief, 0.0, 1.0 );

      float rimCastShadow = 0.0;
      float sunHorizLen = length( sunDirW.xz );
      if ( trailSunGate > 0.02 && sunHorizLen > 0.001 ) {
        vec2 sunHorizDir = sunDirW.xz / sunHorizLen;
        vec2 sunTapUv = clamp( tUv + sunHorizDir * ( 2.35 / 512.0 ), vec2( 0.002 ), vec2( 0.998 ) );
        float hSunward = ( texture2D( uTrailMap, sunTapUv ).r - TRAIL_NEUTRAL ) * 2.0;
        rimCastShadow = clamp( ( hSunward - tHeightC - max( sunDirW.y, 0.06 ) * 0.36 ) * 1.45, 0.0, 1.0 );
      }
      float dirSelfShadow = clamp( slopeShadow * 0.72 + rimCastShadow * 0.58, 0.0, 1.0 ) * trailSunGate * trailGrazingAA;

      // Ambient cavity AO inside deep heel/forefoot cups & slide furrows (enhances day, twilight & nocturnal Glowglobe)
      float cavityAO = clamp( pitDepth * 0.30 + tComp * pitDepth * 0.12, 0.0, 0.38 );

      // Sunlit displaced-rim warm mineral catch + looser quartz grain roughness on freshly pushed rims
      float sunlitRim = ( rimLift * 0.56 + slopeSunCatch * 0.64 * ( 0.35 + 0.65 * rimLift ) ) * trailSunGate * trailGrazingAA;
      vec3 rimWarmTint = mix( baseAlbedo * 1.24, mix( sandCrest, uSunColor, 0.28 ), 0.38 );
      baseAlbedo *= clamp( 1.0 - ( cavityAO + dirSelfShadow * 0.36 ) * effWeight, 0.42, 1.0 );
      baseAlbedo = mix( baseAlbedo, rimWarmTint, clamp( sunlitRim * 0.34 * effWeight, 0.0, 0.28 ) );

      terrainRoughness = mix( terrainRoughness, 0.96, clamp( tComp * pitDepth * 0.65 * effWeight, 0.0, 0.60 ) );
      terrainRoughness = mix( terrainRoughness, 0.74, clamp( rimLift * 0.62 * normWeight, 0.0, 0.52 ) );
      trailRimSpark = rimLift * ( 0.36 + 0.64 * slopeSunCatch ) * normWeight;
    }
  }
}

// Compute perturbed world normal via tangent-plane projected gradient
vec3 surfGrad = totalGrad - n0 * dot( totalGrad, n0 );
vec3 arrakisWorldNormal = normalize( n0 - surfGrad );

// 5. Physically Saturated Pore-Water Wet Sand, Shallow Bed & Animated Solar Caustics
if ( wetFactor > 0.005 ) {
  vec3 wetSand = pow( max( baseAlbedo, vec3( 0.001 ) ), vec3( 1.28 ) ) * vec3( 0.60, 0.53, 0.44 );
  float subDepthTerrain = max( 0.0, ${WATER_LEVEL.toFixed(2)} - vWorldPos.y );
  vec3 bedTint = wetSand * exp( -subDepthTerrain * vec3( 0.34, 0.24, 0.26 ) );

  // Dual-layer refracted animated solar caustics dancing on submerged sandy cistern floor!
  if ( subDepthTerrain > 0.015 ) {
    vec2 cUv1 = vWorldPos.xz * 2.35 + wDir * ( uTime * 0.26 );
    vec2 cUv2 = vWorldPos.xz * 3.15 - wPerp * ( uTime * 0.21 ) + vec2( 4.3, -2.9 );
    float nA = abs( vnoise2( cUv1 + vec2( sin( cUv1.y * 1.4 + uTime * 0.9 ) * 0.35, cos( cUv1.x * 1.3 - uTime * 0.8 ) * 0.35 ) ) - 0.5 ) * 2.0;
    float nB = abs( vnoise2( cUv2 + vec2( cos( cUv2.y * 1.6 - uTime * 1.1 ) * 0.30, sin( cUv2.x * 1.5 + uTime * 0.95 ) * 0.30 ) ) - 0.5 ) * 2.0;
    float causticNet = pow( clamp( 1.0 - min( nA, nB ), 0.0, 1.0 ), 4.2 );
    float causticDepthMask = smoothstep( 0.015, 0.14, subDepthTerrain ) * exp( -subDepthTerrain * 1.4 );
    float causticSun = smoothstep( 0.02, 0.24, normalize( uSunDir ).y ) * ( 1.0 - darkGateM ) * clamp( uSunIntensity / 2.6, 0.0, 1.2 );
    bedTint += uSunColor * vec3( 1.05, 0.94, 0.72 ) * causticNet * causticDepthMask * causticSun * 0.48;
  }

  vec3 wetAlbedo = mix( wetSand, bedTint, smoothstep( 0.0, 0.05, subDepthTerrain ) );
  baseAlbedo = mix( baseAlbedo, wetAlbedo, wetFactor * 0.92 );

  float wetRough = mix( 0.34, 0.70, smoothstep( 0.0, 0.08, subDepthTerrain ) );
  terrainRoughness = mix( terrainRoughness, wetRough, wetFactor * ( 1.0 - rockFactor * 0.4 ) );
}

// 6. Mélange Spice Veins, Noon Inferior Heat-Mirage & Distant 3D Dune Sculpting
vec3 arrakisEmissive = vec3( 0.0 );
vec3 halfVec = normalize( sunDirW + V );
float sunUp = smoothstep( -0.01, 0.16, sunDirW.y );
float sunDayGate = smoothstep( 0.05, 0.15, sunUp );
float sunStrength = clamp( uSunIntensity / 2.6, 0.0, 1.2 );
float dryMargin = 1.0 - smoothstep( 0.01, 0.15, wetFactor );

// Distant 3D windward sunlit vs shadowed leeward relief (100-420m)
float farFaceSun = dot( arrakisWorldNormal, sunDirW );
float farLitWindward = smoothstep( -0.04, 0.42, farFaceSun );
float farLeeShadow = smoothstep( 0.08, -0.36, farFaceSun );
float farSculpt = smoothstep( 95.0, 210.0, viewDist ) * sandMask;
baseAlbedo *= mix( 1.0, 1.22, farLitWindward * farSculpt * ( 1.0 - darkGateM ) );
baseAlbedo *= mix( 1.0, 0.64, farLeeShadow * farSculpt * mix( 1.0, 0.45, darkGateM ) );

// Cool silver-indigo coronal umbra during eclipse totality (no warm brick-red hotspot!)
float eclipseUmbra = clamp( uEclipse, 0.0, 1.0 );
if ( eclipseUmbra > 0.005 ) {
  float fgUmbraMask = 1.0 - smoothstep( 65.0, 210.0, viewDist );
  float umbraWeight = eclipseUmbra * ( 0.55 + 0.45 * fgUmbraMask );
  baseAlbedo *= mix( vec3( 1.0 ), vec3( 0.44, 0.48, 0.66 ), umbraWeight );
}

// Noon Inferior Desert Heat-Mirage: shimmering inverted sky-glint sheet across hot grazing sand flats!
if ( uMirage > 0.12 && darkGateM < 0.25 ) {
  float distMirage = smoothstep( 24.0, 62.0, viewDist ) * ( 1.0 - smoothstep( 165.0, 280.0, viewDist ) );
  float flatGround = smoothstep( 0.78, 0.96, n0.y ) * ( 1.0 - wetFactor ) * ( 1.0 - rockFactor * 0.85 );
  float grazingRay = 1.0 - smoothstep( 0.025, 0.145, abs( V.y ) );
  float heatWave = 0.55 + 0.45 * sin( vWorldPos.x * 0.65 + vWorldPos.z * 0.45 - uTime * 5.2 + fbm2( vWorldPos.xz * 0.18 ) * 4.5 );
  float mirageSheet = clamp( distMirage * flatGround * grazingRay * heatWave * uMirage * 0.92, 0.0, 0.78 );
  if ( mirageSheet > 0.005 ) {
    vec3 invertedSkyCol = mix( uHorizonColor * 1.06, mix( vec3( 0.52, 0.76, 1.0 ), uZenithColor * 1.45, 0.55 ), 0.62 );
    baseAlbedo = mix( baseAlbedo, invertedSkyCol, mirageSheet * 0.68 );
    arrakisEmissive += invertedSkyCol * mirageSheet * 0.28;
    terrainRoughness = mix( terrainRoughness, 0.18, mirageSheet * 0.75 );
  }
}

// Mélange spice fallout concentrated around Spice Blow crater & leeward troughs (zero closed-loop contour rings or floor() grid!)
float spiceCraterProx = exp( -pow( length( vWorldPos.xz - uSpiceOrigin.xz ) / 28.0, 2.0 ) );
float spicePresence = ( vSpice * 0.42 + uSpiceBlow * spiceCraterProx * 0.95 ) * ( 1.0 - rockFactor ) * dryMargin;
if ( spicePresence > 0.02 ) {
  vec2 spStream = vec2( uAlong * 0.16, uCross * 0.68 );
  vec2 spWarp = vec2( fbm2( spStream * 0.55 + vec2( 3.1, 7.2 ) ), fbm2( spStream * 0.55 + vec2( 11.4, 2.9 ) ) );
  float driftVein = fbm2( spStream * 1.65 + spWarp * 0.85 - wDir * ( uTime * 0.04 * uSpiceBlow ) );
  float fineStreak = fbm2( vec2( uAlong * 0.42, uCross * 2.1 ) + spWarp * 0.45 );
  float rippleTroughSettle = mix( 0.65, 1.0, clamp( 0.55 - ripVal * 0.45, 0.0, 1.0 ) );
  float veinMask = smoothstep( 0.38, 0.78, driftVein * 0.68 + fineStreak * 0.32 ) * smoothstep( 0.02, 0.52, spicePresence ) * rippleTroughSettle;

  vec3 spiceCinnamon = vec3( 0.52, 0.19, 0.068 );
  vec3 spiceSaffron  = vec3( 0.74, 0.32, 0.105 );
  vec3 spiceCol = mix( spiceCinnamon, spiceSaffron, smoothstep( 0.35, 0.80, fineStreak ) );

  baseAlbedo = mix( baseAlbedo, spiceCol, veinMask * mix( 0.38, 0.76, spiceCraterProx * uSpiceBlow ) );
  terrainRoughness = mix( terrainRoughness, 0.86, veinMask * 0.40 );

  float crystalFade = smoothstep( 0.055, 0.010, pxSize ) * ( 1.0 - smoothstep( 12.0, 42.0, viewDist ) ) * spiceCraterProx;
  if ( crystalFade > 0.01 && uSpiceBlow > 0.05 ) {
    float spk1 = vnoise2( gmUv * 64.0 + vec2( 4.1, -2.7 ) );
    float spk2 = vnoise2( gmUv.yx * 98.0 - vec2( 3.3, 6.2 ) );
    float isCrystal = pow( clamp( spk1 * spk2 * 1.52, 0.0, 1.0 ), 8.0 );
    float shimmer = 0.65 + 0.35 * sin( uTime * 3.5 + spk1 * 24.0 );
    arrakisEmissive += vec3( 0.18, 0.68, 1.15 ) * isCrystal * crystalFade * shimmer * uSpiceBlow * 0.55;
  }
}

// Subtle drifting crest saltation mist sheen across sunlit barchan crests during uSaltation/windSpeed surges (zero at night/twilight)
float ndotv = clamp( dot( arrakisWorldNormal, V ), 0.0, 1.0 );
float rimGrazing = pow( 1.0 - ndotv, 2.8 );
float forwardScatter = pow( max( dot( V, -sunDirW ), 0.0 ), 2.2 );
float sunFace = smoothstep( -0.06, 0.34, dot( arrakisWorldNormal, sunDirW ) );
float saltSurge = clamp( max( uSaltation, smoothstep( 0.45, 1.15, uWindSpeed ) ), 0.0, 1.25 );
float windLift = 0.18 + 0.82 * saltSurge;
vec2 saltUv = vec2( uAlong * 0.15 - uTime * ( 0.75 + uWindSpeed * 0.85 ), uCross * 0.48 );
float saltStream = fbm2( saltUv ) * 0.65 + vnoise2( saltUv * 2.35 + vec2( 3.1, -5.7 ) ) * 0.35;
float saltWisp = smoothstep( 0.30, 0.84, saltStream );
float ergCrestMask = smoothstep( -18.0, -42.0, vWorldPos.z );
float crestBand = smoothstep( 0.46, 0.94, vCrest ) * ( 1.0 - smoothstep( 0.20, 0.54, vSlip ) ) * ergCrestMask;
float saltDistMask = smoothstep( 12.0, 26.0, viewDist ) * ( 1.0 - smoothstep( 150.0, 310.0, viewDist ) );
float saltationGlow = ( rimGrazing * 0.68 + 0.32 ) * ( 0.25 + 0.75 * forwardScatter ) * sunFace * sandMask * dryMargin * crestBand * sunUp * sunDayGate * ( 1.0 - darkGateM ) * sunStrength * windLift * ( 0.35 + 0.65 * saltWisp ) * saltDistMask;
vec3 saltMistCol = mix( uSunColor, vec3( 1.0, 0.74, 0.40 ), 0.42 );
baseAlbedo = mix( baseAlbedo, saltMistCol * 0.92, clamp( saltationGlow * 0.18, 0.0, 0.22 ) );
arrakisEmissive += saltMistCol * saltationGlow * 0.16;

// Subsurface warm fiery translucency along backlit razor barchan dune crests!
float crestBacklit = pow( max( dot( V, -sunDirW ), 0.0 ), 3.4 ) * pow( 1.0 - ndotv, 2.2 )
                   * smoothstep( 0.56, 0.95, vCrest ) * sandMask * dryMargin * sunUp * ( 1.0 - darkGateM ) * sunStrength;
arrakisEmissive += mix( uSunColor, vec3( 1.0, 0.58, 0.20 ), 0.48 ) * crestBacklit * 0.26;

// View-dependent stochastic warm golden quartz micro-facet glints dancing on sunlit foreground sand!
float viewSparkle = pow( max( dot( arrakisWorldNormal, halfVec ), 0.0 ), 5.0 )
                  * pow( clamp( vnoise2( gmUv * 96.0 + V.xz * 2.8 ) * vnoise2( gmUv.yx * 134.0 - V.xz * 2.1 ) * 1.48, 0.0, 1.0 ), 13.5 )
                  * sparkFade * sunUp * sunDayGate * ( 1.0 - darkGateM ) * sandMask * dryMargin;
float rimQuartzGlint = trailRimSpark * ( 0.45 + 0.55 * sp1 )
                     * smoothstep( 0.12, 0.014, pxSize ) * ( 1.0 - smoothstep( 8.0, 28.0, viewDist ) )
                     * ( 1.0 - darkGateM ) * sandMask * dryMargin;
arrakisEmissive += mix( uSunColor, vec3( 1.0, 0.78, 0.44 ), 0.45 )
                 * ( ( quartzSparkle * 0.038 + viewSparkle * 0.34 + rimQuartzGlint * 0.062 ) * sunUp * sunDayGate * sunStrength );

// Strictly clamp all emissive/glint terms to 0 on capillary wet margins
arrakisEmissive *= dryMargin;

diffuseColor.rgb = baseAlbedo;
`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = terrainRoughness;
`
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
#include <normal_fragment_maps>
normal = transformDirection( arrakisWorldNormal, viewMatrix );
`
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += arrakisEmissive;
`
      )
      .replace(
        '#include <lights_physical_fragment>',
        /* glsl */ `
#include <lights_physical_fragment>
float arrakisSpecIntensity = mix( 0.034, 0.052, clamp( wetFactor * 0.35 + rockFactor * 0.45, 0.0, 1.0 ) );
arrakisSpecIntensity = mix( arrakisSpecIntensity, 0.105, clamp( trailRimSpark * 0.85, 0.0, 0.65 ) * dryMargin );
arrakisSpecIntensity = mix( arrakisSpecIntensity, 0.13, quartzSparkle * dryMargin );
#ifdef IOR
  #ifdef USE_SPECULAR
    specularIntensityFactor = arrakisSpecIntensity;
    material.specularF90 = mix( specularIntensityFactor, 1.0, metalnessFactor );
    material.specularColor = min( pow2( ( material.ior - 1.0 ) / ( material.ior + 1.0 ) ) * specularColorFactor, vec3( 1.0 ) ) * specularIntensityFactor;
    material.specularColorBlended = mix( material.specularColor, diffuseColor.rgb, metalnessFactor );
  #endif
#endif
#ifdef USE_DIFFUSE_ROUGHNESS
  material.diffuseRoughness = mix( 0.82, 0.74, wetFactor );
#endif
`
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
#if defined( RE_IndirectDiffuse )
  vec3 sunDirFill = normalize( uSunDir );
  float zenithLumaFill = dot( uZenithColor, vec3( 0.2126, 0.7152, 0.0722 ) );
  float nightFillGate = 1.0 - smoothstep( -0.02, 0.14, sunDirFill.y );
  float eclipseFillGate = max( uEclipse, ( 1.0 - smoothstep( 0.045, 0.14, zenithLumaFill ) ) * smoothstep( -0.04, 0.12, sunDirFill.y ) * ( 1.0 - smoothstep( 2.0, 2.7, uSunIntensity ) ) );
  float darkFillGate = clamp( max( nightFillGate, eclipseFillGate * 0.92 ), 0.0, 1.0 );

  if ( darkFillGate > 0.005 ) {
    float skyCatch = clamp( arrakisWorldNormal.y * 0.72 + 0.08, 0.0, 1.0 );
    float slopeContour = clamp( 0.55 + 0.45 * arrakisWorldNormal.y, 0.35, 1.0 );
    float deepNight = 1.0 - smoothstep( -0.14, 0.02, sunDirFill.y );
    vec3 moonSkyFill = mix( vec3( 0.17, 0.22, 0.42 ), uHorizonColor * 0.85 + vec3( 0.10, 0.13, 0.26 ), 0.30 * ( 1.0 - deepNight * 0.55 ) );
    vec3 nightDuneFill = vec3( 0.13, 0.16, 0.29 );
    vec3 twiDuneFill = vec3( 0.16, 0.13, 0.21 );
    vec3 duneBounceFill = mix( nightDuneFill, twiDuneFill, clamp( eclipseFillGate + ( 1.0 - deepNight ) * 0.65, 0.0, 1.0 ) );
    vec3 nocturnalBounce = mix( duneBounceFill, moonSkyFill, skyCatch );
    float crestFillAtten = 1.0 - smoothstep( 0.35, 0.90, vCrest ) * 0.34;
    float eclipseBounceScale = mix( 1.0, mix( 0.52, 0.34, 1.0 - smoothstep( 65.0, 210.0, viewDist ) ), clamp( uEclipse, 0.0, 1.0 ) );
    irradiance += nocturnalBounce * ( 0.72 * darkFillGate * crestFillAtten * slopeContour * eclipseBounceScale );
  }
#endif
#include <lights_fragment_end>
#if defined( RE_IndirectDiffuse )
  if ( darkFillGate > 0.005 ) {
    float shadowPocket = clamp( 1.0 - smoothstep( 0.30, 0.92, arrakisWorldNormal.y ), 0.18, 1.0 );
    float contourLift = clamp( 0.45 + 0.55 * arrakisWorldNormal.y, 0.25, 1.0 );
    float rippleRelief = 1.0 + rippleShade * 0.45;
    vec3 indigoSkyAmbient = vec3( 0.020, 0.026, 0.052 ) * contourLift * rippleRelief * shadowPocket * ( 1.0 - smoothstep( 0.50, 0.92, vCrest ) * 0.55 );
    reflectedLight.indirectDiffuse += indigoSkyAmbient * darkFillGate * mix( 1.0, 0.65, clamp( uEclipse, 0.0, 1.0 ) );
  }
#endif
`
      )
      .replace(
        '#include <fog_fragment>',
        /* glsl */ `
#ifdef USE_FOG
  vec3 viewRay = -V;
  float viewUp = clamp( viewRay.y, 0.0, 1.0 );
  float sunUpH = smoothstep( -0.05, 0.16, sunDirW.y );
  float noonWarmH = smoothstep( 0.16, 0.48, sunDirW.y );
  float horizonLuma = dot( uHorizonColor, vec3( 0.2126, 0.7152, 0.0722 ) );
  float zenithLuma = dot( uZenithColor, vec3( 0.2126, 0.7152, 0.0722 ) );
  float brightDayGate = smoothstep( 0.34, 0.64, horizonLuma ) * smoothstep( 0.045, 0.14, zenithLuma ) * smoothstep( 2.0, 2.7, uSunIntensity ) * sunUpH;
  float nightHazeGate = 1.0 - smoothstep( -0.02, 0.14, sunDirW.y );
  float eclipseHazeGate = max( uEclipse, ( 1.0 - smoothstep( 0.045, 0.14, zenithLuma ) ) * smoothstep( -0.04, 0.12, sunDirW.y ) * ( 1.0 - smoothstep( 2.0, 2.7, uSunIntensity ) ) );
  float darkHorizonGate = clamp( max( nightHazeGate, eclipseHazeGate ), 0.0, 1.0 );

  float fogDens = max( uFogDensity, 0.0025 );
  float distFactor = 1.0 - exp( -pow( viewDist * fogDens, 1.35 ) );
  float stormFogLift = smoothstep( 0.006, 0.013, uFogDensity );
  float baseMist = clamp( distFactor * mix( 0.52, 0.92, stormFogLift ), 0.0, mix( 0.52, 0.88, stormFogLift ) );
  float heightFog = exp( -max( 0.0, vWorldPos.y - 1.5 ) * 0.115 ) * smoothstep( 36.0, 155.0, viewDist ) * 0.32;
  float farDistHaze = smoothstep( 115.0, 360.0, viewDist );
  float farHorizonFade = smoothstep( 290.0, 480.0, viewDist ) * 0.42;

  float mieScatter = pow( max( dot( viewRay, sunDirW ), 0.0 ), 3.6 );
  float antiSunCool = 1.0 - max( dot( viewRay, sunDirW ), 0.0 );
  float sunStrH = clamp( uSunIntensity / 2.6, 0.08, 1.25 );
  float sunHorizonMask = smoothstep( 115.0, 320.0, viewDist ) * sunUpH * ( 1.0 - eclipseHazeGate * 0.98 );
  float mieVeil = mieScatter * 0.46 * sunHorizonMask * mix( 1.0, 0.28, noonWarmH );

  float maxMistCap = mix( 0.66, 0.92, stormFogLift ) * ( 1.0 - eclipseHazeGate * 0.10 );
  float mistFactor = clamp( baseMist + ( 1.0 - baseMist ) * heightFog, 0.0, maxMistCap );
  mistFactor = clamp( mistFactor + ( 1.0 - mistFactor ) * ( farDistHaze * mix( 0.28, 0.42, darkHorizonGate ) ), 0.0, maxMistCap );
  mistFactor = clamp( mistFactor + ( 1.0 - mistFactor ) * farHorizonFade, 0.0, maxMistCap );
  mistFactor = clamp( mistFactor + ( 1.0 - mistFactor ) * mieVeil, 0.0, mix( 0.68, 0.94, stormFogLift ) );

  // Preserve sunlit windward vs shadowed leeward slipface 3D depth right through distant aerial haze (115m+)
  mistFactor *= mix( 1.0, 0.78, farLitWindward * farDistHaze * ( 1.0 - stormFogLift ) );
  mistFactor *= mix( 1.0, 0.84, farLeeShadow * farDistHaze * ( 1.0 - stormFogLift ) );

  vec3 horizonBase = mix( uHorizonColor, fogColor, 0.24 );
  horizonBase = mix( horizonBase, max( horizonBase, vec3( 0.94, 0.76, 0.51 ) ), noonWarmH * 0.42 * brightDayGate );

  vec3 saffronHaze = mix( uHorizonColor, vec3( 0.96, 0.68, 0.38 ), 0.44 ) * ( 0.88 + 0.34 * mieScatter );
  vec3 dustScat = mix( horizonBase, uZenithColor, 0.05 + 0.12 * viewUp + 0.05 * antiSunCool * ( 1.0 - sunUpH * 0.40 ) );
  dustScat = mix( dustScat, saffronHaze, clamp( heightFog * 0.85 + farDistHaze * 0.30, 0.0, 0.55 ) * sunUpH * smoothstep( 0.22, 0.55, horizonLuma ) * ( 1.0 - eclipseHazeGate * 0.96 ) );

  // Deep slate-indigo twilight / warm-rimmed eclipse aerial horizon scatter matching darkened sky
  vec3 nightIndigoHaze = mix( uHorizonColor * 0.90 + vec3( 0.030, 0.026, 0.064 ), vec3( 0.105, 0.088, 0.185 ), 0.42 );
  vec3 eclipseIndigoHaze = mix( uZenithColor * vec3( 0.88, 0.74, 1.12 ) + vec3( 0.015, 0.012, 0.028 ), uHorizonColor * vec3( 0.85, 0.52, 0.44 ), 0.40 );
  vec3 twilightAerialCol = mix( nightIndigoHaze, eclipseIndigoHaze, eclipseHazeGate );
  float darkMixAmt = darkHorizonGate * ( mix( 0.58, 0.94, eclipseHazeGate ) + mix( 0.42, 0.06, eclipseHazeGate ) * farDistHaze );
  dustScat = mix( dustScat, twilightAerialCol, darkMixAmt );

  vec3 mieTint = mix( uSunColor, vec3( 1.0, 0.82, 0.52 ), 0.32 );
  float mieGlowGain = ( 0.18 + 0.44 * farDistHaze * mix( 1.0, 0.22, noonWarmH ) ) * sunUpH * sunStrH * ( 1.0 - eclipseHazeGate * 0.98 ) * smoothstep( 0.04, 0.14, zenithLuma + horizonLuma * 0.25 );
  vec3 mistColor = mix( dustScat, saffronHaze, clamp( mieVeil * 0.72, 0.0, 0.65 ) ) + mieTint * ( mieScatter * mieGlowGain );
  mistColor += mix( uSunColor, vec3( 1.0, 0.82, 0.54 ), 0.40 ) * ( 0.11 * farLitWindward * farDistHaze * sunUpH * ( 1.0 - darkHorizonGate ) );
  mistColor = mix( mistColor, mistColor * vec3( 0.68, 0.70, 0.84 ), farLeeShadow * farDistHaze * 0.48 * ( 1.0 - stormFogLift ) );

  gl_FragColor.rgb = mix( gl_FragColor.rgb, mistColor, mistFactor );
#endif
`
      );
  };

  return material;
}

function createWaterGeometry(terrainGeo) {
  const geo = new THREE.PlaneGeometry(WATER_WIDTH, WATER_HEIGHT, WATER_SEGS_X, WATER_SEGS_Z);
  const pos = geo.attributes.position;
  const count = pos.count;
  const depthArr = new Float32Array(count);

  // Reflector mesh is rotated -PI/2 around X and centered at (CISTERN_CENTER.x, WATER_LEVEL, CISTERN_CENTER.z),
  // which maps local (x, y, 0) -> world (x + cx, WATER_LEVEL, cz - y).
  // Sample the exact triangulated terrain mesh surface inside the basin so vWaterDepth == 0 aligns sub-millimeter with Z-buffer intersection.
  for (let i = 0; i < count; i++) {
    const wx = pos.getX(i) + CISTERN_CENTER.x;
    const wz = CISTERN_CENTER.z - pos.getY(i);
    const radial = Math.hypot(wx - CISTERN_CENTER.x, wz - CISTERN_CENTER.z);
    if (radial < 9.8) {
      const info = getTerrainInfo(wx, wz);
      const meshY = terrainGeo ? sampleTerrainMeshHeight(terrainGeo, wx, wz) : info.height;
      depthArr[i] = info.cisternBowl > 0.005 ? WATER_LEVEL - meshY : -0.6;
    } else {
      depthArr[i] = -0.6;
    }
  }

  geo.setAttribute('aWaterDepth', new THREE.BufferAttribute(depthArr, 1));
  return geo;
}

function createDewCisternReflector(worldState, terrainGeo) {
  const waterGeo = createWaterGeometry(terrainGeo);

  const customWaterShader = {
    name: 'ArrakisCisternReflector',
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        color: { value: null },
        tDiffuse: { value: null },
        textureMatrix: { value: null },
        uTime: { value: 0 },
        uWindDir: { value: new THREE.Vector2(1, 0) },
        uWindSpeed: { value: 0.45 },
        uSunDir: { value: new THREE.Vector3(0.2, 0.25, -0.94) },
        uSunColor: { value: new THREE.Color(0xffcfa0) },
        uSunIntensity: { value: 3.0 },
        uSkyColor: { value: new THREE.Color(0xe6ab7a) },
        uZenithColor: { value: new THREE.Color(0x4b6088) },
        uThumperPos: { value: new THREE.Vector3(8.5, 0, -14.5) },
        uThumperPulse: { value: 0 },
        uRipples: {
          value: Array.from({ length: 16 }, () => new THREE.Vector4(0, 0, -999, 0))
        }
      }
    ]),
    vertexShader: /* glsl */ `
uniform mat4 textureMatrix;
attribute float aWaterDepth;

varying vec4 vUv;
varying vec3 vWorldPos;
varying float vWaterDepth;

#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>

void main() {
  vWaterDepth = aWaterDepth;
  vUv = textureMatrix * vec4( position, 1.0 );

  vec4 worldPos = modelMatrix * vec4( position, 1.0 );
  vWorldPos = worldPos.xyz;

  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;

  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`,
    fragmentShader: /* glsl */ `
uniform vec3 color;
uniform sampler2D tDiffuse;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindSpeed;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uSkyColor;
uniform vec3 uZenithColor;
uniform vec3 uThumperPos;
uniform float uThumperPulse;
uniform vec4 uRipples[16];

varying vec4 vUv;
varying vec3 vWorldPos;
varying float vWaterDepth;

#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
${NOISE_GLSL}

void main() {
  #include <logdepthbuf_fragment>

  // Compute screen-space derivatives BEFORE discard so quad derivatives remain valid
  float depthAA = max( fwidth( vWaterDepth ), 0.004 );
  vec2 dpx = dFdx( vWorldPos.xz );
  vec2 dpy = dFdy( vWorldPos.xz );
  float pxFoot = max( length( dpx ), length( dpy ) );

  // Physically smooth sub-pixel antialiased shallow depth fade (alpha -> 0 cleanly before waterDepth -> 0)
  float shoreFade = smoothstep( 0.0, 0.085, vWaterDepth ) * smoothstep( 0.0, depthAA * 1.4, max( vWaterDepth - 0.003, 0.0 ) );
  if ( shoreFade <= 0.0005 ) discard;

  vec2 p = vWorldPos.xz;
  vec2 wDir = length( uWindDir ) > 0.0001 ? normalize( uWindDir ) : vec2( 1.0, 0.0 );
  vec2 wPerp = vec2( -wDir.y, wDir.x );

  // Smooth calm & distortion damping near shallow shore and grazing footprints (prevents bank-edge stipple)
  float shoreCalm = smoothstep( 0.012, 0.095, vWaterDepth );
  float uvDamp = smoothstep( 0.025, 0.22, vWaterDepth ) * smoothstep( 0.36, 0.045, pxFoot );

  // Gentle curl advection so reflections distort organically without mushy smears
  vec2 curlUv = p * 0.85 + wDir * ( uTime * 0.08 );
  float fC = fbm2( curlUv );
  float fX = fbm2( curlUv + vec2( 0.08, 0.0 ) );
  float fZ = fbm2( curlUv + vec2( 0.0, 0.08 ) );
  vec2 curlFlow = clamp( vec2( fZ - fC, -( fX - fC ) ) / 0.08, vec2( -1.0 ), vec2( 1.0 ) );
  vec2 wp = p + curlFlow * 0.012;

  // Nyquist-filtered capillary wavelets across the cistern pool (0.14..0.44m wavelengths, zero grazing stipple)
  vec2 d1 = vec2( wDir.x * 0.996 - wDir.y * 0.087, wDir.y * 0.996 + wDir.x * 0.087 );
  vec2 d2 = vec2( wDir.x * 0.766 - wDir.y * 0.643, wDir.y * 0.766 + wDir.x * 0.643 );
  vec2 d3 = vec2( wDir.x * 0.819 + wDir.y * 0.574, wDir.y * 0.819 - wDir.x * 0.574 );
  vec2 d4 = vec2( -wDir.x * 0.500 - wDir.y * 0.866, -wDir.y * 0.500 + wDir.x * 0.866 );

  float j1 = vnoise2( wp * 1.45 + vec2( 1.4, -2.3 ) ) * 1.5;
  float j2 = vnoise2( wp * 2.10 + vec2( -5.1, 3.8 ) ) * 1.4;
  float j3 = vnoise2( wp * 2.75 + vec2( 7.2, 6.4 ) ) * 1.3;
  float j4 = vnoise2( wp * 3.40 + vec2( -3.6, -8.1 ) ) * 1.2;

  float ph1 = dot( wp, d1 ) * 14.3 - uTime * ( 2.25 + uWindSpeed * 1.10 ) + j1;
  float ph2 = dot( wp, d2 ) * 19.0 - uTime * ( 2.75 + uWindSpeed * 0.95 ) + j2;
  float ph3 = dot( wp, d3 ) * 25.1 + uTime * ( 3.15 + uWindSpeed * 0.85 ) + j3;
  float ph4 = dot( wp, d4 ) * 34.0 - uTime * ( 3.65 + uWindSpeed * 1.00 ) + j4;

  float aa1 = smoothstep( 0.38, 0.045, pxFoot );
  float aa2 = smoothstep( 0.26, 0.035, pxFoot );
  float aa3 = smoothstep( 0.18, 0.028, pxFoot );
  float aa4 = smoothstep( 0.13, 0.022, pxFoot );

  vec2 gradWave = d1 * ( cos( ph1 ) * 0.30 * aa1 )
                + d2 * ( cos( ph2 ) * 0.28 * aa2 )
                + d3 * ( cos( ph3 ) * 0.24 * aa3 )
                + d4 * ( cos( ph4 ) * 0.18 * aa4 );

  // Fine wind-aligned capillary FBM shimmer (~0.18..0.32m scale), Nyquist-attenuated at grazing angles
  if ( aa3 > 0.01 ) {
    float uAlong = dot( wp, wDir );
    float uCross = dot( wp, wPerp );
    float nC = fbm2( vec2( uAlong * 4.8 - uTime * 1.05, uCross * 5.6 + uTime * 0.38 ) );
    float nX = fbm2( vec2( ( uAlong + 0.04 ) * 4.8 - uTime * 1.05, uCross * 5.6 + uTime * 0.38 ) );
    float nZ = fbm2( vec2( uAlong * 4.8 - uTime * 1.05, ( uCross + 0.04 ) * 5.6 + uTime * 0.38 ) );
    gradWave += clamp( ( wDir * ( nX - nC ) + wPerp * ( nZ - nC ) ) * 12.5, vec2( -0.45 ), vec2( 0.45 ) ) * aa3;
  }

  // Lively capillary ripple amplitude attenuated smoothly at low grazing angles & nocturnal calm (zero TV-static stipple!)
  vec3 viewDelta = cameraPosition - vWorldPos;
  float fgViewDist = length( viewDelta );
  vec3 V = viewDelta / max( fgViewDist, 0.0001 );
  float grazingCalm = smoothstep( 0.08, 0.36, V.y );
  float nightCalm = mix( 1.0, 0.38, 1.0 - smoothstep( -0.06, 0.10, uSunDir.y ) );
  float capAmp = ( 0.022 + 0.012 * clamp( uWindSpeed, 0.0, 1.25 ) ) * shoreCalm * grazingCalm * nightCalm;
  vec2 rippleXZ = gradWave * capAmp;

  // Subtle concentric spring / dew-drip rings & thumper shockwave shimmer
  vec2 cDelta = p - vec2( ${CISTERN_CENTER.x.toFixed(2)}, ${CISTERN_CENTER.z.toFixed(2)} );
  float cDist = length( cDelta );
  if ( cDist > 0.01 ) {
    float cRing = cos( cDist * 8.5 - uTime * 2.8 ) * exp( -cDist * 0.48 ) * 0.0035 * shoreCalm * grazingCalm * aa2;
    rippleXZ += ( cDelta / cDist ) * cRing;
  }
  if ( uThumperPulse > 0.005 ) {
    vec2 tDelta = p - uThumperPos.xz;
    float tDist = length( tDelta );
    vec2 tDir = tDelta / max( tDist, 0.001 );
    float tRing = cos( tDist * 5.4 - uTime * 20.0 ) * exp( -tDist * 0.065 ) * uThumperPulse * 0.048 * shoreCalm * aa1;
    rippleXZ += tDir * tRing;
  }

  // Interactive 16-slot expanding circular water wake ripples (wading footsteps, drinking & tamarisk dew drips!)
  float interactiveFoam = 0.0;
  for ( int ri = 0; ri < 16; ri++ ) {
    vec4 rp = uRipples[ri];
    float age = uTime - rp.z;
    if ( age > 0.0 && age < 4.2 && rp.w > 0.005 ) {
      vec2 rDelta = p - rp.xy;
      float rDist = length( rDelta );
      float frontR = age * 1.65;
      float ringDelta = rDist - frontR;
      float env = exp( -ringDelta * ringDelta * 5.2 ) * exp( -age * 0.85 ) * smoothstep( 0.0, 0.08, rDist );
      if ( env > 0.001 ) {
        vec2 rDir = rDelta / max( rDist, 0.001 );
        float waveSlope = cos( ringDelta * 14.5 ) * env * rp.w * 0.092 * shoreCalm * aa1;
        rippleXZ += rDir * waveSlope;
        interactiveFoam += max( sin( ringDelta * 14.5 ), 0.0 ) * env * rp.w * 0.14;
      }
    }
  }

  vec3 N = normalize( vec3( -rippleXZ.x * 1.35, 1.0, -rippleXZ.y * 1.35 ) );
  float NdotV = clamp( dot( N, V ), 0.05, 1.0 );

  // Perspective-correct reflection lookup with damped shallow-shore distortion so bank silhouette never stipples
  vec2 projUv = vUv.xy / max( vUv.w, 0.0001 );
  vec2 uvDistort = vec2( rippleXZ.x * 0.40, rippleXZ.y * 0.28 ) * uvDamp * grazingCalm;
  vec2 sampleUv = clamp( projUv + uvDistort, vec2( 0.002 ), vec2( 0.998 ) );
  float noonSun = smoothstep( 0.22, 0.60, uSunDir.y );
  float sunVis = smoothstep( -0.05, 0.25, uSunDir.y );

  vec3 R = reflect( -V, N );
  R.y = max( R.y, 0.02 );
  vec3 skyFallback = mix( uSkyColor, uZenithColor, smoothstep( 0.02, 0.44, R.y ) );
  vec3 skyScatterFloor = max( skyFallback * 0.14, vec3( 0.008, 0.012, 0.024 ) );

  vec3 reflColor = texture2D( tDiffuse, sampleUv ).rgb;
  vec3 reflCenter = texture2D( tDiffuse, clamp( projUv, vec2( 0.002 ), vec2( 0.998 ) ) ).rgb;

  // Preserve rich dark reflected silhouettes of overhanging Tamarisk fronds, reeds & Windtrap at dawn/night!
  float rawReflLuma = dot( reflColor, vec3( 0.2126, 0.7152, 0.0722 ) );
  float nearBlackFill = 1.0 - smoothstep( 0.008, 0.045, rawReflLuma );
  reflColor = mix( reflColor, max( reflCenter, skyScatterFloor ), nearBlackFill * mix( 0.18, 0.55, noonSun ) );

  // Soft highlight compression preserves luminous dawn peach/lavender sky & crisp noon azure without mercury blowout
  float reflLuma = dot( reflColor, vec3( 0.2126, 0.7152, 0.0722 ) );
  float reflKnee = mix( 0.56, 0.62, noonSun );
  float reflCap = mix( 1.32, 1.18, noonSun );
  if ( reflLuma > reflKnee ) {
    float over = reflLuma - reflKnee;
    float head = max( reflCap - reflKnee, 0.01 );
    float compressed = reflKnee + head * ( over / ( over + head ) );
    reflColor *= compressed / max( reflLuma, 0.0001 );
  }

  // True physical Schlick Fresnel (F0 = 0.02, standard 5th power) with nocturnal mirror boost for Twin-Moon reflections
  float nightMirror = 1.0 - smoothstep( -0.06, 0.12, uSunDir.y );
  float fresnel = 0.025 + 0.975 * pow( 1.0 - NdotV, 4.6 );
  float shallowFresnelGate = smoothstep( 0.018, 0.16, vWaterDepth );
  float effFresnel = clamp( fresnel * shallowFresnelGate * mix( 1.0, 1.18, nightMirror ), 0.0, mix( 0.76, 0.88, nightMirror ) );

  // Beer-Lambert shallow clarity: reveals rippled golden-amber sandy bed along front rim & transitions to mineral oasis depth
  float depthClamped = max( vWaterDepth, 0.0 );
  float transmittance = exp( -depthClamped * 1.12 );

  vec3 scatterTint = mix( vec3( 0.032, 0.068, 0.088 ), vec3( 0.022, 0.074, 0.098 ), noonSun );
  vec3 waterSkyAmbient = mix( uSkyColor, uZenithColor, 0.36 ) * 0.46 + uSunColor * ( 0.34 * sunVis * clamp( uSunIntensity / 3.0, 0.08, 1.15 ) );
  vec3 deepWaterScatter = scatterTint * max( waterSkyAmbient, vec3( 0.10, 0.13, 0.20 ) * ( 0.5 + 0.8 * nightMirror ) );
  vec3 shallowAmberGlow = vec3( 0.24, 0.15, 0.06 ) * sunVis * clamp( uSunIntensity / 2.8, 0.08, 1.15 ) * ( 1.0 - smoothstep( 0.03, 0.36, depthClamped ) ) * 0.48;

  float skyFacetShade = 0.95 + 0.10 * clamp( 1.0 - R.y * 1.4, 0.0, 1.0 );
  vec3 tintedRefl = reflColor * skyFacetShade * mix( 1.0, 1.08, nightMirror );

  // Physical radiometric transfer over framebuffer bed
  float keepBed = ( 1.0 - effFresnel ) * transmittance;
  float alphaPhys = clamp( 1.0 - keepBed, 0.0, 0.95 );
  vec3 waterContrib = ( 1.0 - effFresnel ) * ( 1.0 - transmittance ) * ( deepWaterScatter + shallowAmberGlow ) + effFresnel * tintedRefl;

  // Liquid-silk solar & nocturnal twin-moon capillary sparkles (zero noisy stipple dots at noon)
  vec3 L = normalize( uSunDir );
  vec3 Nglint = normalize( vec3( -rippleXZ.x * 1.65, 1.0, -rippleXZ.y * 1.65 ) );
  vec3 Rglint = reflect( -V, Nglint );
  Rglint.y = max( Rglint.y, 0.01 );
  float sunUp = smoothstep( -0.02, 0.14, L.y );
  float RdotL = max( dot( Rglint, L ), 0.0 );
  float glintMask = smoothstep( 0.035, 0.16, vWaterDepth ) * aa2;
  float glintSharp = pow( RdotL, 96.0 ) * 0.68 * mix( 1.0, 0.22, noonSun );
  float glintSoft = pow( RdotL, 28.0 ) * 0.085 * mix( 1.0, 0.16, noonSun );
  vec3 warmGlintColor = mix( uSunColor, vec3( 1.0, 0.82, 0.46 ), 0.44 );
  vec3 glintContrib = warmGlintColor * ( glintSharp + glintSoft ) * sunUp * clamp( uSunIntensity / 2.6, 0.08, 1.25 ) * glintMask;

  // Crisp nocturnal obsidian oasis mirror: subtle Twin-Moon glint without milky grey center haze!
  vec3 moonRefDir = normalize( vec3( -0.11, 0.33, -0.93 ) );
  float RdotM = max( dot( Rglint, moonRefDir ), 0.0 );
  vec3 moonShimmer = vec3( 0.62, 0.80, 1.0 ) * ( pow( RdotM, 96.0 ) * 0.22 ) * nightMirror * glintMask;

  waterContrib += glintContrib + moonShimmer + mix( uSunColor, vec3( 0.85, 0.94, 1.0 ), 0.45 ) * interactiveFoam * shoreCalm;

  float alpha = clamp( shoreFade * alphaPhys + shoreFade * glintSharp * glintMask * 0.025, 0.0, 0.95 );
  vec3 finalWater = min( ( shoreFade * waterContrib ) / max( alpha, 0.0005 ), vec3( 4.2 ) );

  gl_FragColor = vec4( finalWater, alpha );

  #include <fog_fragment>
}
`
  };

  const initRes = worldState?.getQualityConfig?.().waterRes || 1024;
  const reflector = new Reflector(waterGeo, {
    clipBias: 0.0035,
    textureWidth: initRes,
    textureHeight: initRes,
    color: 0x6ba6a2,
    shader: customWaterShader
  });

  reflector.name = 'DewCisternWater';
  reflector.rotation.x = -Math.PI / 2;
  reflector.position.set(CISTERN_CENTER.x, WATER_LEVEL, CISTERN_CENTER.z);
  reflector.renderOrder = 2;

  reflector.material.transparent = true;
  reflector.material.depthWrite = false;
  reflector.material.fog = true;

  if (worldState) {
    const u = reflector.material.uniforms;
    u.uTime.value = worldState.elapsed;
    u.uWindDir.value.copy(worldState.windDir);
    u.uWindSpeed.value = worldState.windSpeed;
    u.uSunDir.value.copy(worldState.sunDir);
    u.uSunColor.value.copy(worldState.sunColor);
    u.uSunIntensity.value = worldState.sunIntensity;
    u.uSkyColor.value.copy(worldState.skyHorizonColor);
    u.uZenithColor.value.copy(worldState.skyZenithColor);
    u.uThumperPos.value.copy(worldState.thumper.position);
    u.uThumperPulse.value = worldState.thumper.pulseStrength;
  }

  return reflector;
}

/**
 * Creates the seamless radially-warped Arrakis terrain system and reflective dew cistern pool.
 * @param {THREE.Scene} scene
 * @param {import('../state/worldState.js').WorldState} worldState
 * @returns {{ group: THREE.Group, update: (dt: number) => void }}
 */
export function createTerrainSystem(scene, worldState, sandTrails = null) {
  const group = new THREE.Group();
  group.name = 'ArrakisTerrainSystem';

  const fallbackTrailTex = new THREE.DataTexture(new Uint8Array([128, 0, 128, 255]), 1, 1);
  fallbackTrailTex.needsUpdate = true;

  const terrainUniforms = {
    uTime: { value: worldState ? worldState.elapsed : 0 },
    uWindDir: { value: new THREE.Vector2(1, 0).copy(worldState?.windDir ?? { x: 1, y: 0 }) },
    uWindSpeed: { value: worldState ? worldState.windSpeed : 0.45 },
    uSaltation: { value: worldState ? (worldState.weatherWeights?.saltation ?? 0.25) : 0.25 },
    uSunDir: { value: new THREE.Vector3(0.2, 0.25, -0.94).copy(worldState?.sunDir ?? { x: 0.2, y: 0.25, z: -0.94 }) },
    uSunColor: { value: worldState ? worldState.sunColor.clone() : new THREE.Color(0xffcfa0) },
    uSunIntensity: { value: worldState ? worldState.sunIntensity : 3.0 },
    uHorizonColor: { value: worldState ? worldState.skyHorizonColor.clone() : new THREE.Color(0xe6ac7c) },
    uZenithColor: { value: worldState ? worldState.skyZenithColor.clone() : new THREE.Color(0x4b6088) },
    uFogDensity: { value: worldState ? worldState.fogDensity : 0.0024 },
    uEclipse: { value: worldState ? worldState.eclipseStrength : 0 },
    uMirage: { value: worldState ? (worldState.weatherWeights?.mirage ?? 0) : 0 },
    uSpiceBlow: { value: worldState ? worldState.spiceBlow.intensity : 0 },
    uSpiceOrigin: { value: new THREE.Vector3(-21, 0, -68).copy(worldState?.spiceBlow.origin ?? { x: -21, y: 0, z: -68 }) },
    uThumperPos: { value: new THREE.Vector3(8.5, 0, -14.5).copy(worldState?.thumper.position ?? { x: 8.5, y: 0, z: -14.5 }) },
    uThumperPulse: { value: worldState ? worldState.thumper.pulseStrength : 0 },
    uThumperTrail: { value: worldState ? worldState.thumper.pulseStrength : 0 },
    uWormPos: { value: new THREE.Vector3(-25, 0, -125).copy(worldState?.worm.position ?? { x: -25, y: 0, z: -125 }) },
    uWormTremor: { value: worldState ? worldState.worm.tremor : 0 },
    uTrailMap: { value: sandTrails ? sandTrails.texture : fallbackTrailTex },
    uTrailOrigin: { value: sandTrails ? sandTrails.origin.clone() : new THREE.Vector2(0, 8) },
    uTrailSize: { value: sandTrails ? sandTrails.worldSize : 52.0 },
    uTrailEnabled: { value: sandTrails ? 1.0 : 0.0 }
  };

  // 1. Single seamless radially-warped continuous terrain mesh (0.28m oasis detail -> 480m horizon)
  const terrainGeo = populateTerrainGeometry(
    new THREE.PlaneGeometry(2, 2, TERRAIN_SEGS, TERRAIN_SEGS)
  );
  const terrainMat = createTerrainMaterial(terrainUniforms);
  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.name = 'ArrakisTerrain';
  terrainMesh.position.set(0, 0, 0);
  terrainMesh.receiveShadow = true;
  terrainMesh.castShadow = true;
  group.add(terrainMesh);

  // 2. Dew cistern reflective mineral pool
  const waterReflector = createDewCisternReflector(worldState, terrainGeo);
  group.add(waterReflector);

  if (scene) {
    scene.add(group);
  }

  let thumperTrail = worldState ? worldState.thumper.pulseStrength : 0;

  function update(dt) {
    if (!worldState) return;

    const step = clamp(dt || 0, 0, 0.1);
    const pulse = worldState.thumper.pulseStrength;
    thumperTrail = Math.max(thumperTrail * Math.exp(-step * 2.1), pulse);

    terrainUniforms.uTime.value = worldState.elapsed;
    terrainUniforms.uWindDir.value.copy(worldState.windDir);
    terrainUniforms.uWindSpeed.value = worldState.windSpeed;
    terrainUniforms.uSaltation.value = worldState.weatherWeights?.saltation ?? 0;
    terrainUniforms.uSunDir.value.copy(worldState.sunDir);
    terrainUniforms.uSunColor.value.copy(worldState.sunColor);
    terrainUniforms.uSunIntensity.value = worldState.sunIntensity;
    terrainUniforms.uHorizonColor.value.copy(worldState.skyHorizonColor);
    terrainUniforms.uZenithColor.value.copy(worldState.skyZenithColor);
    terrainUniforms.uFogDensity.value = worldState.fogDensity;
    terrainUniforms.uEclipse.value = worldState.eclipseStrength;
    terrainUniforms.uMirage.value = worldState.weatherWeights?.mirage ?? 0;
    terrainUniforms.uSpiceBlow.value = worldState.spiceBlow.intensity;
    terrainUniforms.uSpiceOrigin.value.copy(worldState.spiceBlow.origin);
    terrainUniforms.uThumperPos.value.copy(worldState.thumper.position);
    terrainUniforms.uThumperPulse.value = pulse;
    terrainUniforms.uThumperTrail.value = thumperTrail;
    terrainUniforms.uWormPos.value.copy(worldState.worm.position);
    terrainUniforms.uWormTremor.value = worldState.worm.tremor;
    if (sandTrails) {
      terrainUniforms.uTrailOrigin.value.copy(sandTrails.origin);
      terrainUniforms.uTrailEnabled.value = 1.0;
    }

    const wu = waterReflector.material.uniforms;
    wu.uTime.value = worldState.elapsed;
    wu.uWindDir.value.copy(worldState.windDir);
    wu.uWindSpeed.value = worldState.windSpeed;
    wu.uSunDir.value.copy(worldState.sunDir);
    wu.uSunColor.value.copy(worldState.sunColor);
    wu.uSunIntensity.value = worldState.sunIntensity;
    wu.uSkyColor.value.copy(worldState.skyHorizonColor);
    wu.uZenithColor.value.copy(worldState.skyZenithColor);
    wu.uThumperPos.value.copy(worldState.thumper.position);
    wu.uThumperPulse.value = thumperTrail;
    if (sandTrails && wu.uRipples) {
      const dst = wu.uRipples.value;
      const src = sandTrails.waterRipples;
      for (let i = 0; i < 16 && i < src.length; i++) {
        dst[i].copy(src[i]);
      }
    }
  }

  function setWaterResolution(res) {
    const rt = waterReflector.getRenderTarget?.();
    if (rt && (rt.width !== res || rt.height !== res)) {
      rt.setSize(res, res);
    }
  }

  return { group, update, setWaterResolution };
}
