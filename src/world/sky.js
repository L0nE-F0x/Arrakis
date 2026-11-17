import * as THREE from 'three';
import { NOISE_GLSL } from '../shaders/noise.glsl.js';

const SKY_DOME_RADIUS = 920;
const KRELLN_DIST = 620;
const KRELLN_RADIUS = 32;
const ARVON_DIST = 665;
const ARVON_RADIUS = 14.5;
const PLANET_DIST = 740;
const PLANET_RADIUS = 23.5;
const CANOPUS_CORONA_DIST = 735;
const ECLIPSE_CORONA_DIST = 598;
const ECLIPSE_CORONA_HALF = 370;

const SHARED_UNIFORMS_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uMoonKrellnDir;
uniform vec3 uMoonArvonDir;
uniform vec3 uGasGiantDir;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uSunColor;
uniform float uStorm;
uniform float uEclipse;
uniform float uLightning;
uniform vec3 uLightningDir;
uniform vec2 uWindOffset;
uniform float uDustHaze;
`;

const GLSL_HELPERS = /* glsl */ `
float sq(float x) {
  return x * x;
}

float safePow(float x, float e) {
  return pow(max(1e-4, x), e);
}

// Unified orbital solar illumination direction for moons & companion ringed planet:
// - Slender, poetic ~38% sunlit crescents on Krelln & Arvon (never blown-out white lightbulbs!)
// - Matching crescent + crisp Cassini-style planetary umbral shadow across rear-right ring arc!
vec3 evalLunarSunDir(vec3 rawSunDir, float eclipseAmt) {
  vec3 slenderCrescentSun = normalize(vec3(-0.92, -0.18, -0.12));
  float highDayBlend = smoothstep(0.22, 0.58, rawSunDir.y) * (1.0 - eclipseAmt);
  return normalize(mix(slenderCrescentSun, rawSunDir, highDayBlend * 0.45));
}

vec3 evalOrbitalSunDir(vec3 rawSunDir, float eclipseAmt) {
  vec3 grazingWestSun = normalize(vec3(-0.84, -0.16, 0.52));
  float highDayBlend = smoothstep(0.22, 0.58, rawSunDir.y) * (1.0 - eclipseAmt);
  return normalize(mix(grazingWestSun, rawSunDir, highDayBlend * 0.45));
}
`;

// Unified foreground atmospheric scattering, high-altitude twilight/night airglow, eclipse twilight darkening,
// Mie aura, 22-deg halo, cirrus wisps, haboob storm deck, and warm horizon mist continuity.
// Evaluated identically on SkyDome and ALL celestial bodies so skyForeground matches bit-for-bit.
const ATMOSPHERE_GLSL = /* glsl */ `
void evalAtmosphericScatter(vec3 dir, out vec3 skyForeground, out float transmittance) {
  float up = clamp(dir.y, 0.0, 1.0);
  float moonSunAng = acos(clamp(dot(uMoonKrellnDir, uSunDir), -0.99999, 0.99999));
  float eclipseTotality = smoothstep(0.072, 0.012, moonSunAng) * smoothstep(0.08, 0.38, uEclipse);
  float daySun = smoothstep(-0.04, 0.16, uSunDir.y) * (1.0 - eclipseTotality);
  float noonWarm = smoothstep(0.16, 0.48, uSunDir.y) * (1.0 - eclipseTotality);

  float horizonPow = mix(3.15, 4.45, noonWarm);
  horizonPow = mix(horizonPow, 1.72, uStorm);
  horizonPow = mix(horizonPow, 5.8, eclipseTotality * 0.88);
  float horizonGrad = safePow(1.0 - up, horizonPow);

  vec3 noonCobalt = vec3(0.028, 0.132, 0.445);
  vec3 zenithCol = mix(uZenithColor, noonCobalt, noonWarm * 0.78);
  zenithCol = mix(zenithCol, vec3(0.012, 0.016, 0.056), eclipseTotality * 0.88);
  vec3 midViolet = vec3(0.026, 0.016, 0.056);
  zenithCol = mix(zenithCol, midViolet, eclipseTotality * smoothstep(0.55, 0.08, up) * 0.42);
  vec3 horizonCol = mix(uHorizonColor, mix(uHorizonColor, vec3(0.96, 0.72, 0.40), 0.35), noonWarm);
  horizonCol = mix(horizonCol, uHorizonColor * vec3(0.76, 0.56, 0.48), eclipseTotality * 0.58);

  // Exact scene.fog color at distant terrain ridges (mix(uHorizonColor, uZenithColor, 0.12) + lightning tint)
  vec3 terrainFogCol = mix(uHorizonColor, uZenithColor, 0.12);
  terrainFogCol = mix(terrainFogCol, vec3(0.48, 0.62, 1.0), min(0.42, uLightning * 0.22));

  // Bridge clear noon cobalt through desert cerulean into bright warm ochre-gold horizon dust (zero dingy grey)
  vec3 clearSky = mix(zenithCol, horizonCol, horizonGrad);
  vec3 midCerulean = vec3(0.16, 0.37, 0.68);
  vec3 noonSky = mix(zenithCol, midCerulean, smoothstep(0.0, 0.44, horizonGrad));
  noonSky = mix(noonSky, horizonCol, smoothstep(0.32, 1.0, horizonGrad));
  vec3 sky = mix(clearSky, noonSky, noonWarm * (1.0 - uStorm));

  // Subtle suspended golden desert dust belt peaking softly above terrain ridges
  float dustBelt = smoothstep(0.16, 0.015, up) * smoothstep(-0.02, 0.035, up);
  vec3 creamyDust = mix(horizonCol, vec3(0.90, 0.73, 0.48), 0.24 + 0.24 * noonWarm);
  sky = mix(sky, creamyDust, dustBelt * (0.14 + 0.22 * noonWarm) * daySun * (1.0 - uStorm * 0.65));

  float sunCos = clamp(dot(dir, uSunDir), -1.0, 1.0);
  float sunAng = acos(clamp(sunCos, -0.99999, 0.99999));
  float sunAbove = smoothstep(-0.18, 0.08, uSunDir.y);
  float sunsetLow = exp(-sq((uSunDir.y - 0.015) / 0.145));
  float eclipseAtten = (1.0 - uEclipse * 0.86) * (1.0 - eclipseTotality * 0.92);

  // Azimuthal warm solar sky scatter
  sky += uSunColor * (0.044 * safePow(sunCos, 2.6) * (1.0 - up * 0.68) * sunAbove * (1.0 - uStorm * 0.72) * eclipseAtten);

  // Smooth ground-bounce blend below geometric horizon
  if (dir.y < 0.0) {
    float below = smoothstep(0.0, -0.22, dir.y);
    sky = mix(sky, terrainFogCol * 0.88, below);
  }

  // Dusty-ochre Mie forward-scattering aura around Canopus (gentle horizon continuity, no flat saucer clip)
  float horizonMieDamp = mix(0.84, 1.0, smoothstep(0.0, 0.08, up));
  float g1 = 0.72;
  float mieWide = (1.0 - g1 * g1) / pow(max(0.10, 1.0 + g1 * g1 - 2.0 * g1 * sunCos), 1.5);
  float g2 = 0.86;
  float mieTight = (1.0 - g2 * g2) / pow(max(0.045, 1.0 + g2 * g2 - 2.0 * g2 * sunCos), 1.5);
  float expHalo = exp(-sunAng * 16.0) * 0.26 + exp(-sunAng * 46.0) * 0.44;
  vec3 mieTint = mix(uSunColor, vec3(1.0, 0.46, 0.22), sunsetLow * 0.65);
  sky += mieTint * (mieWide * mix(0.020, 0.011, noonWarm) + mieTight * 0.012 + expHalo) * sunAbove * eclipseAtten * horizonMieDamp * (1.0 - uStorm * 0.65);

  // Crimson / copper sunset limb glow gently elevated above the horizon mist seam
  float limbBand = exp(-abs(dir.y - 0.024) * 14.0) * smoothstep(-0.01, 0.045, dir.y);
  float sunAzimGlow = safePow(sunCos * 0.5 + 0.5, 3.0);
  sky += vec3(0.50, 0.17, 0.08) * limbBand * (0.28 + 0.72 * sunAzimGlow) * sunsetLow * (1.0 - uStorm * 0.55) * (1.0 - uEclipse * 0.75);

  // 22-degree ice-dust sun-dog halo aureole & parhelia
  float haloRing = exp(-sq((sunCos - 0.9272) / 0.015));
  float elevMatch = exp(-sq((dir.y - uSunDir.y) / 0.045));
  float parhelia = haloRing * (0.20 + 0.80 * elevMatch);
  vec3 haloCol = mix(vec3(1.0, 0.64, 0.38), vec3(1.0, 0.90, 0.76), smoothstep(0.912, 0.942, sunCos));
  sky += haloCol * parhelia * 0.08 * sunAbove * (1.0 - uStorm * 0.92) * (1.0 - uEclipse * 0.96);

  // Lunar umbra shadow column shifting gently across wide totality sky (no dark bruised circle behind corona)
  if (eclipseTotality > 0.005) {
    float umbraCone = exp(-sq(sunAng / 0.46));
    vec3 umbraZenith = vec3(0.014, 0.018, 0.044);
    sky = mix(sky, umbraZenith, eclipseTotality * umbraCone * 0.42);
  }

  // Subtle high-altitude twilight scatter & nocturnal atmospheric airglow (physically in front of moons & stars)
  float airglowGate = (1.0 - smoothstep(-0.08, 0.14, uSunDir.y)) * (1.0 - uStorm * 0.85) * (1.0 - eclipseTotality * 0.88);
  if (airglowGate > 0.002 && dir.y > -0.02) {
    float altBand = smoothstep(-0.02, 0.34, up);
    vec3 airglowTint = mix(vec3(0.0065, 0.0055, 0.0125), vec3(0.0045, 0.0072, 0.0155), altBand);
    sky += airglowTint * airglowGate * smoothstep(-0.02, 0.08, dir.y);
  }

  // Curved planetary cloud-shell projection (avoids horizon infinity singularity)
  float rayY = max(dir.y, 0.012);
  float tHigh = -48.0 * rayY + sqrt(2304.0 * rayY * rayY + 136.0);
  vec2 uvHigh = dir.xz * tHigh * 0.23;
  float horizonFade = smoothstep(-0.015, 0.11, dir.y);

  // Layer 1: High-altitude domain-warped FBM cirrus wisps
  vec2 wHigh = uWindOffset * 0.26;
  vec2 warp = vec2(
    fbm2(uvHigh * 0.65 + wHigh),
    fbm2(uvHigh * 0.65 + vec2(4.7, 9.1) + wHigh)
  );
  float fil1 = fbm2(uvHigh * vec2(0.85, 2.2) + warp * 1.4 + wHigh * 1.15);
  float fil2 = fbm2(uvHigh * vec2(1.9, 4.1) - warp * 0.85 + wHigh * 1.45);
  float cirrusRaw = fil1 * 0.70 + fil2 * 0.30;
  float cirrusDens = smoothstep(0.53, 0.87, cirrusRaw) * horizonFade;

  float cirrusOcc = fbm2((uvHigh + uSunDir.xz * 0.13) * vec2(0.85, 2.2) + warp * 1.4 + wHigh * 1.15);
  float cirrusEdge = clamp((cirrusRaw - cirrusOcc) * 3.2 + 0.35, 0.0, 1.0);

  vec3 cirrusNoon = mix(vec3(0.46, 0.58, 0.76), vec3(1.0, 0.96, 0.88), cirrusEdge);
  vec3 cirrusDay = mix(horizonCol * 0.72 + vec3(0.10), uSunColor * 0.90 + vec3(0.14, 0.12, 0.10), cirrusEdge);
  cirrusDay = mix(cirrusDay, cirrusNoon, noonWarm * 0.78);
  vec3 cirrusSunset = mix(vec3(0.32, 0.14, 0.16), vec3(0.85, 0.36, 0.20), cirrusEdge);
  vec3 cirrusNight = mix(vec3(0.014, 0.020, 0.042), vec3(0.042, 0.056, 0.088), cirrusEdge);
  vec3 cirrusCol = mix(cirrusNight, cirrusDay, sunAbove);
  cirrusCol = mix(cirrusCol, cirrusSunset, sunsetLow * 0.88);
  vec3 cirrusEclipse = mix(vec3(0.016, 0.018, 0.048), vec3(0.068, 0.044, 0.052), cirrusEdge);
  cirrusCol = mix(cirrusCol, cirrusEclipse, eclipseTotality * 0.90);
  if (eclipseTotality > 0.005) {
    float umbraCirrusCone = exp(-sq(sunAng / 0.16));
    cirrusCol = mix(cirrusCol, vec3(0.012, 0.016, 0.044), eclipseTotality * umbraCirrusCone * 0.72);
  }
  cirrusCol += uSunColor * safePow(sunCos, 8.0) * 0.20 * sunAbove * eclipseAtten;

  // Layer 2: Coriolis / Haboob Storm Cloud Deck
  float tLow = -48.0 * rayY + sqrt(2304.0 * rayY * rayY + 82.0);
  vec2 uvLow = dir.xz * tLow * 0.31;
  vec2 wLow = uWindOffset * 0.62;
  vec2 sWarp = vec2(
    fbm2(uvLow * 0.55 + wLow),
    fbm2(uvLow * 0.55 + vec2(8.3, 2.9) + wLow)
  );
  float billowA = fbm2(uvLow * 0.92 + sWarp * 1.55 + wLow * 1.2);
  float billowB = 1.0 - abs(vnoise2(uvLow * 2.35 + sWarp * 1.1 + wLow * 1.65) * 2.0 - 1.0);
  float billow = mix(billowA, billowB, 0.34);

  float stormBlend = smoothstep(0.02, 0.40, uStorm);
  float stormThresh = mix(0.92, 0.22, smoothstep(0.04, 0.94, uStorm));
  float stormDens = smoothstep(stormThresh, stormThresh + 0.35, billow) * stormBlend * smoothstep(-0.04, 0.07, dir.y);

  float stormOcc = fbm2((uvLow + uSunDir.xz * 0.16) * 0.92 + sWarp * 1.55 + wLow * 1.2);
  float stormLit = clamp(0.16 + 0.84 * (billow - stormOcc * 0.68 + 0.32), 0.0, 1.0);
  vec3 stormDark = mix(vec3(0.032, 0.020, 0.014), vec3(0.11, 0.058, 0.030), sunAbove);
  vec3 stormBright = mix(vec3(0.16, 0.09, 0.055), horizonCol * 0.82 + uSunColor * 0.18, sunAbove);
  vec3 stormCol = mix(stormDark, stormBright, stormLit);

  if (uLightning > 0.001 && uStorm > 0.03) {
    float boltDist = length(dir - uLightningDir);
    float cellCore = exp(-boltDist * boltDist * 10.5);
    float cellHalo = exp(-boltDist * boltDist * 2.4) * 0.28;
    float crackle = safePow(1.0 - abs(vnoise2(uvLow * 5.4 + sWarp * 2.3) * 2.0 - 1.0), 5.0);
    float thinGap = smoothstep(0.95, 0.28, billow) * 0.72 + 0.28;
    vec3 boltTint = mix(vec3(1.42, 0.88, 0.46), vec3(1.25, 1.16, 1.55), cellCore);
    stormCol += boltTint * uLightning * (cellCore * (0.70 + 0.95 * crackle) + cellHalo) * thinGap * (0.30 + 0.70 * uStorm);
  }

  float cirrusAlpha = cirrusDens * mix(0.46, 0.24, eclipseTotality) * (1.0 - stormDens * 0.72);
  float stormAlpha = stormDens * 0.93;
  float cloudCover = clamp(cirrusAlpha + stormAlpha, 0.0, 0.96);

  vec3 cloudCol = mix(cirrusCol, stormCol, clamp(stormDens * 1.18, 0.0, 1.0));
  vec3 atmForeground = mix(sky, cloudCol, cloudCover);

  // Soft warm horizon desert dust mist along dir.y in [0.0, 0.16] so terrain fog ridges melt seamlessly
  float lowBand = smoothstep(0.16, 0.0, max(dir.y, 0.0));
  float calmDust = lowBand * lowBand * (0.42 + 0.58 * exp(-max(dir.y, 0.0) * 14.0)) * 0.90;
  float stormDust = exp(-max(dir.y, 0.0) * 6.0) * 0.98;
  float lowDust = mix(calmDust, stormDust, uStorm);
  float hazeExt = uDustHaze * lowBand * lowBand * 0.36;
  float noonDustExt = noonWarm * lowBand * lowBand * 0.20;
  lowDust = clamp(lowDust + hazeExt + noonDustExt, 0.0, 0.98);

  vec3 warmMistCol = mix(terrainFogCol, horizonCol, 0.22 * (1.0 - lowBand * 0.72));
  warmMistCol += uSunColor * (0.032 * safePow(sunCos, 3.0) * sunAbove * eclipseAtten * (1.0 - lowBand * 0.65));
  vec3 dustVeilCol = mix(warmMistCol, horizonCol, uStorm * 0.55) + vec3(1.15, 0.72, 0.42) * uLightning * 0.14 * uStorm;

  float mistMix = clamp(lowDust * mix(0.88, 0.95, lowBand), 0.0, 0.96);
  atmForeground = mix(atmForeground, dustVeilCol, mistMix);

  // Gently broaden totality lunar umbra scatter column without painting a dark bruise ring around the corona
  if (eclipseTotality > 0.005) {
    float umbraColumn = exp(-sq(sunAng / 0.48));
    vec3 umbraShadowCol = mix(vec3(0.012, 0.016, 0.040), vec3(0.026, 0.018, 0.034), lowBand * 0.65);
    atmForeground = mix(atmForeground, umbraShadowCol, eclipseTotality * umbraColumn * mix(0.36, 0.28, lowBand));
  }

  transmittance = (1.0 - cloudCover * 0.92) * (1.0 - lowDust);
  // Subtle shared fragment dither kills concentric dusk banding identically on SkyDome & unlit discs
  float atmDither = (hash12(gl_FragCoord.xy) - 0.5) * 0.0026;
  skyForeground = max(vec3(0.0), atmForeground + atmDither);
}
`;

// Multi-magnitude twinkling 3D starfield & crisp starry Milky Way dust lanes
const STARFIELD_GLSL = /* glsl */ `
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

