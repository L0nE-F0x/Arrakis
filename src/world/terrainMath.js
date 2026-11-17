// Pure deterministic spatial layout & terrain evaluator for Arrakis
// Monumental non-repeating Star Dunes (ghourds), sinuous S-curved razor-crested barchans,
// natural southern qanat approach walk + western windtrap trail, and multi-cove spring cistern.

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

const ENTRY_WALK_POINTS = [
  { x: 0.55, z: 18.0 },
  { x: 0.36, z: 14.2 },
  { x: 0.18, z: 10.2 },
  { x: -2.4, z: 11.8 },
  { x: -5.4, z: 12.6 }
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

function polylineDistance(points, x, z) {
  let minDist = 1e6;
  let closestT = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz;
    const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / lenSq, 0.0, 1.0);
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const dist = Math.hypot(x - px, z - pz);
    if (dist < minDist) {
      minDist = dist;
      closestT = (i + t) / (points.length - 1);
    }
  }
  return { dist: minDist, t: closestT };
}

export function getPathDistance(x, z) {
  return polylineDistance(PATH_POINTS, x, z);
}

export function getEntryWalkDistance(x, z) {
  return polylineDistance(ENTRY_WALK_POINTS, x, z);
}

// Asymmetric knife-edge barchan profile: ~62% gently swept windward back vs ~38% steep 32-deg leeward slipface
function barchanDuneProfile(phase, tipEps = 0.011, crestPos = 0.62) {
  const p = fract(phase / (Math.PI * 2.0));
  const uW = p / crestPos;
  const uL = (p - crestPos) / (1.0 - crestPos);

  const windLead = smoothstep(0.0, 0.14, uW);
  const hWind = 0.22 * uW * windLead + 0.78 * Math.pow(Math.max(uW, 0.0), 1.42);
  const hLee = Math.pow(Math.max(1.0 - uL, 0.0), 1.45);

  const crestK = clamp(tipEps * 6.0, 0.038, 0.88);
  const h = clamp(smin(hWind, hLee, crestK), 0.0, 1.0);

  const slipLead = 0.005 + tipEps * 0.30;
  const slipTrail = 0.015 + tipEps * 0.68;
  const slipMask =
    smoothstep(crestPos - slipLead, crestPos + slipTrail, p) * (1.0 - smoothstep(0.84, 0.96, p));
  return { h, slipMask };
}

function angDelta(ang, target) {
  return Math.atan2(Math.sin(ang - target), Math.cos(ang - target));
}

function sweepingSoftDune(p) {
  const s = Math.sin(p + 0.35 * Math.sin(p));
  return 1.0 - Math.sqrt(s * s + 0.045);
}

// Monumental C2-smooth Star-Barchan Mega-Massif (broad Cartesian S-curved ridges >= 55m half-width; zero Nyquist spikes!)
function evalStarDuneMassif(x, z, cx, cz, heightAmp, radius, yaw = 0.35, asym = 0.62) {
  const dx = x - cx;
  const dz = z - cz;
  const r2 = dx * dx + dz * dz;
  const maxR = radius * 1.45;
  if (r2 > maxR * maxR) {
    return { h: 0.0, crest: 0.0, slip: 0.0 };
  }
  const r = Math.sqrt(r2);
  const u = r / radius;
  // Ultra-smooth C2 Hann-like envelope
  const cEnv = 0.5 + 0.5 * Math.cos(Math.min(1.0, u / 1.42) * Math.PI);
  const baseEnv = cEnv * cEnv;

  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  // S-curved local windward/leeward coordinate across the massif
  const along = dx * sy + dz * cy;
  const across = dx * cy - dz * sy + 18.0 * Math.sin(along / (radius * 0.55));
  const wNorm = across / (radius * 0.68);

  // Crisp wind-carved asymmetric barchan/star-arm crest (gentle convex windward sweep vs steep 32-deg leeward avalanche face, zero Nyquist spikes!)
  const wAbs = Math.sqrt(wNorm * wNorm + 0.012);
  const ridgeProf =
    wNorm < 0.0
      ? Math.exp(-wAbs * (1.05 * asym) - wNorm * wNorm * (0.75 * asym))
      : Math.exp(-wAbs * 1.85 - wNorm * wNorm * 1.65);

  // Secondary wind-swept star-arm ridge crest giving an authentic ghourd pyramid silhouette
  const crossCoord = (along + 14.0 * Math.cos(across / (radius * 0.6))) / (radius * 0.74);
  const cAbs = Math.sqrt(crossCoord * crossCoord + 0.016);
  const shoulder = Math.exp(-cAbs * 1.35 - crossCoord * crossCoord * 1.15) * 0.42;

  const shape = baseEnv * clamp(ridgeProf * 0.82 + shoulder, 0.0, 1.08);
  const slip =
    wNorm > 0.05 && wNorm < 0.95
      ? Math.exp(-Math.pow((wNorm - 0.38) / 0.32, 2.0)) * baseEnv
      : 0.0;

  return {
    h: shape * heightAmp,
    crest: clamp(ridgeProf * baseEnv * 1.15, 0.0, 1.0),
    slip: clamp(slip, 0.0, 1.0)
  };
}

