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

  function recenter(targetX, targetZ) {
    const dx = targetX - origin.x;
    const dz = targetZ - origin.y;
    if (Math.hypot(dx, dz) < 5.5) return;

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
   * Stamps a realistic Fremen boot footprint (raised displaced rim + recessed heel/toe trough).
   */
  function stampFootprint(wx, wz, yaw, isLeft = false, depth = 1.0, isSandwalk = false) {
    const { px, py } = worldToPx(wx, wz);
    if (px < -16 || px > MAP_RES + 16 || py < -16 || py > MAP_RES + 16) return;

    const pxPerM = MAP_RES / MAP_WORLD_SIZE;
    const bootLen = (isSandwalk ? 0.44 : 0.36) * pxPerM;
    const bootWid = 0.19 * pxPerM;
    const clampedDepth = Math.max(0.25, Math.min(1.35, depth));

    ctx.save();
    ctx.translate(px, py);
    // Align canvas rotation with Three.js yaw (forward = (-sin(yaw), -cos(yaw)) in XZ, canvas +Y is -Z)
    ctx.rotate(-yaw + (isLeft ? 0.08 : -0.08));

    // 1. Subtle outer displaced sand rim lip (R > 128, slight G disturbance)
    const rimGrad = ctx.createRadialGradient(0, 0, bootWid * 0.42, 0, 0, bootLen * 0.92);
    const rimR = Math.round(128 + 64 * clampedDepth);
    rimGrad.addColorStop(0.0, `rgba(${rimR}, 145, 128, 0.0)`);
    rimGrad.addColorStop(0.55, `rgba(${rimR}, 155, 128, ${0.46 * clampedDepth})`);
    rimGrad.addColorStop(1.0, `rgba(128, 0, 128, 0.0)`);
    ctx.fillStyle = rimGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, bootWid * 1.45, bootLen * 0.88, 0, 0, Math.PI * 2);
    ctx.fill();

    // 2. Sculpted boot-sole recessed depression (forefoot + heel)
    const pitR = Math.round(Math.max(10, 128 - 108 * clampedDepth));
    const soleG = Math.round(Math.min(255, 220 * clampedDepth));

    // Forefoot ball
    const ballGrad = ctx.createRadialGradient(0, bootLen * 0.20, 0, 0, bootLen * 0.20, bootWid * 0.95);
    ballGrad.addColorStop(0.0, `rgba(${pitR}, ${soleG}, 128, 0.92)`);
    ballGrad.addColorStop(0.65, `rgba(${pitR + 18}, ${soleG}, 128, 0.65)`);
    ballGrad.addColorStop(1.0, `rgba(128, 0, 128, 0.0)`);
    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.ellipse(0, bootLen * 0.20, bootWid * 0.78, bootLen * 0.44, 0, 0, Math.PI * 2);
    ctx.fill();

    // Heel cup
    const heelGrad = ctx.createRadialGradient(0, -bootLen * 0.26, 0, 0, -bootLen * 0.26, bootWid * 0.80);
    heelGrad.addColorStop(0.0, `rgba(${pitR}, ${soleG}, 128, 0.88)`);
    heelGrad.addColorStop(0.7, `rgba(${pitR + 20}, ${soleG}, 128, 0.55)`);
    heelGrad.addColorStop(1.0, `rgba(128, 0, 128, 0.0)`);
    ctx.fillStyle = heelGrad;
    ctx.beginPath();
    ctx.ellipse(0, -bootLen * 0.26, bootWid * 0.65, bootLen * 0.34, 0, 0, Math.PI * 2);
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
    ctx.rotate(-yaw);

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
    dirty = true;
    for (let i = 0; i < MAX_WATER_RIPPLES; i++) {
      waterRipples[i].set(0, 0, -999, 0);
    }
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
    stampFootprint,
    stampSlideFurrow,
    stampCrater,
    addWaterRipple,
    clearAll,
    update,
    dispose() {
      texture.dispose();
    }
  };
}