vec3 starLayer(vec3 dir, float scale, float threshold, float sizeScale, float horizonWash) {
  // Subtle celestial rotation keeps random star cells clear of lunar limb grazing artifacts
  float cs = 0.98877;
  float sn = 0.14944;
  vec3 rDir = vec3(dir.x * cs - dir.z * sn, dir.y, dir.x * sn + dir.z * cs);
  vec3 p = rDir * scale;
  vec3 id = floor(p);
  vec3 f = fract(p) - 0.5;
  vec3 rnd = hash33(id);
  if (rnd.z < threshold) return vec3(0.0);

  // Constrain cell offset so subpixel PSF fits cleanly inside voxel bounds
  vec3 offset = (rnd - 0.5) * 0.24;
  float d = length(f - offset);
  float mag = (rnd.z - threshold) / (1.0 - threshold);

  // Subpixel astrophotography PSF: razor-sharp 0.5-1px faint/mid pinpoints, ~1.2px core on brightest beacons
  float cellPx = clamp(max(length(dFdx(p)), length(dFdy(p))), 0.018, 0.36);
  float brightTier = smoothstep(0.66, 1.0, mag);
  float sigma = max(0.008 * sizeScale, max(cellPx * 0.25, cellPx * mix(0.26, 0.40, safePow(mag, 2.0)) * sizeScale));
  float coreCut = min(0.35, sigma * 3.8);
  float core = exp(-0.5 * sq(d / sigma)) * (1.0 - smoothstep(coreCut * 0.55, coreCut, d));

  // Delicate colored optical PSF wing strictly on brightest 1st-magnitude beacon stars
  float psfR = max(sigma * 1.70, cellPx * mix(0.54, 0.84, brightTier));
  float psfGlow = exp(-d / max(0.008, psfR)) * (1.0 - smoothstep(0.20, 0.35, d)) * brightTier * 0.16;

  // Deep astronomical magnitude hierarchy from delicate faint dust pinpoints to brilliant colored beacons
  float lum = mix(0.06, 1.85, safePow(mag, 3.25)) + safePow(mag, 7.2) * 0.85;

  // Atmospheric scintillation increases near the desert horizon
  float twinkleFreq = 1.6 + rnd.x * 3.8;
  float twinkle = 1.0 + sin(uTime * twinkleFreq + rnd.y * 62.8318) * mix(0.04, 0.20, 1.0 - horizonWash);

  // Rich O/B/A sapphire-blue-white -> F/G ivory -> K/M warm amber-gold blackbody spectral tints
  float temp = fract(rnd.x * 19.73 + rnd.y * 7.13);
  vec3 obaBlue     = vec3(0.46, 0.74, 1.44);
  vec3 aVegaIce    = vec3(0.84, 0.94, 1.20);
  vec3 fgIvory     = vec3(1.04, 0.98, 0.88);
  vec3 kArcturus   = vec3(1.26, 0.88, 0.42);
  vec3 mBetelAmber = vec3(1.44, 0.66, 0.26);

  vec3 starCol = mix(obaBlue, aVegaIce, smoothstep(0.0, 0.28, temp));
  starCol = mix(starCol, fgIvory, smoothstep(0.28, 0.54, temp));
  starCol = mix(starCol, kArcturus, smoothstep(0.54, 0.80, temp));
  starCol = mix(starCol, mBetelAmber, smoothstep(0.80, 1.0, temp));

  // Preserve rich spectral hue in bright stars (avoid ACES whiteout) while keeping tight pinpoint cores
  vec3 coreTint = mix(starCol, mix(starCol, vec3(1.0), 0.20), brightTier * 0.45);
  return (coreTint * core * lum + starCol * psfGlow * (0.45 + 0.65 * lum)) * twinkle;
}

