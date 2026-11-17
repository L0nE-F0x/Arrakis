// Pure deterministic spatial layout & terrain evaluator for Arrakis
// Sinuous S-curved razor-crested barchan/star dunes, sculpted distant Erg mountain ridges,
// natural sand-drifted windtrap/thumper rises, and multi-lobed organic spring cistern coves.

export const WATER_LEVEL = 0.72;
export const CISTERN_CENTER = { x: 0.0, z: 3.8 };

const PATH_POINTS = [
  { x: -2.4, z: 18.8 },
  { x: -5.4, z: 12.6 },
  { x: -7.4, z: 5.0 },
  { x: -9.0, z: -2.2 },
  { x: -12.8, z: -10.2 },
  { x: -17.0, z: -17.6 },
  { x: -19.8, z: -22.6 }
];

function fract(x) {
  return x - Math.floor(x);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

function hash2(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return fract(s);
}

export function valueNoise2(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3.0 - 2.0 * fx);
  const uz = fz * fz * (3.0 - 2.0 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return mix(mix(a, b, ux), mix(c, d, ux), uz);
}

export function fbm2(x, z, octaves = 4) {
  let sum = 0.0;
  let amp = 0.5;
  let px = x;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(px, pz);
    const nx = px * 1.62 - pz * 1.21 + 17.3;
    const nz = px * 1.21 + pz * 1.62 + 29.1;
    px = nx;
    pz = nz;
    amp *= 0.5;
  }
  return sum;
}

