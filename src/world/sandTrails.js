import * as THREE from 'three';
import { CISTERN_CENTER } from './terrainMath.js';

const MAP_RES = 512;
const MAP_WORLD_SIZE = 52.0; // 52m x 52m high-res trail window (~10cm/texel) centered near player
const MAX_WATER_RIPPLES = 16;

// Natural tamarisk dew-drip overhang positions over the cistern water edge
const DEW_DRIP_SPOTS = [
  { x: 4.3, z: 6.2 },
  { x: 4.9, z: 2.1 },
  { x: -3.2, z: 5.4 },
  { x: 1.8, z: 0.4 },
  { x: -1.4, z: 7.1 }
];

/**
 * Dynamic Sand Footprint / Dune-Slide / Crater Displacement Buffer + Live Water Ripple Queue.
 * - Red channel: signed height offset centered at 128 (<128 recessed pit, >128 raised rim lip).
 * - Green channel: disturbance/compaction mask (0 = pristine ripples, 255 = freshly stamped).
 */
export function createSandTrailsSystem(worldState) {
  const canvas = document.createElement('canvas');
  canvas.width = MAP_RES;
  canvas.height = MAP_RES;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  const scratch = document.createElement('canvas');
  scratch.width = MAP_RES;
  scratch.height = MAP_RES;
  const scratchCtx = scratch.getContext('2d');

  // Neutral baseline: R=128 (0 displacement), G=0 (undisturbed), B=128
  function clearToNeutral(targetCtx) {
    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.fillStyle = 'rgb(128, 0, 128)';
    targetCtx.fillRect(0, 0, MAP_RES, MAP_RES);
  }
  clearToNeutral(ctx);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const origin = new THREE.Vector2(0.0, 8.0);
  let dirty = true;
  let fadeAccum = 0;

  // 16-slot water ripple ring buffer: vec4(worldX, worldZ, startTime, strength)
  const waterRipples = Array.from({ length: MAX_WATER_RIPPLES }, () => new THREE.Vector4(0, 0, -999, 0));
  let nextRippleIdx = 0;
  let dewDripCooldown = 1.4;

  function worldToPx(wx, wz) {
    const u = (wx - origin.x) / MAP_WORLD_SIZE + 0.5;
    // Note: Canvas Y=0 is top; in Three.js CanvasTexture flipY=true maps top (Y=0) to v=1.
    // In terrain shader we compute uv = (worldPos.xz - origin) / size + 0.5, so +z -> v=1 -> canvasY=0.
    const v = (wz - origin.y) / MAP_WORLD_SIZE + 0.5;
    return {
      px: u * MAP_RES,
      py: (1.0 - v) * MAP_RES
    };
  }

  function recenter(targetX, targetZ, force = false) {
    const dx = targetX - origin.x;
    const dz = targetZ - origin.y;
    if (!force && Math.hypot(dx, dz) < 5.5) return;

    // Snap shift to whole pixels to prevent subpixel blur on scroll
    const shiftPxX = Math.round((dx / MAP_WORLD_SIZE) * MAP_RES);
    const shiftPxY = Math.round((-dz / MAP_WORLD_SIZE) * MAP_RES);
    if (shiftPxX === 0 && shiftPxY === 0) return;

    const worldDx = (shiftPxX / MAP_RES) * MAP_WORLD_SIZE;
    const worldDz = (-shiftPxY / MAP_RES) * MAP_WORLD_SIZE;
    origin.x += worldDx;
    origin.y += worldDz;

    scratchCtx.globalCompositeOperation = 'source-over';
    scratchCtx.clearRect(0, 0, MAP_RES, MAP_RES);
    scratchCtx.drawImage(canvas, 0, 0);

    clearToNeutral(ctx);
    ctx.drawImage(scratch, -shiftPxX, -shiftPxY);
    dirty = true;
  }

  /**
   * Stamps a realistic Fremen boot footprint (asymmetric displaced dry-sand rim + sculpted heel/forefoot trough).
   */
  function stampFootprint(wx, wz, yaw, isLeft = false, depth = 1.0, isSandwalk = false) {
    const { px, py } = worldToPx(wx, wz);
    if (px < -24 || px > MAP_RES + 24 || py < -24 || py > MAP_RES + 24) return;

    const pxPerM = MAP_RES / MAP_WORLD_SIZE;
    const bootLen = (isSandwalk ? 0.52 : 0.42) * pxPerM;
    const bootWid = (isSandwalk ? 0.25 : 0.22) * pxPerM;
    const clampedDepth = Math.max(0.25, Math.min(1.35, depth));

    ctx.save();
    ctx.translate(px, py);
    // Align canvas +Y (which maps to world -Z) with Three.js yaw forward = (-sin(yaw), -cos(yaw))
    const splay = isLeft ? 0.09 : -0.09;
    const sweepSkew = isSandwalk ? (isLeft ? 0.05 : -0.05) : 0.0;
    ctx.rotate(yaw + splay + sweepSkew);

    // 1. Asymmetric outer displaced dry-sand angle-of-repose rim lip (R > 128, biased slightly forward & outward)
    const rimOffX = (isLeft ? -0.10 : 0.10) * bootWid * (isSandwalk ? 1.35 : 0.75);
    const rimOffY = bootLen * 0.07;
    const rimGrad = ctx.createRadialGradient(
      rimOffX,
      rimOffY,
      bootWid * 0.42,
      rimOffX,
      rimOffY,
      bootLen * 1.04
    );
    const rimR = Math.round(Math.min(248, 128 + 86 * clampedDepth));
    rimGrad.addColorStop(0.0, `rgba(${rimR}, 145, 128, 0.0)`);
    rimGrad.addColorStop(0.52, `rgba(${rimR}, 168, 128, ${Math.min(0.78, 0.58 * clampedDepth)})`);
    rimGrad.addColorStop(0.80, `rgba(${Math.round(128 + 42 * clampedDepth)}, 88, 128, ${Math.min(0.42, 0.28 * clampedDepth)})`);
    rimGrad.addColorStop(1.0, 'rgba(128, 0, 128, 0.0)');
    ctx.fillStyle = rimGrad;
    ctx.beginPath();
    ctx.ellipse(rimOffX, rimOffY, bootWid * 1.56, bootLen * 0.98, 0, 0, Math.PI * 2);
    ctx.fill();

    // Optional hushed Fremen Sandwalk crescent drag tail behind heel
    if (isSandwalk) {
      const dragX = (isLeft ? 0.14 : -0.14) * bootWid;
      const dragY = -bootLen * 0.44;
      const dragGrad = ctx.createRadialGradient(dragX, dragY, 0, dragX, dragY, bootWid * 1.05);
      const dragPitR = Math.round(Math.max(48, 128 - 54 * clampedDepth));
      dragGrad.addColorStop(0.0, `rgba(${dragPitR}, ${Math.round(165 * clampedDepth)}, 128, ${0.48 * clampedDepth})`);
      dragGrad.addColorStop(1.0, 'rgba(128, 0, 128, 0.0)');
      ctx.fillStyle = dragGrad;
      ctx.beginPath();
      ctx.ellipse(dragX, dragY, bootWid * 0.85, bootLen * 0.36, isLeft ? -0.22 : 0.22, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. Sculpted boot-sole recessed depression (forefoot ball + arch bridge + heel cup)
    const pitR = Math.round(Math.max(8, 128 - 114 * clampedDepth));
    const soleG = Math.round(Math.min(255, 236 * clampedDepth));

    // Midfoot arch bridge so dry sand forms a cohesive continuous 3D funnel
    const archGrad = ctx.createRadialGradient(0, -bootLen * 0.03, 0, 0, -bootLen * 0.03, bootWid * 0.82);
    archGrad.addColorStop(0.0, `rgba(${pitR + 16}, ${soleG}, 128, 0.76)`);
    archGrad.addColorStop(0.72, `rgba(${pitR + 34}, ${Math.round(soleG * 0.82)}, 128, 0.44)`);
    archGrad.addColorStop(1.0, 'rgba(128, 0, 128, 0.0)');
    ctx.fillStyle = archGrad;
    ctx.beginPath();
    ctx.ellipse(0, -bootLen * 0.03, bootWid * 0.68, bootLen * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();

    // Forefoot ball
    const ballGrad = ctx.createRadialGradient(0, bootLen * 0.21, 0, 0, bootLen * 0.21, bootWid * 0.98);
    ballGrad.addColorStop(0.0, `rgba(${pitR}, ${soleG}, 128, 0.94)`);
    ballGrad.addColorStop(0.64, `rgba(${pitR + 18}, ${soleG}, 128, 0.68)`);
    ballGrad.addColorStop(1.0, 'rgba(128, 0, 128, 0.0)');
    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.ellipse(0, bootLen * 0.21, bootWid * 0.84, bootLen * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();

    // Heel cup
    const heelGrad = ctx.createRadialGradient(0, -bootLen * 0.26, 0, 0, -bootLen * 0.26, bootWid * 0.86);
    heelGrad.addColorStop(0.0, `rgba(${pitR}, ${soleG}, 128, 0.90)`);
    heelGrad.addColorStop(0.68, `rgba(${pitR + 20}, ${soleG}, 128, 0.58)`);
    heelGrad.addColorStop(1.0, 'rgba(128, 0, 128, 0.0)');
    ctx.fillStyle = heelGrad;
    ctx.beginPath();
    ctx.ellipse(0, -bootLen * 0.26, bootWid * 0.72, bootLen * 0.36, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
    dirty = true;
  }

  /**
   * Carves a continuous sand-slide furrow down steep barchan slipfaces.
   */
  function stampSlideFurrow(wx, wz, yaw, intensity = 0.8) {
    const { px, py } = worldToPx(wx, wz);
    if (px < -24 || px > MAP_RES + 24 || py < -24 || py > MAP_RES + 24) return;
    const pxPerM = MAP_RES / MAP_WORLD_SIZE;
    const rad = 0.48 * pxPerM;

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(yaw);

    // Outer plowed ridge
    const rimGrad = ctx.createRadialGradient(0, 0, rad * 0.4, 0, 0, rad * 1.45);
    rimGrad.addColorStop(0.0, 'rgba(188, 175, 128, 0.0)');
    rimGrad.addColorStop(0.62, `rgba(198, 185, 128, ${0.42 * intensity})`);
    rimGrad.addColorStop(1.0, 'rgba(128, 0, 128, 0.0)');
    ctx.fillStyle = rimGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, rad * 1.35, rad * 1.65, 0, 0, Math.PI * 2);
    ctx.fill();

    // Inner deep chute trough
    const troughGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, rad);
    troughGrad.addColorStop(0.0, `rgba(26, 235, 128, ${0.78 * intensity})`);
    troughGrad.addColorStop(0.65, `rgba(52, 200, 128, ${0.48 * intensity})`);
    troughGrad.addColorStop(1.0, 'rgba(128, 0, 128, 0.0)');
    ctx.fillStyle = troughGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, rad * 0.82, rad * 1.15, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
    dirty = true;
  }

  /**
   * Stamps a circular impact crater (landing from jump, planting Thumper, or worm surge).
   */
  function stampCrater(wx, wz, radiusM = 0.65, depth = 1.0) {
    const { px, py } = worldToPx(wx, wz);
    if (px < -40 || px > MAP_RES + 40 || py < -40 || py > MAP_RES + 40) return;
    const pxPerM = MAP_RES / MAP_WORLD_SIZE;
    const r = radiusM * pxPerM;

    const rim = ctx.createRadialGradient(px, py, r * 0.55, px, py, r * 1.55);
    rim.addColorStop(0.0, 'rgba(204, 175, 128, 0.0)');
    rim.addColorStop(0.55, `rgba(210, 185, 128, ${0.58 * depth})`);
    rim.addColorStop(1.0, 'rgba(128, 0, 128, 0.0)');
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(px, py, r * 1.55, 0, Math.PI * 2);
    ctx.fill();

    const pit = ctx.createRadialGradient(px, py, 0, px, py, r);
    pit.addColorStop(0.0, `rgba(20, 240, 128, ${0.86 * depth})`);
    pit.addColorStop(0.7, `rgba(55, 200, 128, ${0.52 * depth})`);
    pit.addColorStop(1.0, 'rgba(128, 0, 128, 0.0)');
    ctx.fillStyle = pit;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();

    dirty = true;
  }

  function addWaterRipple(wx, wz, strength = 1.0) {
    const t = worldState ? worldState.elapsed : 0;
    waterRipples[nextRippleIdx].set(wx, wz, t, strength);
    nextRippleIdx = (nextRippleIdx + 1) % MAX_WATER_RIPPLES;
  }

  function clearAll() {
    clearToNeutral(ctx);
    fadeAccum = 0;
    dirty = false;
    texture.needsUpdate = true;
    for (let i = 0; i < MAX_WATER_RIPPLES; i++) {
      waterRipples[i].set(0, 0, -999, 0);
    }
  }

  /**
   * Deterministic helper that clears existing trails, centers the high-res trail window on (cx, cz),
   * and stamps a curved, irregular Fremen Sandwalk footprint trail leading into a short crest slide furrow.
   */
  function seedShowcaseTrail(cx = 3.2, cz = -30.5, yaw = 0.35, steps = 14, isSandwalk = true) {
    clearAll();
    recenter(cx, cz, true);

    const count = Math.max(2, Math.floor(steps));
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    const sStart = -2.45;
    const sSpan = 5.95;

    for (let i = 0; i < count; i++) {
      const u = i / (count - 1);
      // Irregular "walk without rhythm" cadence when Sandwalking, deterministic across runs
      const cadenceJitter = isSandwalk
        ? (Math.sin(i * 2.35 + 0.6) * 0.08 + Math.cos(i * 3.7) * 0.04) * (1.0 - Math.abs(2.0 * u - 1.0) * 0.35)
        : 0.0;
      const s = sStart + u * sSpan + cadenceJitter;

      const curvePhase = u * Math.PI * 1.45 - 0.35;
      const sway = Math.sin(curvePhase) * 0.34;
      const swaySlope = ((Math.PI * 1.45) / sSpan) * Math.cos(curvePhase) * 0.34;
      const stepYaw = yaw - Math.atan(swaySlope);

      const isLeft = i % 2 === 0;
      const stance = (isLeft ? -0.175 : 0.175) + (isSandwalk ? Math.sin(i * 1.9) * 0.035 : 0.0);
      const lat = sway + stance;

      const wx = cx + fwdX * s + rightX * lat;
      const wz = cz + fwdZ * s + rightZ * lat;
      const depth = 1.08 + 0.14 * Math.sin(i * 1.7 + 0.4);
      stampFootprint(wx, wz, stepYaw, isLeft, depth, isSandwalk);
    }

    // Short sand-slide chute cresting over the dune brink right ahead of the final steps
    const endCurvePhase = Math.PI * 1.45 - 0.35;
    const endSway = Math.sin(endCurvePhase) * 0.34;
    const furrowYaw = yaw + 0.12;
    const fFwdX = -Math.sin(furrowYaw);
    const fFwdZ = -Math.cos(furrowYaw);
    const baseX = cx + fwdX * (sStart + sSpan + 0.22) + rightX * endSway;
    const baseZ = cz + fwdZ * (sStart + sSpan + 0.22) + rightZ * endSway;
    for (let k = 0; k < 5; k++) {
      const fs = k * 0.26;
      const intensity = 0.72 + 0.22 * Math.sin((k / 4) * Math.PI);
      stampSlideFurrow(baseX + fFwdX * fs, baseZ + fFwdZ * fs, furrowYaw, intensity);
    }

    fadeAccum = 0;
    dirty = false;
    texture.needsUpdate = true;
  }

  function update(dt) {
    if (!worldState) return;
    const step = Math.min(Math.max(dt || 0, 0), 0.1);

    // Keep footprint window smoothly centered on player when walking
    if (worldState.player?.active) {
      recenter(worldState.player.feetPosition.x, worldState.player.feetPosition.z);
    }

    // Eolian wind healing: footprints slowly blow shut over ~55s in calm air, ~14s in Coriolis storm
    if (step > 0) {
      fadeAccum += step;
      if (fadeAccum >= 0.14) {
        const healAlpha = Math.min(0.18, fadeAccum * (0.016 + worldState.windSpeed * 0.036));
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = `rgba(128, 0, 128, ${healAlpha.toFixed(4)})`;
        ctx.fillRect(0, 0, MAP_RES, MAP_RES);
        fadeAccum = 0;
        dirty = true;
      }

      // Gentle ambient morning/night dew-drips from overhanging Tamarisk boughs into cistern
      dewDripCooldown -= step;
      if (dewDripCooldown <= 0) {
        dewDripCooldown = 1.6 + Math.random() * 2.4;
        const spot = DEW_DRIP_SPOTS[Math.floor(Math.random() * DEW_DRIP_SPOTS.length)];
        const ox = spot.x + (Math.random() - 0.5) * 0.9;
        const oz = spot.z + (Math.random() - 0.5) * 0.9;
        if (Math.hypot(ox - CISTERN_CENTER.x, oz - CISTERN_CENTER.z) < 6.4) {
          addWaterRipple(ox, oz, 0.34);
        }
      }
    }

    if (dirty) {
      texture.needsUpdate = true;
      dirty = false;
    }
  }

  return {
    texture,
    origin,
    worldSize: MAP_WORLD_SIZE,
    waterRipples,
    recenter,
    stampFootprint,
    stampSlideFurrow,
    stampCrater,
    seedShowcaseTrail,
    addWaterRipple,
    clearAll,
    update,
    dispose() {
      texture.dispose();
    }
  };
}