vec3 evalMilkyWayDust(vec3 dir, out float bandMask, out float dustOcclude) {
  // Orient galactic band gracefully across the upper-left / zenith-center sky, clear of moon & planet arcs
  vec3 galNormal = normalize(vec3(-0.32, 0.80, 0.50));
  vec3 rawCore = vec3(-0.42, 0.34, -0.84);
  vec3 coreDir = normalize(rawCore - galNormal * dot(rawCore, galNormal));
  vec3 galV = normalize(cross(galNormal, coreDir));

  float galLat = dot(dir, galNormal);
  float band = exp(-galLat * galLat * 36.0);
  float coreGlow = safePow(max(0.0, dot(dir, coreDir)), 2.2);

  // Stretched galactic-plane coordinates: elongated along galactic tangent (u), compressed across latitude (v)
  vec2 galXY = vec2(dot(dir, coreDir), dot(dir, galV));
  vec2 galTang = vec2(-galXY.y, galXY.x);
  vec3 pGal = vec3(galXY * 2.45, galLat * 8.2);

  // Smooth tangential advection warp prevents isotropic blob/bubble cells
  float warpAlong = fbm3(pGal * vec3(0.85, 0.85, 1.15) + vec3(1.7, 4.3, -2.5)) - 0.5;
  float warpAcross = fbm3(pGal * vec3(1.15, 1.15, 1.35) + vec3(-3.8, 1.9, 5.2)) - 0.5;
  vec3 streamShift = vec3(galTang * (warpAlong * 1.15), warpAcross * 0.85);
  vec3 fCoord = pGal + streamShift;

  // Directional multi-octave FBM star-cloud filaments stretched seamlessly along the galactic band
  float filMacro = fbm3(fCoord * vec3(1.15, 1.15, 1.45) + vec3(2.1, -1.4, 3.3));
  float filMid   = fbm3(fCoord * vec3(2.55, 2.55, 3.20) - streamShift * 0.55 + vec3(-4.2, 3.1, 0.7));
  float filFine  = fbm3(fCoord * vec3(5.60, 5.60, 6.80) + streamShift * 0.35 + vec3(5.4, -2.6, 1.8));

  float cloudRaw = filMacro * 0.52 + filMid * 0.33 + filFine * 0.15;
  float starCloudBase = smoothstep(0.24, 0.68, cloudRaw);
  float wispyVeil = smoothstep(0.32, 0.72, filMacro * 0.62 + filMid * 0.38);
  float brightStream = safePow(smoothstep(0.42, 0.76, filMid * 0.55 + filMacro * 0.45), 1.35);
  float starCloud = mix(0.24, 1.05, starCloudBase) + wispyVeil * 0.28 + brightStream * 0.32;

  // Subtle unresolved pinpoint star-cloud micro-shimmer inside dense galactic clouds (Nyquist-guarded)
  vec3 microP = dir * 210.0;
  float microPx = max(length(dFdx(microP)), length(dFdy(microP)));
  float microNyq = exp(-sq(microPx * 1.15));
  float microGrain = vnoise3(microP + streamShift * 2.0);
  float microPin = smoothstep(0.56, 0.90, microGrain) * microNyq;
  float shimmerPulse = 0.85 + 0.15 * sin(uTime * 1.8 + microGrain * 31.4);
  starCloud *= 1.0 + microPin * 0.24 * shimmerPulse * smoothstep(0.25, 0.75, starCloudBase);

  // Broad undulating Great Rift & soft dark nebula clouds (smoothstep gentle attenuation, zero cell edges)
  float riftWarp = (fbm3(pGal * vec3(0.90, 0.90, 1.10) + vec3(3.1, -2.2, 1.7)) - 0.5) * 1.65
                 + (fbm3(pGal * vec3(2.10, 2.10, 2.40) - vec3(1.9, 4.6, -3.3)) - 0.5) * 0.65;
  float riftLat = galLat * 12.5 + riftWarp;
  float mainRift = exp(-riftLat * riftLat * 2.8);
  float forkShift = (fbm3(pGal * vec3(1.30, 1.30, 1.60) + vec3(-4.1, 2.7, 3.8)) - 0.5) * 1.2;
  float forkRift = exp(-sq((riftLat - 1.55 + forkShift) * 1.55)) * 0.65;

  float riftDensityMod = smoothstep(0.24, 0.70, fbm3(fCoord * vec3(1.10, 1.10, 1.80) + vec3(4.9, -2.3, 6.7)));
  float broadDustPatch = smoothstep(0.38, 0.76, fbm3(fCoord * vec3(1.50, 1.50, 2.90) + vec3(-2.6, 5.1, -3.4)))
                       * exp(-galLat * galLat * 28.0);
  float darkDust = clamp(max(mainRift, forkRift) * mix(0.45, 1.0, riftDensityMod) * 0.68 + broadDustPatch * 0.42, 0.0, 0.72);

  vec3 coolDust = vec3(0.011, 0.019, 0.044);
  vec3 warmCore = vec3(0.042, 0.030, 0.052);
  vec3 knotTint = vec3(0.052, 0.048, 0.078);
  vec3 dustCol = mix(coolDust, warmCore, coreGlow * 0.74 + filMid * 0.26);
  dustCol = mix(dustCol, knotTint, brightStream * 0.52);

  // Keep Milky Way cleanly in upper cobalt sky, clear of bright dusk horizons
  float horizonFade = smoothstep(0.11, 0.28, dir.y);
  float riftExtinction = mix(1.0, 0.34, darkDust);
  float density = band * starCloud * riftExtinction * (0.42 + 0.74 * coreGlow);
  vec3 milkyWay = dustCol * density * horizonFade;

  bandMask = band * (0.18 + 0.74 * starCloudBase + 0.28 * brightStream) * (1.0 - darkDust * 0.74) * smoothstep(0.10, 0.26, dir.y);
  dustOcclude = clamp(darkDust * band * horizonFade * 0.78, 0.0, 0.66);
  return milkyWay;
}

vec3 evalNightSky(vec3 dir) {
  float nightVis = 1.0 - smoothstep(-0.14, 0.06, uSunDir.y);
  float moonSunAng = acos(clamp(dot(uMoonKrellnDir, uSunDir), -0.99999, 0.99999));
  float eclipseReveal = (1.0 - smoothstep(0.014, 0.072, moonSunAng)) * smoothstep(0.14, 0.72, uEclipse);
  float starVis = clamp(max(nightVis, eclipseReveal * 0.92) * (1.0 - uStorm * 0.92), 0.0, 1.0);
  if (starVis < 0.002 || dir.y < -0.02) return vec3(0.0);

  // Delicate galactic whisper emerges in upper cobalt twilight once Canopus drops well below horizon,
  // while remaining suppressed during solar eclipse totality & shallow dusk
  float milkyWayVis = clamp(nightVis * smoothstep(-0.02, -0.15, uSunDir.y) * (1.0 - eclipseReveal * 0.98) * (1.0 - uStorm * 0.95), 0.0, 1.0);

  float bandBoost = 0.0;
  float dustOcclude = 0.0;
  vec3 milkyWay = vec3(0.0);
  if (milkyWayVis > 0.002) {
    milkyWay = evalMilkyWayDust(dir, bandBoost, dustOcclude) * milkyWayVis;
  }

  // Multi-magnitude razor-sharp pinpoint star layers + dense resolved Milky Way star-clouds
  float heroWash = smoothstep(0.006, 0.14, dir.y);
  float midWash = smoothstep(0.025, 0.24, dir.y);
  float faintWash = smoothstep(0.05, 0.34, dir.y);

  vec3 stars = vec3(0.0);
  stars += starLayer(dir, 42.0, 0.942, 1.02, heroWash) * heroWash * 1.50;
  stars += starLayer(dir, 96.0, 0.875, 0.96, midWash) * midWash * 0.58;
  stars += starLayer(dir, 174.0, mix(0.840, 0.340, bandBoost * milkyWayVis), 0.92, faintWash) * faintWash * (0.24 + 0.52 * bandBoost * milkyWayVis);
  if (milkyWayVis > 0.01 && bandBoost > 0.01) {
    stars += starLayer(dir, 260.0, mix(0.95, 0.18, bandBoost), 0.88, faintWash) * faintWash * bandBoost * milkyWayVis * 0.58;
  }

  // Extinction lanes inside Milky Way naturally dim background field stars behind dark dust rifts
  stars *= mix(1.0, 0.18, dustOcclude * milkyWayVis);

  // Damp stars inside inner solar/coronal glare around Canopus
  float sunGlareDamp = 1.0 - smoothstep(0.95, 0.999, dot(dir, uSunDir)) * mix(1.0, 0.75, eclipseReveal);
  return milkyWay + stars * sunGlareDamp * starVis;
}
`;

// 3D Voronoi planetary/lunar craters with raised rims, bowls, central peaks & normal perturbation
const CRATERS_GLSL = /* glsl */ `
vec2 voronoiCraterLayer(vec3 p, float scale) {
  vec3 sp = p * scale;
  vec3 ip = floor(sp);
  vec3 fp = fract(sp);
  float minD = 8.0;
  float cellRnd = 0.0;

  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 cell = ip + g;
        vec3 rnd = vec3(
          hash13(cell),
          hash13(cell + vec3(19.3, 47.1, 11.7)),
          hash13(cell + vec3(73.9, 5.3, 31.1))
        );
        vec3 diff = g + rnd * 0.72 + 0.14 - fp;
        float d = length(diff);
        if (d < minD) {
          minD = d;
          cellRnd = rnd.x;
        }
      }
    }
  }

  float r = mix(0.18, 0.44, cellRnd);
  float normD = minD / r;
  float h = 0.0;
  float rimBright = 0.0;

  if (normD < 1.35) {
    float bowl = -max(0.0, 1.0 - normD * normD) * 0.65;
    float rim = exp(-sq((normD - 0.98) / 0.16)) * 0.44;
    float peak = exp(-normD * normD * 34.0) * step(0.58, cellRnd) * 0.24;
    h = bowl + rim + peak;
    rimBright = rim * 1.4;
  }
  return vec2(h, rimBright);
}

float evalCraterHeight(vec3 n, out float ejecta) {
  vec2 c1 = voronoiCraterLayer(n, 4.6);
  vec2 c2 = voronoiCraterLayer(n + vec3(1.7, 3.1, -2.3), 10.5);
  vec2 c3 = voronoiCraterLayer(n + vec3(-4.2, 1.3, 5.1), 22.0);
  float regolith = (fbm3(n * 32.0) - 0.5) * 0.14 + (fbm3(n * 74.0) - 0.5) * 0.06;
  ejecta = clamp(c1.y * 0.65 + c2.y * 0.45 + c3.y * 0.25, 0.0, 1.0);
  return c1.x * 0.55 + c2.x * 0.30 + c3.x * 0.15 + regolith;
}

vec3 perturbLunarNormal(vec3 localN, vec3 basisX, vec3 basisY, vec3 basisZ, float strength, out float ejecta) {
  float h0 = evalCraterHeight(localN, ejecta);
  if (strength < 0.001) {
    return normalize(basisX * localN.x + basisY * localN.y + basisZ * localN.z);
  }
  float eps = 0.014;
  float dummy;
  vec3 upAxis = abs(localN.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tLocal = normalize(cross(upAxis, localN));
  vec3 bLocal = normalize(cross(localN, tLocal));
  float hx = evalCraterHeight(normalize(localN + tLocal * eps), dummy);
  float hy = evalCraterHeight(normalize(localN + bLocal * eps), dummy);

  vec3 gradLocal = tLocal * ((hx - h0) / eps) + bLocal * ((hy - h0) / eps);
  vec3 perturbedLocal = normalize(localN - gradLocal * strength);
  return normalize(basisX * perturbedLocal.x + basisY * perturbedLocal.y + basisZ * perturbedLocal.z);
}
`;

// Natural, heavily fractured, mottled volcanic basalt maria & rayed impact ejecta on Krelln
const MUADDIB_GLSL = /* glsl */ `
float worleyMare3(vec3 p) {
  vec3 ip = floor(p);
  vec3 fp = fract(p);
  float minD = 8.0;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 cell = ip + g;
        vec3 rnd = vec3(
          hash13(cell + vec3(3.1, 7.7, 1.9)),
          hash13(cell + vec3(19.3, 47.1, 11.7)),
          hash13(cell + vec3(73.9, 5.3, 31.1))
        );
        float d = length(g + rnd * 0.78 + 0.11 - fp);
        minD = min(minD, d);
      }
    }
  }
  return clamp(minD, 0.0, 1.4);
}

float mareBasin(vec3 n, vec3 centerDir, float rad, float warpAmt, float seed) {
  vec3 c = normalize(centerDir);
  vec3 w = n + vec3(
    fbm3(n * 4.2 + vec3(seed, 1.3, 2.7)) - 0.5,
    fbm3(n * 4.2 + vec3(5.1, seed, -1.9)) - 0.5,
    fbm3(n * 4.2 + vec3(-2.4, 3.8, seed)) - 0.5
  ) * warpAmt;
  float angDist = length(w - c * dot(w, c)) + max(0.0, -dot(w, c)) * 1.5;
  float edgeNoise = (fbm3(n * 9.5 + vec3(seed * 2.1)) - 0.5) * 0.14
                  + (worleyMare3(n * 6.8 + vec3(seed)) - 0.45) * 0.16;
  return smoothstep(rad + 0.16, rad - 0.14, angDist + edgeNoise);
}

float evalImpactRays(vec3 n) {
  vec3 r1 = normalize(vec3(0.28, 0.24, 0.93));
  vec3 up1 = normalize(cross(vec3(0.0, 1.0, 0.0), r1));
  vec3 right1 = cross(r1, up1);
  vec2 d1 = vec2(dot(n, right1), dot(n, up1));
  float rad1 = length(d1);
  float ang1 = atan(d1.y, d1.x);
  float rays1 = safePow(fbm2(vec2(cos(ang1) * 5.5, sin(ang1) * 5.5) + d1 * 3.8), 2.4)
              * exp(-rad1 * 3.1) * smoothstep(0.02, 0.06, rad1) * step(0.0, dot(n, r1));

  vec3 r2 = normalize(vec3(-0.34, -0.26, 0.90));
  vec3 up2 = normalize(cross(vec3(0.0, 1.0, 0.0), r2));
  vec3 right2 = cross(r2, up2);
  vec2 d2 = vec2(dot(n, right2), dot(n, up2));
  float rad2 = length(d2);
  float ang2 = atan(d2.y, d2.x);
  float rays2 = safePow(fbm2(vec2(cos(ang2) * 4.8 + 3.2, sin(ang2) * 4.8) + d2 * 4.2), 2.6)
              * exp(-rad2 * 3.6) * smoothstep(0.02, 0.055, rad2) * step(0.0, dot(n, r2));

  return clamp(rays1 * 1.1 + rays2 * 0.95, 0.0, 1.0);
}