export function getTerrainInfo(x, z) {
  // 1. Multi-lobed organic desert spring cistern with asymmetric NW sandy spit & meandering NE/SE coves
  const dxC = x - CISTERN_CENTER.x;
  const dzC = z - CISTERN_CENTER.z;
  const angC = Math.atan2(dzC, dxC);
  const rawDistC = Math.hypot(dxC, dzC);
  const coveFrontLeft = -1.05 * Math.exp(-Math.pow(angDelta(angC, 2.22) / 0.36, 2.0));
  const coveFrontRight = -0.48 * Math.exp(-Math.pow(angDelta(angC, 0.58) / 0.34, 2.0));
  const spitNorthWest = 1.32 * Math.exp(-Math.pow(angDelta(angC, -2.42) / 0.32, 2.0));
  const spitNorthHook = 0.68 * Math.exp(-Math.pow(angDelta(angC, -1.78) / 0.26, 2.0));
  const peninsulaLobe =
    1.95 * Math.exp(-((x + 1.80) * (x + 1.80)) / 2.2 - ((z - 2.15) * (z - 2.15)) / 1.15);
  const coveNorthEast = -1.85 * Math.exp(-Math.pow(angDelta(angC, -1.24) / 0.30, 2.0));
  const coveWestPocket = -0.68 * Math.exp(-Math.pow(angDelta(angC, 2.74) / 0.28, 2.0));
  const spitEast = 1.08 * Math.exp(-Math.pow(angDelta(angC, -0.26) / 0.34, 2.0));
  const spitSouthEast = 0.64 * Math.exp(-Math.pow(angDelta(angC, 0.98) / 0.28, 2.0));
  const southEntryCove = -0.92 * Math.exp(-Math.pow(angDelta(angC, 1.56) / 0.44, 2.0));
  const organicHarm = Math.sin(angC * 3.0 - 0.45) * 0.28 + Math.cos(angC * 5.0 + 1.1) * 0.15;
  const warpL =
    (fbm2(x * 0.24 + 4.1, z * 0.24 - 2.3, 3) - 0.5) * 1.48 +
    (fbm2(x * 0.58 - 1.7, z * 0.58 + 6.4, 2) - 0.5) * 0.45;
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
      smoothstep(1.0, 3.0, rawDistC) +
    peninsulaLobe;
  const cisternRadius = Math.hypot(dxC * 1.04, dzC * 0.90) + warpL + asymOffset;
  const cisternBowl = 1.0 - smoothstep(2.9, 7.25, cisternRadius);

  // 2. Winding western Windtrap path + Southern entry qanat walk leading down to the cistern shore
  const pathInfo = getPathDistance(x, z);
  const entryInfo = getEntryWalkDistance(x, z);
  const pathNorthFade = 1.0 - smoothstep(-15.0, -22.5, z);
  const heightNorthFade = 1.0 - smoothstep(-11.0, -16.5, z);
  const rawWestPath = (1.0 - smoothstep(0.65, 1.65, pathInfo.dist)) * pathNorthFade;
  const muadDibClear = smoothstep(0.95, 2.2, Math.hypot(x - 3.2, z - 9.2));
  const rawEntryWalk = (1.0 - smoothstep(0.75, 1.85, entryInfo.dist)) * (1.0 - smoothstep(10.8, 8.8, z) * 0.35) * muadDibClear;
  const rawPathMask = Math.max(rawWestPath, rawEntryWalk * 0.92);
  const pathEdgeDrift = fbm2(x * 0.45 + 7.2, z * 0.45 - 3.1, 2);
  const pathMask = clamp(rawPathMask * smoothstep(0.08, 0.62, pathEdgeDrift + 0.38), 0.0, 1.0);

  // 3. Basin shelter enclosure + smooth flanking sandstone canyon rises
  const distFromCenter = Math.hypot(x, z - 2.0);
  const northGap =
    Math.exp(-Math.pow((x + 0.5) / 15.0, 2.0)) *
    smoothstep(-5.0, -19.0, z) *
    (1.0 - smoothstep(-26.0, -54.0, z));

  const rimBase = smoothstep(13.5, 34.0, distFromCenter) * (1.0 - northGap * 0.90);
  const smoothFlankNoise = fbm2(x * 0.036 + 1.2, z * 0.036 + 8.4, 3);
  const flankDrift = rimBase * (2.1 + 6.2 * smoothFlankNoise) * smoothstep(-72.0, 18.0, z);

  // Windtrap foundation spur ramp
  const distWT = Math.hypot((x + 21.0) * 0.92, (z + 25.0) * 0.84);
  const wtRamp = Math.exp(-Math.pow(distWT / 6.8, 2.0)) * 1.28;

  // Thumper disturbed sand collar
  const distTh = Math.hypot(x - 8.5, z + 14.5);
  const thumperMound =
    Math.exp(-Math.pow(distTh / 1.85, 2.0)) * 0.22 -
    Math.exp(-Math.pow(distTh / 0.42, 2.0)) * 0.11;

  // Subtle Spice Blow basin depression at (-21, -68)
  const distSpice = Math.hypot(x + 21.0, z + 68.0);
  const spiceCrater =
    Math.exp(-Math.pow((distSpice - 6.8) / 2.6, 2.0)) * 0.85 -
    Math.exp(-Math.pow(distSpice / 5.6, 2.0)) * 1.35;

  // 4. Sweeping Great Erg: Non-Periodic Domain-Warped S-Curve Barchans + Monumental Star Dune Massifs
  const ergBlend = clamp(
    Math.max(smoothstep(-13.5, -42.0, z), smoothstep(23.0, 56.0, distFromCenter)),
    0.0,
    1.0
  );

  const farDist = Math.hypot(x, z + 10.0);
  const midAdapt = smoothstep(38.0, 145.0, farDist);
  const farSoften = smoothstep(130.0, 320.0, farDist);

  // Domain-warped non-uniform wavelength prevents repeating horizon scallops/clones!
  const scaleWarp = (fbm2(x * 0.0032 - 4.1, z * 0.0032 + 9.2, 3) - 0.5) * 26.0;
  const xWarped = x + scaleWarp + 14.0 * Math.sin(z * 0.011 + 0.8);
  const flowWarp1 = (fbm2(x * 0.0048 + 3.1, z * 0.0048 - 7.4, 3) - 0.5) * 1.35;
  const flowWarp2 = (fbm2(x * 0.0064 - 8.2, z * 0.0064 + 4.9, 2) - 0.5) * 1.45;

  const sAlong = -x * 0.24 + z * 0.97;
  const sCurve =
    0.28 * Math.sin(sAlong * 0.058 + 2.75) +
    0.15 * Math.sin(sAlong * 0.027 - 0.95);
  const staggerN = (fbm2(x * 0.0082 + 5.7, z * 0.0082 - 2.3, 3) - 0.5) * 1.05;

  const pPrimary =
    (xWarped * 0.0265 + z * 0.0072) * Math.PI * 2.0 +
    sCurve * Math.PI * 2.0 +
    flowWarp1 * 0.68 +
    staggerN +
    2.38;
  const pSecondary =
    (xWarped * 0.0132 - z * 0.0215) * Math.PI * 2.0 -
    sCurve * 1.15 +
    flowWarp2 * 0.72 -
    0.55;
  const pStar = (x * 0.0085 + z * 0.0128) * Math.PI * 2.0 + flowWarp2 * 0.88 - 0.45;

  const tipEps1 = mix(0.0110, 0.120, midAdapt) + 0.032 * farSoften;
  const tipEps2 = mix(0.0130, 0.128, midAdapt) + 0.032 * farSoften;
  const tipEpsStar = mix(0.0130, 0.125, midAdapt) + 0.032 * farSoften;
  const prof1 = barchanDuneProfile(pPrimary, tipEps1, 0.62);
  const prof2 = barchanDuneProfile(pSecondary, tipEps2, 0.64);
  const profStar = barchanDuneProfile(pStar, tipEpsStar, 0.60);

  // Dramatic diagonal S-curve hero barchan brink (sweeps diagonally so both ridge & horizon cams look along a sunlit S-curve slipface, never a flat dark wall!)
  const fgHeroBand =
    smoothstep(-20.0, -34.0, z) * (1.0 - smoothstep(-62.0, -90.0, z)) * Math.exp(-Math.pow((x + 2.0) / 54.0, 2.0));
  const fgSBrinkCoord = z + 46.0 - x * 0.42 + 8.5 * Math.sin(x * 0.068 + 0.55) + 3.2 * Math.cos(x * 0.034 - 0.8);
  const fgBrinkWind = smoothstep(-24.0, 1.2, fgSBrinkCoord);
  const fgBrinkLee = 1.0 - smoothstep(1.2, 12.5, fgSBrinkCoord);
  const fgHeroRidge = clamp(smin(fgBrinkWind, fgBrinkLee, 0.09), 0.0, 1.0) * fgHeroBand;
  const fgHeroSlip =
    smoothstep(0.2, 2.8, fgSBrinkCoord) * (1.0 - smoothstep(9.5, 13.5, fgSBrinkCoord)) * fgHeroBand;

  // Monumental non-periodic Star-Barchan Massifs creating an asymmetric, spike-free Arrakis skyline!
  const starHeroLeft = evalStarDuneMassif(x, z, -44.0, -182.0, 21.5, 118.0, 0.42, 0.60);
  const starFarRight = evalStarDuneMassif(x, z, 64.0, -268.0, 28.5, 148.0, -0.36, 0.64);
  const starWestFlank = evalStarDuneMassif(x, z, -152.0, -238.0, 24.0, 132.0, 0.28, 0.62);
  const starEastFlank = evalStarDuneMassif(x, z, 156.0, -206.0, 22.0, 128.0, -0.45, 0.62);
  const starDeepCenter = evalStarDuneMassif(x, z, -2.0, -340.0, 31.0, 168.0, 0.22, 0.58);

  // Subtle interdune corridor valley right-of-center (x ~ +10..+28, z ~ -145..-215) for dramatic peak-to-saddle relief
  const saddleDip =
    -5.8 *
    Math.exp(-Math.pow((x - 15.0) / 30.0, 2.0)) *
    Math.exp(-Math.pow((z + 178.0) / 52.0, 2.0));

  const starMassifH =
    starHeroLeft.h +
    starFarRight.h +
    starWestFlank.h +
    starEastFlank.h +
    starDeepCenter.h +
    saddleDip;

  const starMassifCrest = Math.max(
    starHeroLeft.crest,
    starFarRight.crest,
    starWestFlank.crest,
    starEastFlank.crest,
    starDeepCenter.crest
  );
  const starMassifSlip = Math.max(
    starHeroLeft.slip,
    starFarRight.slip,
    starWestFlank.slip,
    starEastFlank.slip,
    starDeepCenter.slip
  );

  // Amplitude envelope with organic spatial modulation (no two barchan crests have identical height!)
  const ampMod = 0.62 + 0.68 * fbm2(x * 0.0065 - 3.4, z * 0.0065 + 7.8, 3);
  const distNorth = Math.max(0.0, -z - 22.0);
  const ergBaseRise = 1.42 + smoothstep(14.0, 420.0, distNorth) * 15.5;
  const ergAmplitude =
    (4.2 + smoothstep(26.0, 195.0, distNorth) * 10.2 + smoothstep(32.0, 160.0, Math.abs(x)) * 2.8) *
    ampMod;

  const secondaryWeight = mix(0.28, 0.20, farSoften);
  const starCrest = smax(prof1.h * 0.94, prof2.h * 0.44 + profStar.h * 0.18, mix(0.072, 0.18, midAdapt));
  const localCrest = mix(prof1.h * 0.86 + prof2.h * secondaryWeight * 0.55, starCrest, 0.52);
  const combinedCrest = clamp(
    Math.max(
      localCrest * mix(1.0, 0.62, farSoften) + starMassifCrest * 0.42,
      fgHeroRidge * 0.95
    ),
    0.0,
    1.18
  );
  const dunesHeight =
    ergBaseRise +
    localCrest * mix(1.0, 0.64, farSoften) * ergAmplitude +
    fgHeroRidge * 3.85 +
    starMassifH +
    spiceCrater;

  const fgSwell = (fbm2(x * 0.080 - 3.1, z * 0.080 + 5.7, 3) - 0.42) * 0.96;
  const fgDrift = sweepingSoftDune(x * 0.14 + z * 0.10 + fbm2(x * 0.05, z * 0.05, 2) * 2.0) * 0.28;

  let height = 1.30 + (fgSwell + fgDrift) * (1.0 - cisternBowl * 0.92) * (1.0 - ergBlend * 0.65);
  height += flankDrift * (1.0 - ergBlend * 0.72) + wtRamp + thumperMound;
  height = mix(height, Math.max(height, dunesHeight), ergBlend);

  // Carve cistern pool inside cisternBowl with gently shelving sunlit south sandy beach inlet
  const southShallow = smoothstep(-0.2, 5.4, dzC);
  const rimShelf = smoothstep(2.2, 5.6, cisternRadius);
  const cisternFloor =
    WATER_LEVEL -
    0.62 * clamp(1.0 - 0.48 * southShallow - 0.34 * rimShelf, 0.15, 1.0) +
    (fbm2(x * 0.35, z * 0.35, 2) - 0.5) * 0.08;
  height = mix(height, cisternFloor, cisternBowl);

  // Smoothly grade both the western Windtrap path and the southern entry walk down to the shore
  const westPathTargetY = 1.14 + 0.32 * smoothstep(-4.0, -16.0, z) + 0.20 * smoothstep(8.0, 20.0, z);
  height = mix(height, westPathTargetY, rawWestPath * 0.55 * heightNorthFade * (1.0 - cisternBowl));

  const entryTargetY = WATER_LEVEL + 0.04 + 0.56 * smoothstep(9.6, 17.2, z);
  height = mix(height, entryTargetY, rawEntryWalk * 0.72 * (1.0 - cisternBowl * 0.85));

  // Gentle natural shore slope meeting WATER_LEVEL cleanly without any steep mud trench
  const shorelineIn = smoothstep(3.4, 5.2, cisternRadius);
  const shorelineOut = 1.0 - smoothstep(5.4, 8.4, cisternRadius);
  const shorelineMask = shorelineIn * shorelineOut;
  const shoreTarget = WATER_LEVEL - 0.12 + 0.50 * smoothstep(4.2, 7.3, cisternRadius);
  height = mix(height, shoreTarget, shorelineMask * 0.30 * (1.0 - rawPathMask * 0.35));

  // Open sunlit south sandy entry apron sloping evenly down into clear foreground water
  const frontSwale =
    smoothstep(7.0, 9.6, z) *
    (1.0 - smoothstep(12.2, 16.5, z)) *
    Math.exp(-Math.pow((x - 0.15) / 5.4, 2.0));
  const swaleTarget = WATER_LEVEL + 0.015 + 0.50 * smoothstep(8.2, 15.0, z);
  height = mix(height, Math.min(height, swaleTarget), frontSwale * 0.82 * (1.0 - cisternBowl * 0.78));

  const rockMask = clamp(smoothstep(3.6, 7.4, flankDrift) * (1.0 - ergBlend * 0.72), 0.0, 1.0);

  const nearCistern = 1.0 - smoothstep(5.4, 9.8, cisternRadius);
  const waterDepth = cisternBowl > 0.04 ? Math.max(0.0, WATER_LEVEL - height) : 0.0;
  const moisture = clamp(
    nearCistern * (1.0 - smoothstep(WATER_LEVEL - 0.04, WATER_LEVEL + 0.16, height)) * 0.88,
    0.0,
    1.0
  );

  // Wind-sorted Mélange spice mineral seams in leeward slip-aprons, interdune troughs & around Spice Blow crater
  const windU = x * 0.913 + z * 0.408;
  const windV = -x * 0.408 + z * 0.913;
  const spiceNoise = fbm2(windU * 0.024 + 23.1, windV * 0.088 - 14.7, 3);
  const troughLeeBias = clamp(
    (1.0 - smoothstep(0.18, 0.56, combinedCrest)) * (0.45 + 0.55 * prof1.slipMask),
    0.0,
    1.0
  );
  const spiceBlowDeposit = Math.exp(-Math.pow(distSpice / 18.0, 2.0)) * 0.85;
  const spiceRichness = clamp(
    (smoothstep(0.56, 0.82, spiceNoise) * troughLeeBias + spiceBlowDeposit) *
      ergBlend *
      (1.0 - rockMask),
    0.0,
    1.0
  );

  // Crisp leeward avalanche slipfaces across foreground S-curve, barchans & Star Dune massifs
  const rawSlip = clamp(
    Math.max(
      prof1.slipMask * 0.86 +
        prof2.slipMask * secondaryWeight * 0.34 +
        profStar.slipMask * 0.18 +
        starMassifSlip * 0.78,
      fgHeroSlip * 0.95
    ),
    0.0,
    1.0
  );
  const slipMaskOut = rawSlip * smoothstep(-18.0, -36.0, z);

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