export function ridgeNoise2(x, z, octaves = 3) {
  let sum = 0.0;
  let amp = 0.5;
  let norm = 0.0;
  let px = x;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    const n = 1.0 - Math.abs(valueNoise2(px, pz) * 2.0 - 1.0);
    sum += amp * Math.pow(n, 1.48);
    norm += amp;
    const nx = px * 1.72 - pz * 1.18 + 19.7;
    const nz = px * 1.18 + pz * 1.72 + 31.3;
    px = nx;
    pz = nz;
    amp *= 0.5;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

function smax(a, b, k = 0.045) {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(a, b, h) + k * h * (1.0 - h);
}

function smin(a, b, k = 0.08) {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

export function getPathDistance(x, z) {
  let minDist = 1e6;
  let closestT = 0;
  for (let i = 0; i < PATH_POINTS.length - 1; i++) {
    const a = PATH_POINTS[i];
    const b = PATH_POINTS[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz;
    const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / lenSq, 0.0, 1.0);
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const dist = Math.hypot(x - px, z - pz);
    if (dist < minDist) {
      minDist = dist;
      closestT = (i + t) / (PATH_POINTS.length - 1);
    }
  }
  return { dist: minDist, t: closestT };
}

// Asymmetric knife-edge barchan profile: ~62% gently swept windward back vs ~38% steep 32-deg leeward slipface
// Smooth C1-continuous smin crest & trough rounding prevents flat plateaus and polygonal ridge sawtooths
function barchanDuneProfile(phase, tipEps = 0.011, crestPos = 0.62) {
  const p = fract(phase / (Math.PI * 2.0));
  const uW = p / crestPos;
  const uL = (p - crestPos) / (1.0 - crestPos);

  const windLead = smoothstep(0.0, 0.14, uW);
  const hWind = 0.22 * uW * windLead + 0.78 * Math.pow(Math.max(uW, 0.0), 1.42);
  const hLee = Math.pow(Math.max(1.0 - uL, 0.0), 1.45);

  const crestK = clamp(tipEps * 6.0, 0.04, 0.92);
  const h = clamp(smin(hWind, hLee, crestK), 0.0, 1.0);

  // Slip-face mask localized along leeward drop below the brink, smoothly widened with tipEps
  const slipLead = 0.006 + tipEps * 0.34;
  const slipTrail = 0.016 + tipEps * 0.72;
  const slipMask = smoothstep(crestPos - slipLead, crestPos + slipTrail, p) * (1.0 - smoothstep(0.84, 0.96, p));
  return { h, slipMask };
}

function angDelta(ang, target) {
  return Math.atan2(Math.sin(ang - target), Math.cos(ang - target));
}

function sweepingSoftDune(p) {
  const s = Math.sin(p + 0.35 * Math.sin(p));
  return 1.0 - Math.sqrt(s * s + 0.045);
}

export function getTerrainInfo(x, z) {
  // 1. Multi-lobed organic desert spring cistern with an asymmetric NW sandy spit peninsula & meandering NE rocky cove
  const dxC = x - CISTERN_CENTER.x;
  const dzC = z - CISTERN_CENTER.z;
  const angC = Math.atan2(dzC, dxC);
  const rawDistC = Math.hypot(dxC, dzC);
  const coveFrontLeft = -1.05 * Math.exp(-Math.pow(angDelta(angC, 2.22) / 0.36, 2.0));
  const coveFrontRight = -0.46 * Math.exp(-Math.pow(angDelta(angC, 0.58) / 0.34, 2.0));
  // Pronounced asymmetric NW sandy spit peninsula jutting into the pool + hooked inner point breaking the oval silhouette
  const spitNorthWest = 1.35 * Math.exp(-Math.pow(angDelta(angC, -2.42) / 0.32, 2.0));
  const spitNorthHook = 0.72 * Math.exp(-Math.pow(angDelta(angC, -1.78) / 0.26, 2.0));
  // Curved sandy peninsula spit protruding from NW bank around (-1.85, 2.15), creating a lagoon pocket behind & cove in front
  const peninsulaLobe = 2.05 * Math.exp(-((x + 1.80) * (x + 1.80)) / 2.2 - ((z - 2.15) * (z - 2.15)) / 1.15);
  // Meandering N/NE cove lagoon carving northward while staying safely west of floraTgt (4.2, 2.6)
  const coveNorthEast = -1.82 * Math.exp(-Math.pow(angDelta(angC, -1.24) / 0.30, 2.0));
  const coveWestPocket = -0.68 * Math.exp(-Math.pow(angDelta(angC, 2.74) / 0.28, 2.0));
  const spitEast = 1.12 * Math.exp(-Math.pow(angDelta(angC, -0.26) / 0.34, 2.0));
  const spitSouthEast = 0.68 * Math.exp(-Math.pow(angDelta(angC, 0.98) / 0.28, 2.0));
  const southEntryCove = -0.78 * Math.exp(-Math.pow(angDelta(angC, 1.60) / 0.46, 2.0));
  const organicHarm = Math.sin(angC * 3.0 - 0.45) * 0.30 + Math.cos(angC * 5.0 + 1.1) * 0.16;
  const warpL =
    (fbm2(x * 0.24 + 4.1, z * 0.24 - 2.3, 3) - 0.5) * 1.55 +
    (fbm2(x * 0.58 - 1.7, z * 0.58 + 6.4, 2) - 0.5) * 0.50;
  const asymOffset =
    (coveFrontLeft +
      coveFrontRight +
      spitNorthWest +
      spitNorthHook +
      coveNorthEast +
      coveWestPocket +
      spitEast +
      spitSouthEast +
      southEntryCove +
      organicHarm) *
    smoothstep(1.0, 3.0, rawDistC) + peninsulaLobe;
  const cisternRadius = Math.hypot(dxC * 1.05, dzC * 0.90) + warpL + asymOffset;
  const cisternBowl = 1.0 - smoothstep(2.8, 7.2, cisternRadius);

  // 2. Winding path ends softly BEFORE northern Erg rise & Windtrap ramp (prevents any pit/blotch at z=-24!)
  const pathInfo = getPathDistance(x, z);
  const pathNorthFade = 1.0 - smoothstep(-15.0, -22.5, z);
  const heightNorthFade = 1.0 - smoothstep(-11.0, -16.5, z);
  const rawPathMask = 1.0 - smoothstep(0.65, 1.65, pathInfo.dist);
  const pathEdgeDrift = fbm2(x * 0.45 + 7.2, z * 0.45 - 3.1, 2);
  const pathMask = clamp(rawPathMask * pathNorthFade * smoothstep(0.08, 0.62, pathEdgeDrift + 0.36), 0.0, 1.0);

  // 3. Basin shelter enclosure + smooth canyon drifts (no sharp E-W northern shadow trough behind Windtrap!)
  const distFromCenter = Math.hypot(x, z - 2.0);
  const northGap =
    Math.exp(-Math.pow((x + 0.5) / 14.5, 2.0)) *
    smoothstep(-5.0, -19.0, z) *
    (1.0 - smoothstep(-26.0, -52.0, z));

  const rimBase = smoothstep(13.5, 34.0, distFromCenter) * (1.0 - northGap * 0.90);
  const smoothFlankNoise = fbm2(x * 0.036 + 1.2, z * 0.036 + 8.4, 3);
  const flankDrift =
    rimBase *
    (2.1 + 6.1 * smoothFlankNoise) *
    smoothstep(-72.0, 18.0, z);

  // Windtrap foundation sand drift ramp
  const distWT = Math.hypot((x + 21.0) * 0.95, (z + 25.0) * 0.85);
  const wtRamp = Math.exp(-Math.pow(distWT / 6.4, 2.0)) * 1.15;

  // Thumper small disturbed sand collar
  const distTh = Math.hypot(x - 8.5, z + 14.5);
  const thumperMound =
    Math.exp(-Math.pow(distTh / 1.85, 2.0)) * 0.22 -
    Math.exp(-Math.pow(distTh / 0.42, 2.0)) * 0.11;

  // 4. Sweeping Great Erg S-Curved Razor-Crested Barchan & Star Dunes
  const ergBlend = clamp(
    Math.max(smoothstep(-13.5, -44.0, z), smoothstep(23.0, 56.0, distFromCenter)),
    0.0,
    1.0
  );

  const farDist = Math.hypot(x, z + 10.0);
  // Keep close foreground dunes (< 32m) wind-sculpted & crisp while smoothly widening midground crests (34..140m) past triangle Nyquist
  const midAdapt = smoothstep(34.0, 128.0, farDist);
  const farSoften = smoothstep(115.0, 290.0, farDist);
  const flowWarp1 = (fbm2(x * 0.0046 + 3.1, z * 0.0046 - 7.4, 3) - 0.5) * 1.15;
  const flowWarp2 = (fbm2(x * 0.0062 - 8.2, z * 0.0062 + 4.9, 2) - 0.5) * 1.35;

  // Iconic sinuous S-curved barchan ridges (~30-34m spacing across z=-34..-115m)
  // Oriented so windward 62% flanks catch western golden-hour sun while steep 32-deg leeward slipfaces drop into shadow
  const sAlong = -x * 0.25 + z * 0.97;
  const sCurve =
    0.24 * Math.sin(sAlong * 0.062 + 2.85) +
    0.13 * Math.sin(sAlong * 0.030 - 0.85);
  const staggerN = (fbm2(x * 0.009 + 5.7, z * 0.009 - 2.3, 2) - 0.5) * 0.72;

  const pPrimary = (x * 0.0305 + z * 0.0068) * Math.PI * 2.0 + sCurve * Math.PI * 2.0 + flowWarp1 * 0.58 + staggerN + 2.45;
  const pSecondary = (x * 0.0145 - z * 0.0225) * Math.PI * 2.0 - sCurve * 1.15 + flowWarp2 * 0.65 - 0.55;
  const pStar = (x * 0.0092 + z * 0.0135) * Math.PI * 2.0 + flowWarp2 * 0.85 - 0.45;
  const ridgeFacet = ridgeNoise2(x * 0.0038 + 14.3, z * 0.0038 - 9.7, 2);

  // Foreground dunes (< 32m) keep crisp ~0.011..0.013 wind crests; midground/far (35..160m+) widen smoothly to 0.070..0.115
  const tipEps1 = mix(0.011, 0.105, midAdapt) + 0.020 * farSoften;
  const tipEps2 = mix(0.013, 0.115, midAdapt) + 0.020 * farSoften;
  const tipEpsStar = mix(0.013, 0.110, midAdapt) + 0.020 * farSoften;
  const prof1 = barchanDuneProfile(pPrimary, tipEps1, 0.62);
  const prof2 = barchanDuneProfile(pSecondary, tipEps2, 0.64);
  const profStar = barchanDuneProfile(pStar, tipEpsStar, 0.60);

  // Broad sweeping distant windblown Erg megadunes: continuous S-curved windward slopes, softly rounded barchan horns,
  // and graceful saddle dips (zero sharp conical needles or flat-topped mesa truncations!)
  const massifDist = smoothstep(95.0, 235.0, farDist);
  const rightSwirl = Math.sin(x * 0.0085 - z * 0.0062 + 0.7) * 0.46 + Math.cos(x * 0.0052 + z * 0.0096) * 0.34;
  const cuestaWarp =
    (fbm2(x * 0.0018 + 6.1, z * 0.0018 - 3.3, 3) - 0.5) * 1.65 +
    (fbm2(x * 0.0034 + 11.4, z * 0.0034 - 5.9, 2) - 0.5) * 0.85 +
    rightSwirl;
  const pCuesta = (x * 0.0031 - z * 0.0020) * Math.PI * 2.0 + cuestaWarp + 1.35;
  const pCuesta2 = (x * 0.0023 + z * 0.0035) * Math.PI * 2.0 - cuestaWarp * 0.62 + 0.55;
  const profCuesta = barchanDuneProfile(pCuesta, 0.125, 0.63);
  const profCuesta2 = barchanDuneProfile(pCuesta2, 0.135, 0.60);
  const ridgeSaddleMod = fbm2(x * 0.0028 - 4.2, z * 0.0024 + 11.1, 3);
  const broadUndulation = 0.5 + 0.5 * Math.sin(x * 0.0105 + z * 0.0068 + ridgeSaddleMod * 2.8);
  const cuestaBase = smax(profCuesta.h * 0.90, profCuesta2.h * 0.74, 0.22);
  const cuestaShape =
    Math.pow(clamp(cuestaBase, 0.0, 1.0), 0.88) *
    (0.64 + 0.34 * ridgeSaddleMod + 0.16 * broadUndulation);
  const horizonMassifs =
    (cuestaShape - 0.38) * 18.5 * massifDist +
    (ridgeSaddleMod - 0.48) * 7.5 * smoothstep(140.0, 360.0, farDist);

  // Monotonically climbing base prevents 1-pixel subpixel distant ridges peeking horizontally behind front dunes!
  const distNorth = Math.max(0.0, -z - 22.0);
  const ergBaseRise = 1.45 + smoothstep(14.0, 420.0, distNorth) * 18.0;
  const ergAmplitude = 4.5 + smoothstep(26.0, 195.0, distNorth) * 12.2 + smoothstep(32.0, 160.0, Math.abs(x)) * 3.0;

  const secondaryWeight = mix(0.28, 0.20, farSoften);
  const starCrest = smax(prof1.h * 0.94, prof2.h * 0.44 + profStar.h * 0.18, mix(0.075, 0.19, midAdapt));
  const localCrest = mix(prof1.h * 0.86 + prof2.h * secondaryWeight * 0.55, starCrest, 0.52);
  const combinedCrest = clamp(
    localCrest * mix(1.0, 0.62, farSoften) +
      cuestaShape * massifDist * 0.20 +
      (ridgeFacet - 0.46) * mix(0.07, 0.0, midAdapt),
    0.0,
    1.18
  );
  const dunesHeight = ergBaseRise + combinedCrest * ergAmplitude + horizonMassifs;

  const fgSwell = (fbm2(x * 0.080 - 3.1, z * 0.080 + 5.7, 3) - 0.42) * 1.02;
  const fgDrift = sweepingSoftDune(x * 0.14 + z * 0.10 + fbm2(x * 0.05, z * 0.05, 2) * 2.0) * 0.30;

  let height = 1.32 + (fgSwell + fgDrift) * (1.0 - cisternBowl * 0.92) * (1.0 - ergBlend * 0.65);
  height += flankDrift * (1.0 - ergBlend * 0.72) + wtRamp + thumperMound;
  height = mix(height, Math.max(height, dunesHeight), ergBlend);

  // Carve cistern pool strictly inside cisternBowl with gently shelving sunlit south shallow cove
  const southShallow = smoothstep(-0.2, 5.4, dzC);
  const rimShelf = smoothstep(2.2, 5.5, cisternRadius);
  const cisternFloor =
    WATER_LEVEL -
    0.58 * clamp(1.0 - 0.52 * southShallow - 0.36 * rimShelf, 0.14, 1.0) +
    (fbm2(x * 0.35, z * 0.35, 2) - 0.5) * 0.10;
  height = mix(height, cisternFloor, cisternBowl);

  // Path stops gently before Windtrap ramp & Erg rise
  const targetPathY = 1.14 + 0.32 * smoothstep(-4.0, -16.0, z) + 0.22 * smoothstep(8.0, 20.0, z);
  height = mix(height, targetPathY, rawPathMask * 0.55 * heightNorthFade * (1.0 - cisternBowl));

  // Crisp natural shore slope meeting WATER_LEVEL cleanly while preserving gentle sunlit shallow coves
  const shorelineIn = smoothstep(3.5, 5.1, cisternRadius);
  const shorelineOut = 1.0 - smoothstep(5.4, 8.2, cisternRadius);
  const shorelineMask = shorelineIn * shorelineOut;
  const shoreTarget = WATER_LEVEL - 0.14 + 0.52 * smoothstep(4.3, 7.2, cisternRadius);
  height = mix(height, shoreTarget, shorelineMask * 0.32 * (1.0 - rawPathMask * 0.35));

  // Open sunlit south sandy cove apron sloping evenly down into shallow foreground water
  const frontSwale =
    smoothstep(7.2, 9.6, z) *
    (1.0 - smoothstep(11.6, 15.6, z)) *
    Math.exp(-Math.pow((x + 0.2) / 5.8, 2.0));
  const swaleTarget = WATER_LEVEL + 0.02 + 0.52 * smoothstep(8.2, 14.4, z);
  height = mix(height, Math.min(height, swaleTarget), frontSwale * 0.78 * (1.0 - cisternBowl * 0.75));

  const rockMask = clamp(
    smoothstep(3.6, 7.4, flankDrift) * (1.0 - ergBlend * 0.72),
    0.0,
    1.0
  );

  const nearCistern = 1.0 - smoothstep(5.4, 9.6, cisternRadius);
  const waterDepth = cisternBowl > 0.04 ? Math.max(0.0, WATER_LEVEL - height) : 0.0;
  const moisture = clamp(
    nearCistern * (1.0 - smoothstep(WATER_LEVEL - 0.04, WATER_LEVEL + 0.14, height)) * 0.90,
    0.0,
    1.0
  );

  // Wind-sorted fine spice mineral seams concentrated in leeward slip-aprons & interdune troughs
  const windU = x * 0.913 + z * 0.408;
  const windV = -x * 0.408 + z * 0.913;
  const spiceNoise = fbm2(windU * 0.024 + 23.1, windV * 0.088 - 14.7, 3);
  const troughLeeBias = clamp((1.0 - smoothstep(0.18, 0.56, combinedCrest)) * (0.45 + 0.55 * prof1.slipMask), 0.0, 1.0);
  const spiceRichness = clamp(
    smoothstep(0.58, 0.83, spiceNoise) * ergBlend * (1.0 - rockMask) * troughLeeBias,
    0.0,
    1.0
  );

  // Crisp leeward slipfaces strictly localized to primary S-curve & cuesta avalanche faces (zero basin trough smudge)
  const rawSlip = clamp(
    prof1.slipMask * 0.86 +
      prof2.slipMask * secondaryWeight * 0.34 +
      profStar.slipMask * 0.18 +
      smax(profCuesta.slipMask * 0.72, profCuesta2.slipMask * 0.48, 0.10) * massifDist,
    0.0,
    1.0
  );
  const slipMaskOut = rawSlip * smoothstep(-20.0, -44.0, z);

  return {
    height,
    waterDepth,
    isWater: waterDepth > 0.02,
    pathMask,
    cisternBowl,
    rockMask,
    moisture,
    duneCrest: combinedCrest,
    slipFace: slipMaskOut,
    ergBlend,
    spiceRichness
  };
}

export function getGroundHeight(x, z) {
  return getTerrainInfo(x, z).height;
}

export function getGroundNormal(x, z, outNormal) {
  const eps = 0.25;
  const hL = getGroundHeight(x - eps, z);
  const hR = getGroundHeight(x + eps, z);
  const hD = getGroundHeight(x, z - eps);
  const hU = getGroundHeight(x, z + eps);
  const nx = hL - hR;
  const ny = 2.0 * eps;
  const nz = hD - hU;
  const len = Math.hypot(nx, ny, nz) || 1.0;
  if (outNormal) {
    outNormal.set(nx / len, ny / len, nz / len);
    return outNormal;
  }
  return { x: nx / len, y: ny / len, z: nz / len };
}

export function getPathPointAt(t) {
  const clamped = clamp(t, 0, 1) * (PATH_POINTS.length - 1);
  const idx = Math.min(Math.floor(clamped), PATH_POINTS.length - 2);
  const localT = clamped - idx;
  const a = PATH_POINTS[idx];
  const b = PATH_POINTS[idx + 1];
  const x = mix(a.x, b.x, localT);
  const z = mix(a.z, b.z, localT);
  return { x, y: getGroundHeight(x, z), z };
}