float evalMuadDibMare(vec3 localN) {
  float fbmBroad = fbm3(localN * 3.4 + vec3(1.2, -0.8, 2.3));
  float fbmFine = fbm3(localN * 11.5 + vec3(-3.1, 2.4, 0.7));
  float cellCrack = worleyMare3(localN * 8.2 + vec3(2.9, -1.7, 4.1));

  float globalSeas = smoothstep(0.52, 0.80, fbmBroad) * 0.52;

  // Iconic geological Muad'Dib (crouched desert kangaroo mouse) dark basalt mare basins on Krelln's near hemisphere:
  // Arched body, head facing west-left (-x), two swept-back tall ears, kangaroo haunch, and curled tufted tail (+x)
  float bodyHaunch = mareBasin(localN, vec3(0.08, -0.10, 0.99), 0.23, 0.16, 1.7);
  float chestHead  = mareBasin(localN, vec3(-0.19, 0.04, 0.98), 0.16, 0.14, 4.3);
  float snoutTip   = mareBasin(localN, vec3(-0.33, 0.01, 0.94), 0.085, 0.12, 6.1);
  float earBack    = mareBasin(localN, vec3(-0.10, 0.30, 0.95), 0.115, 0.13, 7.9);
  float earFront   = mareBasin(localN, vec3(-0.22, 0.27, 0.94), 0.095, 0.12, 11.2);
  float hindFoot   = mareBasin(localN, vec3(-0.04, -0.30, 0.95), 0.10, 0.14, 13.5);
  float tailArcA   = mareBasin(localN, vec3(0.32, -0.18, 0.93), 0.105, 0.16, 15.4);
  float tailArcB   = mareBasin(localN, vec3(0.46, 0.02, 0.89), 0.085, 0.14, 19.1);
  float tailTuft   = mareBasin(localN, vec3(0.42, 0.20, 0.88), 0.095, 0.13, 22.8);

  float muadDibFigure = max(
    max(max(bodyHaunch, chestHead), max(snoutTip, hindFoot * 0.85)),
    max(max(earBack, earFront), max(tailArcA, max(tailArcB * 0.9, tailTuft)))
  );

  float massifBreakup = smoothstep(0.36, 0.76, cellCrack * 0.50 + fbmFine * 0.50);
  float mottle = 0.56 + 0.44 * fbm3(localN * 6.8 + vec3(4.1, 1.8, -2.5));
  float combined = max(muadDibFigure * 0.96, globalSeas);
  combined *= mix(0.68, 1.0, massifBreakup) * mottle;
  return clamp(combined, 0.0, 1.0);
}
`;

function createSharedAtmUniforms() {
  return {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonKrellnDir: { value: new THREE.Vector3(0, 0.5, -1) },
    uMoonArvonDir: { value: new THREE.Vector3(0.5, 0.3, -1) },
    uGasGiantDir: { value: new THREE.Vector3(-0.5, 0.2, -1) },
    uZenithColor: { value: new THREE.Color(0x3a4a6e) },
    uHorizonColor: { value: new THREE.Color(0xe6ab7a) },
    uSunColor: { value: new THREE.Color(0xffcfa0) },
    uStorm: { value: 0 },
    uEclipse: { value: 0 },
    uLightning: { value: 0 },
    uLightningDir: { value: new THREE.Vector3(0.15, 0.38, -0.91) },
    uWindOffset: { value: new THREE.Vector2() },
    uDustHaze: { value: 0 }
  };
}

function createSkyDomeShader() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    uniforms: createSharedAtmUniforms(),
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${SHARED_UNIFORMS_GLSL}
      ${GLSL_HELPERS}
      ${NOISE_GLSL}
      ${ATMOSPHERE_GLSL}
      ${STARFIELD_GLSL}

      varying vec3 vDir;

      void main() {
        vec3 dir = normalize(vDir);

        vec3 skyForeground;
        float transmittance;
        evalAtmosphericScatter(dir, skyForeground, transmittance);

        vec3 spaceRadiance = evalNightSky(dir);

        // Crisp Canopus photosphere disc (occluded by Krelln during eclipse)
        float sunCos = clamp(dot(dir, uSunDir), -0.99999, 0.99999);
        float sunAng = acos(sunCos);
        float sunAbove = smoothstep(-0.08, 0.03, uSunDir.y);

        float moonSunAng = acos(clamp(dot(uMoonKrellnDir, uSunDir), -0.99999, 0.99999));
        float eclipseTotality = (1.0 - smoothstep(0.012, 0.068, moonSunAng)) * smoothstep(0.08, 0.38, uEclipse);

        float sunDisc = 1.0 - smoothstep(0.0155, 0.0185, sunAng);
        float sunCore = 1.0 - smoothstep(0.004, 0.0155, sunAng);
        vec3 canopusPhotosphere = uSunColor * (sunDisc * 1.45 + sunCore * 2.25) * sunAbove * (1.0 - eclipseTotality * 0.995);
        spaceRadiance += canopusPhotosphere;

        vec3 col = skyForeground + spaceRadiance * transmittance;
        gl_FragColor = vec4(col, 1.0);
      }
    `
  });
}

function createKrellnShader() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    depthTest: true,
    uniforms: createSharedAtmUniforms(),
    vertexShader: /* glsl */ `
      varying vec3 vLocalNormal;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      varying vec3 vBasisX;
      varying vec3 vBasisY;
      varying vec3 vBasisZ;
      void main() {
        vLocalNormal = normalize(normal);
        vBasisX = normalize(modelMatrix[0].xyz);
        vBasisY = normalize(modelMatrix[1].xyz);
        vBasisZ = normalize(modelMatrix[2].xyz);
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${SHARED_UNIFORMS_GLSL}
      ${GLSL_HELPERS}
      ${NOISE_GLSL}
      ${ATMOSPHERE_GLSL}
      ${CRATERS_GLSL}
      ${MUADDIB_GLSL}

      varying vec3 vLocalNormal;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      varying vec3 vBasisX;
      varying vec3 vBasisY;
      varying vec3 vBasisZ;

      void main() {
        vec3 localN = normalize(vLocalNormal);
        vec3 worldN = normalize(vWorldNormal);
        vec3 rayDir = normalize(vWorldPos - cameraPosition);
        vec3 viewDir = -rayDir;

        vec3 skyForeground;
        float transmittance;
        evalAtmosphericScatter(rayDir, skyForeground, transmittance);

        // Analytical sub-pixel anti-aliasing on exact spherical silhouette & inner terminator
        vec3 moonDir = normalize(uMoonKrellnDir);
        float rhoExact = length(cross(rayDir, moonDir)) / ${(KRELLN_RADIUS / KRELLN_DIST).toFixed(6)};
        float pxRim = clamp(length(vec2(dFdx(rhoExact), dFdy(rhoExact))), 0.006, 0.055);
        float moonSunAng = acos(clamp(dot(uMoonKrellnDir, uSunDir), -0.99999, 0.99999));
        float eclipseOccult = (1.0 - smoothstep(0.014, 0.075, moonSunAng)) * smoothstep(0.08, 0.38, uEclipse);
        float rimAA = mix(pxRim * 1.45, pxRim * 1.05, smoothstep(0.25, 0.70, eclipseOccult));
        float silAlpha = 1.0 - smoothstep(0.996 - rimAA, 0.996, rhoExact);
        if (silAlpha < 0.002) discard;
        float limbAA = silAlpha;

        float NdotV = max(0.0, dot(worldN, viewDir));
        vec3 orbitalSun = mix(evalLunarSunDir(uSunDir, uEclipse), uSunDir, eclipseOccult);
        float macroNdotL = dot(worldN, orbitalSun);
        float noonSmooth = smoothstep(0.18, 0.56, uSunDir.y);
        float bumpFade = smoothstep(0.08, 0.28, macroNdotL) * (1.0 - smoothstep(0.76, 0.95, rhoExact)) * (1.0 - noonSmooth * 0.88);

        // Subtle crater heightfield + perturbed normals (gentle 0.16 relief avoids harsh black stipple!)
        float ejecta;
        vec3 surfN = perturbLunarNormal(localN, normalize(vBasisX), normalize(vBasisY), normalize(vBasisZ), 0.16 * bumpFade, ejecta);

        // Fractured mottled volcanic basalt maria + rayed impact ejecta
        float mareMask = evalMuadDibMare(localN);
        float impactRays = evalImpactRays(localN);
        float grain = fbm3(localN * 38.0);
        float regolithDetail = clamp(0.28 + grain * 0.46 + ejecta * 0.44 + impactRays * 0.42, 0.0, 1.0);

        vec3 highlandCol = mix(vec3(0.78, 0.73, 0.67), vec3(0.96, 0.92, 0.86), regolithDetail);
        vec3 basaltCol = mix(vec3(0.22, 0.21, 0.23), vec3(0.38, 0.35, 0.34), grain * 0.55);
        vec3 albedo = mix(highlandCol, basaltCol, mareMask * (1.0 - impactRays * 0.55));

        // Strictly zero radiance whenever macroNdotL <= 0.0 so unlit lunar disc matches skyForeground bit-for-bit
        float termGrad = length(vec2(dFdx(macroNdotL), dFdy(macroNdotL)));
        float termAA = max(termGrad * 1.15, 0.024);
        float macroTerminator = smoothstep(0.0, termAA, macroNdotL);
        float macroL = max(0.0, macroNdotL);
        float macroLommel = macroL / max(0.09, macroL + max(0.03, NdotV) * 0.52);
        float macroPhase = macroTerminator * mix(macroL, macroLommel * 1.28, 0.66);

        float microL = max(0.0, dot(surfN, orbitalSun));
        float microLommel = microL / max(0.09, microL + max(0.03, NdotV) * 0.52);
        float microPhase = macroTerminator * mix(microL, microLommel * 1.28, 0.66);
        float sunlit = mix(macroPhase, microPhase, bumpFade) * limbAA;

        float dayVis = smoothstep(-0.04, 0.22, uSunDir.y);
        float duskBoost = exp(-sq((uSunDir.y - 0.03) / 0.14)) * 0.55;
        float noonGlareAtten = smoothstep(0.18, 0.56, uSunDir.y);

        vec3 sunTint = mix(
          mix(vec3(1.0, 0.97, 0.92), uSunColor, 0.26),
          mix(vec3(0.94, 0.97, 1.0), uSunColor, 0.16),
          dayVis
        );
        // Crisp non-blooming crescent at night/dusk, softly muted at dawn/golden-hour, ghost-chalk at noon!
        float sunlitGain = (mix(0.84, 0.36, dayVis) + duskBoost * 0.35) * mix(1.0, 0.18, noonGlareAtten);
        float pearlRim = smoothstep(0.0, 0.16, macroNdotL) * (0.30 + 0.70 * safePow(1.0 - NdotV, 1.35)) * limbAA;
        vec3 pearlLift = vec3(0.90, 0.94, 1.0) * pearlRim * 0.22 * dayVis * (1.0 - noonGlareAtten);
        vec3 bodyLitRadiance = (albedo * sunTint * sunlit * sunlitGain + pearlLift) * (1.0 - eclipseOccult);

        // Subtle Arrakis dust-shine illuminating Krelln's night hemisphere (revealing the Muad'Dib mare in twilight/night!)
        float nightTwilVis = (1.0 - smoothstep(-0.02, 0.16, uSunDir.y)) * (1.0 - uStorm * 0.85);
        float planetshineGeom = (0.58 + 0.42 * NdotV) * (1.0 - macroTerminator * 0.85);
        vec3 planetshineAlbedo = mix(vec3(0.28, 0.30, 0.38), albedo, 0.72);
        vec3 planetshine = planetshineAlbedo * vec3(0.036, 0.035, 0.048) * planetshineGeom * nightTwilVis * limbAA * (1.0 - eclipseOccult);

        // During totality, delicate Arrakis-shine subtly reveals Krelln's volcanic Muad'Dib maria inside the dark lunar silhouette
        vec3 skyMoonUniform = skyForeground;
        float moonTransUniform = transmittance;
        if (eclipseOccult > 0.001) {
          evalAtmosphericScatter(moonDir, skyMoonUniform, moonTransUniform);
        }
        vec3 umbraCol = vec3(0.0018, 0.0026, 0.0068);
        vec3 totalityEarthshine = albedo * vec3(0.0068, 0.0062, 0.0086) * (0.55 + 0.45 * NdotV) * limbAA;
        vec3 eclipseDiscCol = umbraCol + skyMoonUniform * 0.022 + totalityEarthshine * moonTransUniform;
        vec3 baseSkyCol = mix(skyForeground, eclipseDiscCol, eclipseOccult);
        vec3 col = baseSkyCol + (bodyLitRadiance + planetshine) * transmittance;
        gl_FragColor = vec4(col, silAlpha);
      }
    `
  });
}

function createArvonShader() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    depthTest: true,
    uniforms: createSharedAtmUniforms(),
    vertexShader: /* glsl */ `
      varying vec3 vLocalNormal;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      varying vec3 vBasisX;
      varying vec3 vBasisY;
      varying vec3 vBasisZ;
      void main() {
        vLocalNormal = normalize(normal);
        vBasisX = normalize(modelMatrix[0].xyz);
        vBasisY = normalize(modelMatrix[1].xyz);
        vBasisZ = normalize(modelMatrix[2].xyz);
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${SHARED_UNIFORMS_GLSL}
      ${GLSL_HELPERS}
      ${NOISE_GLSL}
      ${ATMOSPHERE_GLSL}
      ${CRATERS_GLSL}

      varying vec3 vLocalNormal;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      varying vec3 vBasisX;
      varying vec3 vBasisY;
      varying vec3 vBasisZ;

      void main() {
        vec3 localN = normalize(vLocalNormal);
        vec3 worldN = normalize(vWorldNormal);
        vec3 rayDir = normalize(vWorldPos - cameraPosition);
        vec3 viewDir = -rayDir;

        vec3 skyForeground;
        float transmittance;
        evalAtmosphericScatter(rayDir, skyForeground, transmittance);

        // Analytical sub-pixel anti-aliasing on exact spherical silhouette & inner crescent terminator
        vec3 moonDir = normalize(uMoonArvonDir);
        float rhoExact = length(cross(rayDir, moonDir)) / ${(ARVON_RADIUS / ARVON_DIST).toFixed(6)};
        float pxRim = max(length(vec2(dFdx(rhoExact), dFdy(rhoExact))), 0.018);
        float silAlpha = 1.0 - smoothstep(0.993 - pxRim * 0.90, 0.993, rhoExact);
        float limbAA = 1.0 - smoothstep(0.995 - pxRim * 0.85, 0.995, rhoExact);

        float NdotV = max(0.0, dot(worldN, viewDir));
        vec3 orbitalSun = evalLunarSunDir(uSunDir, uEclipse);
        float macroNdotL = dot(worldN, orbitalSun);
        float noonSmooth = smoothstep(0.18, 0.56, uSunDir.y);
        float bumpFade = smoothstep(0.09, 0.30, macroNdotL) * (1.0 - smoothstep(0.72, 0.93, rhoExact)) * (1.0 - noonSmooth * 0.88);

        // Crisp icy-silicate craters & tectonic fracture rifts inside sunlit crescent
        float ejecta;
        vec3 surfN = perturbLunarNormal(localN, normalize(vBasisX), normalize(vBasisY), normalize(vBasisZ), 0.11 * bumpFade, ejecta);

        float fracture = 1.0 - abs(fbm3(localN * 7.5 + vec3(3.1, -2.2, 4.7)) * 2.0 - 1.0);
        float iceRifts = safePow(fracture, 5.0);
        float basin = smoothstep(0.45, 0.72, fbm3(localN * 3.8 + vec3(-1.5, 4.2, 0.9)));

        vec3 iceSilver = vec3(0.76, 0.85, 0.96);
        vec3 cobaltSlate = vec3(0.36, 0.46, 0.62);
        vec3 albedo = mix(iceSilver, cobaltSlate, basin * 0.68);
        albedo = mix(albedo, vec3(0.92, 0.96, 1.0), clamp(iceRifts * 0.45 + ejecta * 0.48, 0.0, 1.0));

        // Strictly zero radiance when macroNdotL <= 0.0 so dark side matches skyForeground bit-for-bit
        float termGrad = length(vec2(dFdx(macroNdotL), dFdy(macroNdotL)));
        float termAA = max(termGrad * 1.5, 0.055);
        float macroTerminator = smoothstep(0.0, termAA, macroNdotL);
        float macroL = max(0.0, macroNdotL);
        float macroLommel = macroL / max(0.22, macroL + max(0.05, NdotV) * 0.56);
        float macroPhase = macroTerminator * mix(macroL, macroLommel * 1.34, 0.58);

        float microL = max(0.0, dot(surfN, orbitalSun));
        float microLommel = microL / max(0.22, microL + max(0.05, NdotV) * 0.56);
        float microPhase = macroTerminator * mix(microL, microLommel * 1.34, 0.58);
        float phase = mix(macroPhase, microPhase, bumpFade) * limbAA;

        float dayVis = smoothstep(-0.04, 0.22, uSunDir.y);
        float duskBoost = exp(-sq((uSunDir.y - 0.03) / 0.14)) * 0.52;
        float noonGlareAtten = smoothstep(0.18, 0.56, uSunDir.y);
        vec3 sunTint = mix(vec3(0.92, 0.96, 1.0), uSunColor, 0.25);
        float sunlitGain = (mix(0.82, 0.34, dayVis) + duskBoost * 0.35) * mix(1.0, 0.18, noonGlareAtten);
        vec3 bodyLitRadiance = albedo * sunTint * phase * sunlitGain;

        // Subtle Arrakis planetshine illuminating Arvon's night hemisphere in twilight/night
        float moonSunAng = acos(clamp(dot(uMoonKrellnDir, uSunDir), -0.99999, 0.99999));
        float eclipseTotality = smoothstep(0.072, 0.012, moonSunAng) * smoothstep(0.08, 0.38, uEclipse);
        float nightTwilVis = (1.0 - smoothstep(-0.02, 0.16, uSunDir.y)) * (1.0 - uStorm * 0.85) * (1.0 - eclipseTotality * 0.80);
        float planetshineGeom = (0.64 + 0.36 * NdotV) * (1.0 - macroTerminator * 0.85);
        vec3 planetshineAlbedo = mix(vec3(0.48, 0.54, 0.66), albedo, 0.48);
        vec3 planetshine = planetshineAlbedo * vec3(0.018, 0.020, 0.028) * planetshineGeom * nightTwilVis * limbAA;

        vec3 col = skyForeground + (bodyLitRadiance + planetshine) * transmittance;
        gl_FragColor = vec4(col, silAlpha);
      }
    `
  });
}

function createPlanetShader() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    depthTest: true,
    uniforms: createSharedAtmUniforms(),
    vertexShader: /* glsl */ `
      varying vec3 vLocalPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vLocalPos = normalize(position);
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${SHARED_UNIFORMS_GLSL}
      ${GLSL_HELPERS}
      ${NOISE_GLSL}
      ${ATMOSPHERE_GLSL}

      varying vec3 vLocalPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;

      void main() {
        vec3 p = normalize(vLocalPos);
        vec3 worldN = normalize(vWorldNormal);
        vec3 rayDir = normalize(vWorldPos - cameraPosition);
        vec3 viewDir = -rayDir;

        vec3 skyForeground;
        float transmittance;
        evalAtmosphericScatter(rayDir, skyForeground, transmittance);

        // Copper-banded gas/desert sister planet cloud belts + shear eddies
        float lon = atan(p.z, p.x);
        float shear = fbm3(vec3(p.x * 2.5, p.y * 8.0, p.z * 2.5 + uTime * 0.004)) * 0.14;
        float lat = p.y + shear;

        float belt1 = sin(lat * 22.0) * 0.5 + 0.5;
        float belt2 = fbm3(vec3(cos(lon) * 1.4, lat * 15.0, sin(lon) * 1.4));
        float bandMix = clamp(belt1 * 0.58 + belt2 * 0.42, 0.0, 1.0);

        vec3 deepCopper = vec3(0.50, 0.26, 0.15);
        vec3 ochreBelt = vec3(0.84, 0.56, 0.35);
        vec3 creamCloud = vec3(0.96, 0.88, 0.76);
        vec3 polarHaze = vec3(0.46, 0.48, 0.62);

        vec3 albedo = mix(deepCopper, ochreBelt, smoothstep(0.15, 0.62, bandMix));
        albedo = mix(albedo, creamCloud, smoothstep(0.62, 0.92, bandMix));
        albedo = mix(albedo, polarHaze, smoothstep(0.72, 0.96, abs(p.y)));

        // Subtle oval anticyclone storm vortex
        vec2 stormDelta = vec2((p.x - 0.28) * 1.3, (p.y + 0.18) * 2.4);
        if (p.z > 0.0) {
          float eye = exp(-dot(stormDelta, stormDelta) * 28.0);
          albedo = mix(albedo, vec3(0.96, 0.62, 0.38), eye * 0.68);
        }

        // Analytical sub-pixel AA on limb & crisp terminator (never darker than foreground atmosphere!)
        vec3 planetDir = normalize(uGasGiantDir);
        float rhoExact = length(cross(rayDir, planetDir)) / ${(PLANET_RADIUS / PLANET_DIST).toFixed(6)};
        float pxRim = max(length(vec2(dFdx(rhoExact), dFdy(rhoExact))), 0.014);
        float silAlpha = 1.0 - smoothstep(0.996 - pxRim * 0.95, 0.996, rhoExact);
        if (silAlpha < 0.002) discard;
        float limbAA = silAlpha;

        vec3 orbitalSun = evalOrbitalSunDir(uSunDir, uEclipse);
        float NdotL = dot(worldN, orbitalSun);
        float NdotV = max(0.0, dot(worldN, viewDir));
        float termGrad = length(vec2(dFdx(NdotL), dFdy(NdotL)));
        float termAA = max(termGrad * 1.15, 0.022);
        float terminator = smoothstep(0.0, termAA, NdotL);
        float lommel = max(0.0, NdotL) / max(0.07, max(0.0, NdotL) + max(0.02, NdotV) * 0.46);
        float lit = terminator * mix(max(0.0, NdotL), lommel * 1.24, 0.66) * limbAA;

        // Clean, slender ivory-gold forward-scattering atmospheric crescent arc strictly on sunlit side
        float fresnel = safePow(1.0 - NdotV, 3.0);
        float sunForward = safePow(max(0.0, dot(rayDir, orbitalSun)), 2.0);
        float litLimb = fresnel * smoothstep(0.0, 0.14, NdotL) * limbAA;
        vec3 limbHazeCol = mix(vec3(0.98, 0.82, 0.58), vec3(1.0, 0.96, 0.84), sunForward);

        // Distant companion planet receives full Canopus sunlight even during lunar eclipse on Arrakis
        vec3 spaceSun = mix(vec3(1.0, 0.96, 0.89), uSunColor, 0.25);
        float dayVis = smoothstep(-0.04, 0.22, uSunDir.y);
        float duskBoost = exp(-sq((uSunDir.y - 0.03) / 0.15)) * 0.35;
        float noonGlareAtten = smoothstep(0.18, 0.56, uSunDir.y);
        float planetGain = (mix(1.26, 0.82, dayVis) + duskBoost) * mix(1.0, 0.12, noonGlareAtten);

        // Subtle icy-ring ringshine on nightside strictly adds positive radiance over skyForeground (zero dark punch-through!)
        float moonSunAng = acos(clamp(dot(uMoonKrellnDir, uSunDir), -0.99999, 0.99999));
        float eclipseTotality = smoothstep(0.072, 0.012, moonSunAng) * smoothstep(0.08, 0.38, uEclipse);
        float darkSkyVis = max(1.0 - smoothstep(-0.02, 0.16, uSunDir.y), eclipseTotality * 0.88) * (1.0 - uStorm * 0.85);
        float ringGlowBand = 0.62 + 0.38 * smoothstep(0.06, 0.34, abs(p.y)) * (1.0 - 0.35 * smoothstep(0.78, 0.98, abs(p.y)));
        float nightSideMask = (0.58 + 0.42 * NdotV) * (1.0 - terminator * 0.85) * limbAA;
        vec3 ringshineAlbedo = mix(vec3(0.56, 0.62, 0.78), albedo, 0.45);
        vec3 ringshineCol = ringshineAlbedo * vec3(0.034, 0.038, 0.052) * ringGlowBand * nightSideMask * darkSkyVis;

        vec3 bodyLitRadiance = albedo * spaceSun * lit * planetGain
                             + limbHazeCol * litLimb * (0.48 + 0.46 * sunForward) * (1.0 - noonGlareAtten * 0.8)
                             + ringshineCol;

        vec3 col = skyForeground + bodyLitRadiance * transmittance;
        gl_FragColor = vec4(col, silAlpha);
      }
    `
  });
}

function createRingShader() {
  const uniforms = createSharedAtmUniforms();
  uniforms.uPlanetCenter = { value: new THREE.Vector3() };
  uniforms.uPlanetRadius = { value: PLANET_RADIUS };

  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      void main() {
        vLocalPos = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${SHARED_UNIFORMS_GLSL}
      ${GLSL_HELPERS}
      ${NOISE_GLSL}
      ${ATMOSPHERE_GLSL}

      uniform vec3 uPlanetCenter;
      uniform float uPlanetRadius;

      varying vec3 vLocalPos;
      varying vec3 vWorldPos;

      void main() {
        float rNorm = (length(vLocalPos.xy) - 1.38) / (2.45 - 1.38);
        if (rNorm < 0.0 || rNorm > 1.0) discard;

        vec3 rayDir = normalize(vWorldPos - cameraPosition);

        vec3 skyForeground;
        float transmittance;
        evalAtmosphericScatter(rayDir, skyForeground, transmittance);

        // Crisp multi-band icy-silicate planetary rings with distinct Cassini & Encke divisions
        float dr = fwidth(rNorm);
        float aa18 = exp(-sq(dr * 22.0 * 0.55));
        float aa42 = exp(-sq(dr * 48.0 * 0.55));

        float bandMacro = smoothstep(0.02, 0.20, rNorm) * (1.0 - 0.24 * smoothstep(0.60, 0.98, rNorm));
        float band18 = 0.72 + 0.28 * sin(rNorm * 22.0 + 0.6) * aa18;
        float band42 = 0.82 + 0.18 * sin(rNorm * 48.0 - 1.1) * aa42;
        float cassiniGap = 1.0 - exp(-sq((rNorm - 0.62) / 0.048)) * 0.88;
        float enckeGap = 1.0 - exp(-sq((rNorm - 0.85) / 0.028)) * 0.58;
        float edgeFade = smoothstep(0.0, 0.14, rNorm) * (1.0 - smoothstep(0.80, 1.0, rNorm));

        float opticalDepth = clamp(bandMacro * band18 * band42 * cassiniGap * enckeGap * edgeFade * 0.36, 0.0, 0.38);

        // Ray-sphere intersection from ring fragment toward orbitalSun casts crisp Cassini-style planet shadow across rear-right ring arc!
        vec3 sunRay = evalOrbitalSunDir(uSunDir, uEclipse);
        vec3 rel = (vWorldPos - uPlanetCenter) / uPlanetRadius;
        float tTowardSun = -dot(rel, sunRay);
        float perpDist = length(rel + sunRay * tTowardSun);
        float antiSunSide = smoothstep(-0.08, 0.12, tTowardSun);
        float penumbra = smoothstep(0.94, 1.06, perpDist);
        float ringShadow = mix(1.0, mix(0.02, 1.0, penumbra), antiSunSide);

        vec3 icyRing = mix(vec3(0.90, 0.78, 0.64), vec3(0.94, 0.95, 1.0), rNorm * 0.65);
        float forwardPhase = 0.82 + 0.36 * safePow(max(0.0, dot(rayDir, sunRay)), 3.0);
        vec3 spaceSun = mix(vec3(1.0, 0.95, 0.88), uSunColor, 0.28);
        float moonSunAng = acos(clamp(dot(uMoonKrellnDir, uSunDir), -0.99999, 0.99999));
        float eclipseMode = smoothstep(0.072, 0.014, moonSunAng) * smoothstep(0.08, 0.38, uEclipse);
        float dayRing = smoothstep(-0.08, 0.22, uSunDir.y) * (1.0 - eclipseMode);
        float noonGlareAtten = smoothstep(0.18, 0.56, uSunDir.y);
        float ringBrightness = mix(0.52, 0.44, dayRing) * mix(1.0, 0.14, noonGlareAtten);
        vec3 ringRadiance = icyRing * spaceSun * ringShadow * forwardPhase * ringBrightness;

        vec3 col = skyForeground + ringRadiance * transmittance;
        gl_FragColor = vec4(col, opticalDepth * mix(0.18, 1.0, ringShadow));
      }
    `
  });
}

function createCanopusCoronaShader() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: createSharedAtmUniforms(),
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${SHARED_UNIFORMS_GLSL}
      ${GLSL_HELPERS}
      ${NOISE_GLSL}
      ${ATMOSPHERE_GLSL}

      varying vec2 vUv;
      varying vec3 vWorldPos;

      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        if (r >= 1.0) discard;

        float sunAbove = smoothstep(-0.08, 0.06, uSunDir.y);
        if (sunAbove < 0.002) discard;

        vec3 rayDir = normalize(vWorldPos - cameraPosition);
        vec3 skyUnused;
        float transmittance;
        evalAtmosphericScatter(rayDir, skyUnused, transmittance);

        // Symmetrically round, soft radial solar corona glowing warmly into golden horizon haze
        float edgeFade = 1.0 - smoothstep(0.24, 0.98, r);
        float core = exp(-r * r * 38.0) * 0.48;
        float innerHalo = exp(-r * r * 11.0) * 0.22;
        float outerHalo = exp(-r * 5.2) * 0.14;

        float horizonDust = smoothstep(-0.02, 0.16, uSunDir.y);
        float moonSunAng = acos(clamp(dot(uMoonKrellnDir, uSunDir), -0.99999, 0.99999));
        float eclipseDim = 1.0 - smoothstep(0.068, 0.014, moonSunAng) * smoothstep(0.08, 0.35, uEclipse);
        float stormDim = 1.0 - smoothstep(0.05, 0.85, uStorm) * 0.85;
        float softTrans = mix(1.0, transmittance, 0.32);

        vec3 coronaTint = mix(uSunColor, vec3(1.0, 0.78, 0.48), smoothstep(0.08, 0.58, r) * 0.48);
        vec3 col = coronaTint * (core + innerHalo + outerHalo) * edgeFade * sunAbove * (0.76 + 0.24 * horizonDust) * eclipseDim * stormDim * softTrans;
        gl_FragColor = vec4(col, 1.0);
      }
    `
  });
}

function createEclipseCoronaShader() {
  const uniforms = createSharedAtmUniforms();
  uniforms.uDiamondDir = { value: new THREE.Vector2(1, 0) };

  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vBasisX;
      varying vec3 vBasisY;
      void main() {
        vUv = uv;
        vBasisX = normalize(modelMatrix[0].xyz);
        vBasisY = normalize(modelMatrix[1].xyz);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${SHARED_UNIFORMS_GLSL}
      ${GLSL_HELPERS}
      ${NOISE_GLSL}
      ${ATMOSPHERE_GLSL}

      uniform vec2 uDiamondDir;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vBasisX;
      varying vec3 vBasisY;

      // Druckmüller-inspired solar magnetic dipole helmet streamer:
      // Broad closed magnetic-loop dome cavity at the solar limb pinching smoothly into a curved gossamer cusp stalk
      float evalHelmetWing(
        float theta,
        float rhoMoon,
        float dR,
        float angStart,
        float angAsymp,
        float bendRate,
        float wBase,
        float wTail,
        float pinchRate,
        float decayRate,
        float seed,
        float pxInR,
        out float domeMask
      ) {
        float dLat = atan(sin(angStart - angAsymp), cos(angStart - angAsymp));
        float cAng = angAsymp + dLat * exp(-dR * bendRate);
        float dA = atan(sin(theta - cAng), cos(theta - cAng));

        float halfW = mix(wTail, wBase, exp(-dR * pinchRate));
        float minNyq = max(0.032, (pxInR * 1.5) / max(rhoMoon, 1.0));
        float effW = max(halfW, minNyq);
        float psi = dA / effW;
        // Hybrid Lorentzian-Gaussian cusp profile: bulbous base, pinched silky outer streamer sheet
        float cuspFactor = smoothstep(0.25, 1.45, dR);
        float gaussEnv = exp(-sq(psi * 1.18)) + exp(-sq(psi * 0.54)) * 0.30;
        float cuspEnv = 1.0 / (1.0 + sq(psi * 1.45)) * exp(-sq(psi * 0.42));
        float env = mix(gaussEnv, cuspEnv * 1.15, cuspFactor);
        if (env < 0.002) {
          domeMask = 0.0;
          return 0.0;
        }

        // Closed magnetic-loop prominence cavity inside helmet base (authentic subtle darker inner arch)
        float domeZone = exp(-sq(dR / 0.68));
        float archCavity = 1.0 - 0.28 * exp(-sq(psi / 0.46)) * exp(-sq((dR - 0.16) / 0.22));
        float archRim = 0.22 * exp(-sq((abs(psi) - 0.58) / 0.22)) * exp(-sq((dR - 0.22) / 0.30));

        // Fine curved magnetic field striations flowing along streamline coordinates
        float sCurve = log(1.0 + dR * 1.25);
        float nyq4 = exp(-sq(4.2 * pxInR / max(effW * rhoMoon, 0.04)));
        float filStream = fbm2(vec2(sCurve * 0.52 + seed * 3.7, psi * 3.2 + seed * 1.3));
        float filFine = fbm2(vec2(sCurve * 0.78 - seed * 2.1, psi * 6.4 - seed * 1.7));
        float wisp = mix(0.68, 1.24, smoothstep(0.22, 0.78, filStream))
                   * mix(0.82, 1.18, mix(0.5, filFine, nyq4));
        float farSilk = mix(wisp, mix(0.76, 1.18, smoothstep(0.26, 0.74, filStream)), smoothstep(1.5, 3.8, dR));

        float softRoot = mix(0.52, 1.0, smoothstep(0.0, 0.08, dR));
        float radEnv = exp(-dR * decayRate) / pow(1.0 + dR * 0.65, 1.38);
        float farCutoff = 1.0 - smoothstep(2.8, 5.1, dR);

        domeMask = exp(-sq(psi * 0.85)) * exp(-dR * 1.05);
        return (env * archCavity + archRim) * (1.0 + 0.18 * domeZone) * farSilk * softRoot * radEnv * farCutoff;
      }

      // Delicate curved hairline magnetic streamer ray arching outward from equatorial base into outer wings
      float evalHairlineRay(
        float theta,
        float rhoMoon,
        float dR,
        float angStart,
        float angAsymp,
        float bendRate,
        float wBase,
        float wOuter,
        float decayRate,
        float farEnd,
        float seed,
        float pxInR
      ) {
        float dLat = atan(sin(angStart - angAsymp), cos(angStart - angAsymp));
        float cAng = angAsymp + dLat * exp(-dR * bendRate)
                   + 0.028 * sin(dR * 0.85 + seed * 2.3) * smoothstep(0.2, 1.6, dR);
        float dA = atan(sin(theta - cAng), cos(theta - cAng));

        float wAng = mix(wBase, wOuter, smoothstep(0.15, 2.6, dR));
        float minNyqW = (pxInR * 1.45) / max(rhoMoon, 1.0);
        float halfW = max(wAng, minNyqW);

        float psi = dA / halfW;
        float core = exp(-sq(psi * 1.10));
        float halo = exp(-sq(psi * 0.48)) * 0.38;
        float profile = core + halo;
        if (profile < 0.002) return 0.0;

        float sFlow = log(1.0 + dR * 1.2);
        float flowMod = 0.80 + 0.32 * fbm2(vec2(sFlow * 0.85 + seed * 4.1, psi * 0.9 + seed * 1.7));

        float softRoot = mix(0.22, 1.0, smoothstep(0.0, 0.14, dR));
        float radDecay = exp(-dR * decayRate) / pow(1.0 + dR * 0.62, 1.25);
        float farCutoff = 1.0 - smoothstep(farEnd * 0.58, farEnd, dR);
        return profile * flowMod * softRoot * radDecay * farCutoff;
      }

      // Individual wispy magnetic polar plume filament following curved dipole field lines
      float evalPolarBrush(
        float fieldPsi,
        float dR,
        float rhoMoon,
        float centerPsi,
        float widthPsi,
        float lenDecay,
        float amp,
        float poleSign,
        float pxInR
      ) {
        float wSafe = max(widthPsi, (pxInR * 1.45) / max(rhoMoon, 1.0));
        float d = (fieldPsi - centerPsi) / wSafe;
        float profile = exp(-sq(d * 1.05)) + exp(-sq(d * 0.48)) * 0.30;
        if (profile < 0.002) return 0.0;
        float tex = 0.78 + 0.22 * fbm2(vec2(centerPsi * 9.0 + poleSign * 3.1, log(1.0 + dR * 1.4) * 1.5));
        float radFall = exp(-dR * lenDecay) / pow(1.0 + dR * 1.10, 1.35);
        return profile * tex * radFall * amp;
      }

      void main() {
        float moonSunAng = acos(clamp(dot(uMoonKrellnDir, uSunDir), -0.99999, 0.99999));
        float totality = (1.0 - smoothstep(0.008, 0.055, moonSunAng)) * smoothstep(0.10, 0.35, uEclipse);
        if (totality < 0.002) discard;

        vec2 p = vUv * 2.0 - 1.0;
        if (length(p) >= 0.98) discard;

        vec3 rayDir = normalize(vWorldPos - cameraPosition);
        vec3 moonDir = normalize(uMoonKrellnDir);
        float moonAng = length(cross(rayDir, moonDir));
        float rhoMoon = moonAng / ${(KRELLN_RADIUS / KRELLN_DIST).toFixed(6)};
        float dR = max(0.0, rhoMoon - 1.0);
        float pxInR = clamp(length(vec2(dFdx(rhoMoon), dFdy(rhoMoon))), 0.006, 0.055);
        if (rhoMoon < 0.984) discard;

        vec3 skyUnused;
        float transmittance;
        evalAtmosphericScatter(rayDir, skyUnused, transmittance);

        // Analytical machine-exact circular limb alignment with createKrellnShader rhoExact
        float outsideMask = smoothstep(0.994, 1.018, rhoMoon);
        float quadFade = 1.0 - smoothstep(0.74, 0.95, length(p));

        vec3 basisX = normalize(vBasisX);
        vec3 basisY = normalize(vBasisY);
        vec2 dir2 = vec2(dot(rayDir, basisX), dot(rayDir, basisY));
        float dir2Len = length(dir2);
        vec2 unit2 = dir2Len > 1e-6 ? dir2 / dir2Len : vec2(1.0, 0.0);
        vec2 rhoVec = unit2 * rhoMoon;
        float theta = atan(unit2.y, unit2.x);

        // Tilted solar magnetic dipole coordinate frame
        float tilt = -0.26;
        float phi = atan(sin(theta - tilt), cos(theta - tilt));

        // Asymmetric curved magnetic helmet streamers pinching from bulbous limb arches into graceful equatorial cusps
        float dWNW, dNW, dESE, dENE, dSW;
        float wWNW = evalHelmetWing(theta, rhoMoon, dR,  2.66,  2.88, 0.92, 0.56, 0.088, 1.28, 0.58, 1.1, pxInR, dWNW) * 0.84;
        float wNW  = evalHelmetWing(theta, rhoMoon, dR,  2.14,  2.54, 1.18, 0.42, 0.068, 1.42, 0.82, 2.7, pxInR, dNW)  * 0.54;
        float wESE = evalHelmetWing(theta, rhoMoon, dR, -0.48, -0.22, 0.88, 0.60, 0.095, 1.22, 0.54, 4.3, pxInR, dESE) * 0.88;
        float wENE = evalHelmetWing(theta, rhoMoon, dR,  0.42,  0.04, 1.14, 0.44, 0.072, 1.38, 0.78, 5.9, pxInR, dENE) * 0.56;
        float wSW  = evalHelmetWing(theta, rhoMoon, dR, -2.32, -2.68, 1.25, 0.40, 0.065, 1.48, 0.92, 7.5, pxInR, dSW)  * 0.46;

        float westWing = wWNW * 0.88 + wNW * 0.52;
        float eastWing = wESE * 0.90 + wENE * 0.52;
        float helmetCorona = max(westWing, max(eastWing, wSW)) + 0.30 * min(westWing, eastWing) + wSW * 0.28;
        float domeBelt = clamp(max(max(dWNW, dNW * 0.85), max(max(dESE, dENE * 0.85), dSW * 0.70)), 0.0, 1.0);

        // Multi-layered sweeping gossamer magnetic hairline rays arching from solar equator into asymmetric wings
        float rayESE = evalHairlineRay(theta, rhoMoon, dR, -0.52, -0.20, 0.72, 0.032, 0.072, 0.46, 4.5, 11.3, pxInR) * 0.24;
        float rayENE = evalHairlineRay(theta, rhoMoon, dR,  0.46, -0.04, 1.05, 0.026, 0.058, 0.68, 3.4, 14.7, pxInR) * 0.19;
        float rayEM  = evalHairlineRay(theta, rhoMoon, dR, -0.10, -0.28, 0.88, 0.022, 0.048, 0.60, 3.8, 18.2, pxInR) * 0.16;
        float rayWNW = evalHairlineRay(theta, rhoMoon, dR,  2.78,  2.94, 0.78, 0.030, 0.068, 0.50, 4.2, 21.9, pxInR) * 0.23;
        float rayNW  = evalHairlineRay(theta, rhoMoon, dR,  2.18,  2.64, 1.15, 0.024, 0.054, 0.72, 3.2, 25.4, pxInR) * 0.18;
        float raySW  = evalHairlineRay(theta, rhoMoon, dR, -2.38, -2.76, 1.25, 0.022, 0.052, 0.82, 2.9, 29.1, pxInR) * 0.14;
        float hairlineRays = max(max(rayESE, rayENE), rayEM) + 0.42 * min(rayESE, rayENE)
                           + max(max(rayWNW, rayNW), raySW) + 0.38 * min(rayWNW, rayNW);

        // Organic paired & irregularly spaced wispy polar plumes (varied azimuth, length, and opacity; zero hair-brush comb)
        float poleSigned = atan(cos(phi), abs(sin(phi)));
        float poleSign = sin(phi) >= 0.0 ? 1.0 : -1.0;
        float fieldPsi = poleSigned / sqrt(1.0 + dR * 1.75);
        float polarMask = smoothstep(0.46, 0.96, abs(sin(phi))) * (1.0 - smoothstep(0.22, 0.82, domeBelt));

        float polarBrushes = 0.0;
        if (polarMask > 0.002) {
          if (poleSign < 0.0) {
            // South (bottom) polar crown: clustered paired brushes & quiet dark coronal gaps with varied reach
            polarBrushes += evalPolarBrush(fieldPsi, dR, rhoMoon, -0.440, 0.042, 1.68, 0.72, poleSign, pxInR);
            polarBrushes += evalPolarBrush(fieldPsi, dR, rhoMoon, -0.225, 0.028, 1.24, 0.96, poleSign, pxInR);
            polarBrushes += evalPolarBrush(fieldPsi, dR, rhoMoon, -0.140, 0.024, 2.40, 0.62, poleSign, pxInR);
            polarBrushes += evalPolarBrush(fieldPsi, dR, rhoMoon,  0.075, 0.032, 1.15, 1.06, poleSign, pxInR);
            polarBrushes += evalPolarBrush(fieldPsi, dR, rhoMoon,  0.235, 0.025, 2.15, 0.76, poleSign, pxInR);
            polarBrushes += evalPolarBrush(fieldPsi, dR, rhoMoon,  0.315, 0.036, 1.46, 0.84, poleSign, pxInR);
            polarBrushes += evalPolarBrush(fieldPsi, dR, rhoMoon,  0.485, 0.044, 2.50, 0.50, poleSign, pxInR);
          } else {
            // North (top) polar crown: distinct asymmetric wispy plume arrangement
            polarBrushes += evalPolarBrush(fieldPsi, dR, rhoMoon, -0.410, 0.038, 1.90, 0.68, poleSign, pxInR);
            polarBrushes += evalPolarBrush(fieldPsi, dR, rhoMoon, -0.195, 0.030, 1.32, 0.94, poleSign, pxInR);
            polarBrushes += evalPolarBrush(fieldPsi, dR, rhoMoon, -0.045, 0.024, 2.25, 0.65, poleSign, pxInR);
            polarBrushes += evalPolarBrush(fieldPsi, dR, rhoMoon,  0.055, 0.032, 1.42, 0.88, poleSign, pxInR);
            polarBrushes += evalPolarBrush(fieldPsi, dR, rhoMoon,  0.245, 0.028, 1.28, 0.92, poleSign, pxInR);
            polarBrushes += evalPolarBrush(fieldPsi, dR, rhoMoon,  0.390, 0.040, 2.15, 0.60, poleSign, pxInR);
          }
        }
        float pWarp = (fbm2(vec2(fieldPsi * 3.8 + poleSign * 2.1, log(1.0 + dR * 1.2) * 0.9)) - 0.5) * 0.28;
        float pVeilNoise = fbm2(vec2((fieldPsi + pWarp) * 4.4 + poleSign * 5.3, log(1.0 + dR * 1.3) * 1.1));
        float veilReach = mix(2.75, 1.65, smoothstep(0.32, 0.70, pVeilNoise));
        float polarMist = smoothstep(0.28, 0.78, pVeilNoise) * exp(-dR * veilReach) / (1.0 + dR * 1.25);
        float polarSoftRoot = mix(0.45, 1.0, smoothstep(0.0, 0.12, dR));
        // Silky gossamer dipole veil (suppress harsh straight radial brush-comb bristles!)
        float polarPlumes = polarMask * polarSoftRoot * (polarBrushes * 0.036 + polarMist * 0.095);

        // Asymmetric inner streamer base glow + gossamer soft equatorial dust veil
        float innerSoft = mix(0.42, 1.0, smoothstep(0.0, 0.09, dR));
        float innerDecay = exp(-dR * 2.45) / (1.0 + dR * 1.10);
        float veilEq = 0.30 + 0.70 * exp(-sq(sin(phi) / 0.68));
        float gossamerVeil = exp(-dR * 0.95) * veilEq * 0.085 * innerSoft;
        float innerCorona = innerDecay * innerSoft * (0.09 + 0.34 * domeBelt) + gossamerVeil;

        // Discrete localized ruby-magenta H-alpha solar loop prominences along the lunar limb
        float promNoise = 0.52 + 0.48 * vnoise2(vec2(cos(theta) * 12.0 + 1.3, sin(theta) * 12.0 - 0.8));
        float prom1 = exp(-sq(atan(sin(theta - 2.54), cos(theta - 2.54)) / 0.062)) * exp(-sq((dR - 0.012) / 0.038)) * 1.35;
        float prom2 = exp(-sq(atan(sin(theta - 0.34), cos(theta - 0.34)) / 0.050)) * exp(-sq((dR - 0.008) / 0.032)) * 1.10;
        float prom3 = exp(-sq(atan(sin(theta + 0.58), cos(theta + 0.58)) / 0.068)) * exp(-sq((dR - 0.014) / 0.044)) * 1.25;
        float prom4 = exp(-sq(atan(sin(theta + 2.24), cos(theta + 2.24)) / 0.045)) * exp(-sq((dR - 0.008) / 0.028)) * 0.95;
        vec3 chromoGlow = vec3(1.55, 0.28, 0.52) * (prom1 + prom2 + prom3 + prom4) * promNoise * 0.78;

        // Pinpoint diamond-ring glint strictly gated outside centered totality (moonSunAng >= 0.015)
        float dLen = length(uDiamondDir);
        vec2 dAxis = dLen > 1e-4 ? uDiamondDir / dLen : vec2(1.0, 0.0);
        vec2 rimPt = dAxis * (0.996 - pxInR * 0.15);
        vec2 delta = rhoVec - rimPt;
        float dDiamond = length(delta);
        float pxD = max(pxInR, 0.012);
        float diamondLimbMask = smoothstep(0.996 - pxInR * 2.4, 0.996 + pxInR * 0.3, rhoMoon);
        float diamondCore = exp(-sq(dDiamond / (pxD * 1.05))) * 3.6;
        float diamondAureole = exp(-dDiamond / (pxD * 2.2)) * 0.55 + exp(-dDiamond / 0.152) * 0.12;
        vec2 rotD = vec2(delta.x * 0.927 - delta.y * 0.375, delta.x * 0.375 + delta.y * 0.927);
        float flareArmA = exp(-abs(rotD.y) / (pxD * 0.55)) * exp(-abs(rotD.x) / 0.388);
        float flareArmB = exp(-abs(rotD.x) / (pxD * 0.55)) * exp(-abs(rotD.y) / 0.388);
        float diamondFlare = (flareArmA + flareArmB) * 0.45;
        float diamondActive = smoothstep(0.015, 0.025, moonSunAng) * (1.0 - smoothstep(0.036, 0.052, moonSunAng));
        float diamondProminence = (diamondCore + diamondAureole + diamondFlare) * diamondLimbMask * diamondActive;

        // Chromatic corona transition: warm pearl-ivory bases -> crisp silver -> gossamer twilight-sapphire streamer tips
        vec3 innerPearl = vec3(1.06, 0.99, 0.94);
        vec3 midSilver = vec3(0.88, 0.94, 1.04);
        vec3 outerSapphire = vec3(0.48, 0.68, 1.05);
        vec3 kCol = mix(midSilver, innerPearl, exp(-dR * 3.2));
        kCol = mix(kCol, outerSapphire, smoothstep(0.35, 2.8, dR));

        vec3 diamondCol = mix(vec3(1.18, 1.04, 0.80), vec3(1.48, 1.42, 1.30), exp(-dDiamond / (pxD * 2.6)));
        float totalStructure = innerCorona + helmetCorona * 0.94 + hairlineRays * 0.24 + polarPlumes;
        vec3 coronaRad = kCol * totalStructure + chromoGlow;
        vec3 col = coronaRad * outsideMask + diamondCol * diamondProminence;

        float sunAbove = smoothstep(-0.08, 0.05, uSunDir.y);
        float stormDim = 1.0 - smoothstep(0.05, 0.85, uStorm) * 0.88;
        col *= quadFade * totality * sunAbove * stormDim * transmittance;

        // Subtle fragment dither kills concentric gradient banding in gossamer wings
        float coronaDither = (hash12(gl_FragCoord.xy) - 0.5) * 0.0020 * smoothstep(0.001, 0.020, totalStructure + diamondProminence);
        col = max(vec3(0.0), col + coronaDither);

        gl_FragColor = vec4(col, 1.0);
      }
    `
  });
}

export function createSkySystem(scene, worldState) {
  const group = new THREE.Group();
  group.name = 'ArrakisSkySystem';

  // 1. Sky Dome
  const skyGeo = new THREE.SphereGeometry(SKY_DOME_RADIUS, 64, 48);
  const skyMat = createSkyDomeShader();
  const skyDome = new THREE.Mesh(skyGeo, skyMat);
  skyDome.name = 'SkyDome';
  skyDome.renderOrder = -100;
  skyDome.frustumCulled = false;
  group.add(skyDome);

  // 2. Companion Ringed Desert Sister Planet (Sphere + 24-deg tilted RingGeometry)
  const planetGroup = new THREE.Group();
  planetGroup.name = 'CompanionRingedPlanet';
  const planetAxialPivot = new THREE.Group();
  planetAxialPivot.rotation.set(0.42, 0.0, -0.26);
  planetGroup.add(planetAxialPivot);

  const planetGeo = new THREE.SphereGeometry(1, 64, 48);
  const planetMat = createPlanetShader();
  const planetMesh = new THREE.Mesh(planetGeo, planetMat);
  planetMesh.scale.setScalar(PLANET_RADIUS);
  planetMesh.renderOrder = -92;
  planetAxialPivot.add(planetMesh);

  const ringGeo = new THREE.RingGeometry(1.38, 2.45, 96, 4);
  const ringMat = createRingShader();
  const ringMesh = new THREE.Mesh(ringGeo, ringMat);
  ringMesh.scale.setScalar(PLANET_RADIUS);
  ringMesh.rotation.x = Math.PI * 0.5;
  ringMesh.renderOrder = -91;
  planetAxialPivot.add(ringMesh);
  group.add(planetGroup);

  // 3. Canopus Corona Halo Billboard (behind Krelln during eclipse)
  const canopusCoronaGeo = new THREE.PlaneGeometry(170, 170);
  const canopusCoronaMat = createCanopusCoronaShader();
  const canopusCorona = new THREE.Mesh(canopusCoronaGeo, canopusCoronaMat);
  canopusCorona.name = 'CanopusCorona';
  canopusCorona.renderOrder = -89;
  canopusCorona.frustumCulled = false;
  group.add(canopusCorona);

  // 4. Second Moon: Arvon (cool pale-azure/silver crescent moon)
  const arvonGeo = new THREE.SphereGeometry(1, 64, 48);
  const arvonMat = createArvonShader();
  const arvonMesh = new THREE.Mesh(arvonGeo, arvonMat);
  arvonMesh.name = 'MoonArvon';
  arvonMesh.scale.setScalar(ARVON_RADIUS);
  arvonMesh.renderOrder = -86;
  group.add(arvonMesh);

  // 5. First Moon: Krelln (the Muad'Dib volcanic-mare moon)
  const krellnGeo = new THREE.SphereGeometry(1, 128, 96);
  const krellnMat = createKrellnShader();
  const krellnMesh = new THREE.Mesh(krellnGeo, krellnMat);
  krellnMesh.name = 'MoonKrelln';
  krellnMesh.scale.setScalar(KRELLN_RADIUS);
  krellnMesh.renderOrder = -82;
  group.add(krellnMesh);

  // 6. Eclipse Corona & Diamond-Ring Glare Billboard around Krelln
  const eclipseCoronaGeo = new THREE.PlaneGeometry(ECLIPSE_CORONA_HALF * 2, ECLIPSE_CORONA_HALF * 2);
  const eclipseCoronaMat = createEclipseCoronaShader();
  const eclipseCorona = new THREE.Mesh(eclipseCoronaGeo, eclipseCoronaMat);
  eclipseCorona.name = 'EclipseCorona';
  eclipseCorona.renderOrder = -80;
  eclipseCorona.frustumCulled = false;
  group.add(eclipseCorona);

  if (scene) {
    scene.add(group);
  }

  // Scratch vectors & state (zero per-frame heap allocations)
  const _camPos = new THREE.Vector3();
  const _windOffset = new THREE.Vector2();
  const _lightningDir = new THREE.Vector3(0.18, 0.36, -0.91).normalize();
  const _sunOffset = new THREE.Vector3();
  const _localRight = new THREE.Vector3();
  const _localUp = new THREE.Vector3();
  const _diamondDir = new THREE.Vector2(1, 0);
  const _planetWorldPos = new THREE.Vector3();
  let prevLightning = 0;

  const atmMaterials = [
    skyMat,
    krellnMat,
    arvonMat,
    planetMat,
    ringMat,
    canopusCoronaMat,
    eclipseCoronaMat
  ];

  function syncStateToUniforms(dt) {
    const step = worldState.paused ? 0 : Math.min(Math.max(dt || 0, 0), 0.1);
    const windSpeed = worldState.windSpeed ?? 0.45;
    if (worldState.windDir) {
      _windOffset.addScaledVector(worldState.windDir, windSpeed * step * 0.16);
    }

    const storm = worldState.weatherWeights?.coriolisStorm ?? 0;
    const saltation = worldState.weatherWeights?.saltation ?? 0;
    const spice = worldState.weatherWeights?.spiceBlow ?? 0;
    const dustHaze = Math.min(1, saltation * 0.38 + spice * 0.28 + storm * 0.65);

    const lightning = worldState.lightningFlash ?? 0;
    if (lightning > prevLightning + 0.12) {
      const seed = (worldState.elapsed || 0) * 13.37;
      const azim = Math.sin(seed * 1.73) * 0.82;
      const elev = 0.20 + (Math.cos(seed * 2.91) * 0.5 + 0.5) * 0.42;
      _lightningDir.set(azim, elev, -0.88).normalize();
    }
    prevLightning = lightning;

    const elapsed = worldState.elapsed ?? 0;
    const eclipse = worldState.eclipseStrength ?? 0;

    for (let i = 0; i < atmMaterials.length; i++) {
      const u = atmMaterials[i].uniforms;
      u.uTime.value = elapsed;
      u.uSunDir.value.copy(worldState.sunDir);
      u.uMoonKrellnDir.value.copy(worldState.moonKrellnDir);
      u.uMoonArvonDir.value.copy(worldState.moonArvonDir);
      u.uGasGiantDir.value.copy(worldState.gasGiantDir);
      u.uZenithColor.value.copy(worldState.skyZenithColor);
      u.uHorizonColor.value.copy(worldState.skyHorizonColor);
      u.uSunColor.value.copy(worldState.sunColor);
      u.uStorm.value = storm;
      u.uEclipse.value = eclipse;
      u.uLightning.value = lightning;
      u.uLightningDir.value.copy(_lightningDir);
      u.uWindOffset.value.copy(_windOffset);
      u.uDustHaze.value = dustHaze;
    }
  }

  function update(dt, camera) {
    if (camera) {
      _camPos.copy(camera.position);
    } else {
      _camPos.set(0, 0, 0);
    }

    group.position.copy(_camPos);
    group.updateMatrixWorld();

    syncStateToUniforms(dt);

    // Position and billboard celestial bodies around camera
    krellnMesh.position.copy(worldState.moonKrellnDir).multiplyScalar(KRELLN_DIST);
    krellnMesh.lookAt(_camPos);
    krellnMesh.updateMatrixWorld(true);

    arvonMesh.position.copy(worldState.moonArvonDir).multiplyScalar(ARVON_DIST);
    arvonMesh.lookAt(_camPos);
    arvonMesh.updateMatrixWorld(true);

    planetGroup.position.copy(worldState.gasGiantDir).multiplyScalar(PLANET_DIST);
    planetGroup.lookAt(_camPos);
    planetGroup.updateMatrixWorld(true);
    planetGroup.getWorldPosition(_planetWorldPos);
    ringMat.uniforms.uPlanetCenter.value.copy(_planetWorldPos);

    canopusCorona.position.copy(worldState.sunDir).multiplyScalar(CANOPUS_CORONA_DIST);
    canopusCorona.lookAt(_camPos);

    eclipseCorona.position.copy(worldState.moonKrellnDir).multiplyScalar(ECLIPSE_CORONA_DIST);
    eclipseCorona.lookAt(_camPos);

    // Project solar offset onto eclipse billboard plane to aim the diamond-ring prominence
    _sunOffset.copy(worldState.sunDir).sub(worldState.moonKrellnDir);
    _localRight.set(1, 0, 0).applyQuaternion(eclipseCorona.quaternion);
    _localUp.set(0, 1, 0).applyQuaternion(eclipseCorona.quaternion);
    _diamondDir.set(_sunOffset.dot(_localRight), _sunOffset.dot(_localUp));
    if (_diamondDir.lengthSq() > 1e-8) {
      _diamondDir.normalize();
    } else {
      _diamondDir.set(1, 0);
    }
    eclipseCoronaMat.uniforms.uDiamondDir.value.copy(_diamondDir);
  }

  // Run one initial placement pass so first frame is immediately coherent
  update(0, null);

  return { group, update };
}
