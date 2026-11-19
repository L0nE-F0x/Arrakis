import * as THREE from 'three';

export const WEATHER_MODES = [
  'calm',
  'mirage',
  'saltation',
  'dustDevil',
  'spiceBlow',
  'coriolisStorm'
];

export const QUALITY_PRESETS = {
  balanced: {
    label: 'Balanced',
    pixelRatioCap: 1.5,
    shadowMapSize: 2048,
    shadowRadius: 1.8,
    godRaySamples: 12,
    particleScale: 0.72,
    waterRes: 768
  },
  ultra: {
    label: 'Ultra',
    pixelRatioCap: 2.0,
    shadowMapSize: 3072,
    shadowRadius: 2.2,
    godRaySamples: 20,
    particleScale: 1.0,
    waterRes: 1024
  },
  overdrive: {
    label: 'Overdrive',
    pixelRatioCap: 2.5,
    shadowMapSize: 4096,
    shadowRadius: 2.6,
    godRaySamples: 28,
    particleScale: 1.45,
    waterRes: 1536
  }
};

export const ARRAKIS_LANDMARKS = [
  {
    id: 'cistern',
    name: 'Sietch Dew Cistern',
    kicker: 'SACRED WATER',
    lore: 'Windtrap-fed spring pool rimmed by nocturnal spice lilies and desert reeds.',
    x: 0.0,
    z: 3.8,
    radius: 9.5,
    color: '#6ec6ff'
  },
  {
    id: 'muaddib',
    name: "Muad'Dib Hollow",
    kicker: 'DESERT ECOLOGY',
    lore: 'Foraging burrow of the desert kangaroo mouse — teacher of water discipline.',
    x: 3.16,
    z: 8.92,
    radius: 4.5,
    color: '#f2b872'
  },
  {
    id: 'camp',
    name: 'Yardang Sanctuary Camp',
    kicker: 'FREMEN BIVOUAC',
    lore: 'Sheltered wind-canopy bivouac lit by a hammered brass spice-oil brazier.',
    x: -14.5,
    z: 5.5,
    radius: 7.5,
    color: '#ff9d52'
  },
  {
    id: 'arch',
    name: 'Sandstone Wind Arch',
    kicker: 'EOLIAN MONOLITH',
    lore: 'Millennia of Coriolis scouring carved this bridge between stratified yardangs.',
    x: -24.5,
    z: -1.5,
    radius: 8.5,
    color: '#e5a468'
  },
  {
    id: 'windtrap',
    name: 'Fremen Badgir Windtrap',
    kicker: 'MOISTURE SPIRE',
    lore: 'Subterranean cooling flutes draw precious dew from scorching desert gusts.',
    x: -21.0,
    z: -25.0,
    radius: 10.0,
    color: '#ffd089'
  },
  {
    id: 'ornithopter',
    name: 'Downed Ornithopter Wreck',
    kicker: 'IMPERIAL RELIC',
    lore: 'Half-swallowed by the Erg — articulated dragonfly wings still creak in the wind.',
    x: 26.0,
    z: -56.0,
    radius: 11.5,
    color: '#ff705c'
  },
  {
    id: 'spice',
    name: 'Pre-Spice Mélange Crater',
    kicker: 'THE SPICE MUST FLOW',
    lore: 'Cinnamon-blue mélange seams vent from a deep subterranean sandtrout pocket.',
    x: -21.0,
    z: -68.0,
    radius: 14.0,
    color: '#5ec2ff'
  }
];

const WEATHER_LABELS = {
  calm: 'Calm Oasis',
  mirage: 'Heat Mirage',
  saltation: 'Dune Drift',
  dustDevil: 'Dust Devils',
  spiceBlow: 'Spice Blow',
  coriolisStorm: 'Coriolis Storm'
};

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class WorldState {
  constructor() {
    this.elapsed = 0;
    this.timeOfDay = 6.45;
    this.autoTime = true;
    this.timeSpeed = 0.14;

    this.quality = 'ultra';

    this.autoWeather = true;
    this.targetWeather = 'calm';
    this.weatherTimer = 0;
    this.weatherWeights = {
      calm: 1,
      mirage: 0.15,
      saltation: 0.25,
      dustDevil: 0,
      spiceBlow: 0,
      coriolisStorm: 0
    };

    this.baseWind = 0.45;
    this.windSpeed = 0.45;
    this.windAngle = 0.42;
    this.windDir = new THREE.Vector2(Math.cos(this.windAngle), Math.sin(this.windAngle));
    this.windGust = 0;

    this.eclipseActive = false;
    this.eclipseStrength = 0;

    this.lightningFlash = 0;
    this.lightningCooldown = 2.0;
    this.lightningSeed = 1.0;

    this.sunDir = new THREE.Vector3(0.22, 0.14, -0.96).normalize();
    this.moonKrellnDir = new THREE.Vector3(-0.14, 0.26, -0.955).normalize();
    this.moonArvonDir = new THREE.Vector3(0.12, 0.17, -0.978).normalize();
    this.gasGiantDir = new THREE.Vector3(0.38, 0.30, -0.875).normalize();

    this.sunColor = new THREE.Color(0xffcfa0);
    this.skyZenithColor = new THREE.Color(0x4b6088);
    this.skyHorizonColor = new THREE.Color(0xe6ac7c);
    this.fogColor = new THREE.Color(0xdfa475);
    this.ambientSkyColor = new THREE.Color(0xcfa88a);
    this.ambientGroundColor = new THREE.Color(0x885c3a);
    this.sunIntensity = 3.0;
    this.moonIntensity = 1.6;
    this.ambientIntensity = 1.0;
    this.fogDensity = 0.0022;
    this.exposure = 1.06;

    this.thumper = {
      active: false,
      timer: 0,
      pulsePhase: 0,
      pulseStrength: 0,
      position: new THREE.Vector3(8.5, 0, -14.5),
      plantedByPlayer: false
    };

    this.worm = {
      phase: 'patrol', // 'patrol' | 'hunting' | 'breach'
      patrolAngle: 0.4,
      position: new THREE.Vector3(-25, 0, -125),
      headPos: new THREE.Vector3(-25, 0, -125),
      heading: 0.32,
      breachProgress: 0,
      breachTimer: 22,
      breachOrigin: new THREE.Vector3(12, 0, -106),
      huntTarget: new THREE.Vector3(12, 0, -106),
      huntSource: 'thumper', // 'thumper' | 'player'
      wormsignIntensity: 0,
      tremor: 0,
      cooldown: 0
    };

    this.spiceBlow = {
      origin: new THREE.Vector3(-21, 0, -68),
      intensity: 0
    };

    this.dustDevils = [
      { x: -35.0, z: -72, vx: 1.1, vz: -0.4, radius: 3.4, height: 28, spin: 4.8, strength: 0 },
      { x: -9.5, z: -54, vx: -0.9, vz: -0.4, radius: 2.9, height: 24, spin: -4.4, strength: 0 },
      { x: 2.5, z: -64, vx: 0.8, vz: -0.5, radius: 3.2, height: 26, spin: 4.1, strength: 0 }
    ];

    // First-person Fremen Explorer state
    this.player = {
      active: false,
      pointerLocked: false,
      position: new THREE.Vector3(0.55, 1.8, 14.2),
      feetPosition: new THREE.Vector3(0.55, 0.9, 14.2),
      velocity: new THREE.Vector3(),
      yaw: 0.0,
      pitch: -0.04,
      speed: 0,
      grounded: true,
      crouching: false,
      sprinting: false,
      sandwalking: false,
      sliding: false,
      slideIntensity: 0,
      inWater: false,
      waterDepth: 0,
      onOpenErg: false,
      sheltered: false,
      surfaceType: 'sand', // 'sand' | 'rock' | 'water' | 'path'
      hydration: 1.0,
      spiceCollected: 0,
      spiceTrance: 0,
      glowglobeOn: false,
      glowglobePos: new THREE.Vector3(0.2, 2.2, 14.2),
      opticsActive: false,
      opticsZoom: 1.0,
      opticsTarget: null,
      thumperAiming: false,
      wormThreat: 0,
      seismicPulse: 0,
      seismicSamples: new Float32Array(64),
      seismicCursor: 0,
      stormExposure: 0,
      screenShake: 0,
      footstepsCount: 0,
      muadDibFed: false,
      nearbyPrompt: null,
      discoveredIds: new Set(['cistern']),
      toastQueue: []
    };

    this.cameraMode = 'director';
    this.paused = false;

    this._tmpColorA = new THREE.Color();
    this._tmpColorB = new THREE.Color();
    this._baseSun = new THREE.Vector3();
    this._noonSun = new THREE.Vector3(0.64, 0.74, 0.20).normalize();
    this._eclipseSun = new THREE.Vector3(-0.06, 0.345, -0.937).normalize();
    this._natKrelln = new THREE.Vector3();
    this.update(0.016);
  }

  getQualityConfig() {
    return QUALITY_PRESETS[this.quality] || QUALITY_PRESETS.ultra;
  }

  setQuality(tier) {
    if (QUALITY_PRESETS[tier]) {
      this.quality = tier;
    }
  }

  pushToast(kicker, title, detail = '') {
    this.player.toastQueue.push({ kicker, title, detail, time: this.elapsed });
    if (this.player.toastQueue.length > 6) {
      this.player.toastQueue.shift();
    }
  }

  markDiscovered(id) {
    if (this.player.discoveredIds.has(id)) return false;
    const lm = ARRAKIS_LANDMARKS.find(l => l.id === id);
    if (!lm) return false;
    this.player.discoveredIds.add(id);
    this.pushToast(
      `DISCOVERY ${this.player.discoveredIds.size}/${ARRAKIS_LANDMARKS.length} · ${lm.kicker}`,
      lm.name,
      lm.lore
    );
    return true;
  }

  setWeather(mode) {
    if (WEATHER_MODES.includes(mode)) {
      this.targetWeather = mode;
      this.weatherTimer = 0;
    }
  }

  setTimeOfDay(hours, eclipse = false) {
    this.timeOfDay = ((hours % 24) + 24) % 24;
    this.eclipseActive = Boolean(eclipse);
  }

  triggerThumper(x = null, z = null, plantedByPlayer = false) {
    if (typeof x === 'number' && typeof z === 'number') {
      this.thumper.position.set(x, 0, z);
    }
    this.thumper.plantedByPlayer = plantedByPlayer;
    this.thumper.active = true;
    this.thumper.timer = 24.0;
    this.thumper.pulsePhase = 0;

    // Direct Shai-Hulud to hunt toward the Thumper!
    const tx = this.thumper.position.x;
    const tz = this.thumper.position.z;
    // Keep breach target safely outside the rocky cistern core so the worm surges in open dunes!
    const targetX = tx;
    const targetZ = Math.min(tz - 12.0, -34.0);
    if (this.worm.phase !== 'breach') {
      this.worm.phase = 'hunting';
      this.worm.huntSource = 'thumper';
      this.worm.huntTarget.set(targetX, 0, targetZ);
      // Spawn approach reasonably close in deep erg if currently very far
      const dist = Math.hypot(this.worm.position.x - targetX, this.worm.position.z - targetZ);
      if (dist > 115 || dist < 24) {
        const ang = Math.atan2(targetX, targetZ + 140) + (Math.random() - 0.5) * 0.7;
        this.worm.position.set(
          targetX + Math.sin(ang) * 78,
          0,
          targetZ - 64 - Math.random() * 20
        );
      }
      this.worm.breachOrigin.set(targetX, 0, targetZ);
      this.worm.breachTimer = 4.2;
    }
  }

  triggerWormHunt(targetX, targetZ, source = 'player') {
    if (this.worm.phase === 'breach' || this.worm.cooldown > 0) return;
    this.worm.phase = 'hunting';
    this.worm.huntSource = source;
    this.worm.huntTarget.set(targetX, 0, Math.min(targetZ, -26.0));
    const dist = Math.hypot(this.worm.position.x - targetX, this.worm.position.z - this.worm.huntTarget.z);
    if (dist > 110 || dist < 28) {
      const side = Math.random() > 0.5 ? 1 : -1;
      this.worm.position.set(
        targetX + side * (42 + Math.random() * 26),
        0,
        this.worm.huntTarget.z - (58 + Math.random() * 24)
      );
    }
  }

  triggerBreach(originX = 12, originZ = -106, initialProgress = 0, heading = 0.38) {
    this.worm.phase = 'breach';
    this.worm.breachProgress = initialProgress;
    this.worm.breachOrigin.set(originX, 0, originZ);
    this.worm.position.set(originX, 0, originZ);
    this.worm.heading = heading;
  }

  getWeatherLabel() {
    return WEATHER_LABELS[this.targetWeather] || 'Calm Oasis';
  }

  getClockString() {
    const h = Math.floor(this.timeOfDay);
    const m = Math.floor((this.timeOfDay - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  update(dt) {
    const step = this.paused ? 0 : Math.min(dt, 0.05);
    this.elapsed += step;

    if (this.autoTime && step > 0) {
      this.timeOfDay = (this.timeOfDay + step * this.timeSpeed) % 24;
      if (this.eclipseActive && Math.abs(this.timeOfDay - 11.4) > 1.2) {
        this.eclipseActive = false;
      }
    }

    if (this.autoWeather && step > 0) {
      this.weatherTimer += step;
      if (this.weatherTimer > 34) {
        this.weatherTimer = 0;
        const idx = (WEATHER_MODES.indexOf(this.targetWeather) + 1) % WEATHER_MODES.length;
        this.targetWeather = WEATHER_MODES[idx];
      }
    }

    const lerpRate = Math.min(1, step * 0.85 || 1);
    const targets = {
      calm: this.targetWeather === 'calm' ? 1 : 0,
      mirage: this.targetWeather === 'mirage' ? 1 : this.targetWeather === 'calm' ? 0.12 : 0,
      saltation:
        this.targetWeather === 'saltation'
          ? 1
          : this.targetWeather === 'coriolisStorm'
            ? 0.85
            : this.targetWeather === 'spiceBlow'
              ? 0.35
              : 0.18,
      dustDevil:
        this.targetWeather === 'dustDevil'
          ? 1
          : this.targetWeather === 'spiceBlow'
            ? 0.90
            : 0,
      spiceBlow: this.targetWeather === 'spiceBlow' ? 1 : 0,
      coriolisStorm: this.targetWeather === 'coriolisStorm' ? 1 : 0
    };
    for (const k of WEATHER_MODES) {
      this.weatherWeights[k] += (targets[k] - this.weatherWeights[k]) * lerpRate;
    }

    const targetEclipse = this.eclipseActive ? 1 : 0;
    this.eclipseStrength += (targetEclipse - this.eclipseStrength) * Math.min(1, step * 2.2 || 1);

    this.windGust =
      0.18 * Math.sin(this.elapsed * 0.55) +
      0.11 * Math.sin(this.elapsed * 1.43 + 1.2) +
      0.06 * Math.cos(this.elapsed * 3.1);
    const stormWindBoost =
      this.weatherWeights.saltation * 0.35 +
      this.weatherWeights.dustDevil * 0.28 +
      this.weatherWeights.spiceBlow * 0.25 +
      this.weatherWeights.coriolisStorm * 0.92;
    this.windSpeed = Math.max(0.05, this.baseWind + stormWindBoost + this.windGust * 0.35);
    const dynamicAngle = this.windAngle + 0.12 * Math.sin(this.elapsed * 0.18);
    this.windDir.set(Math.cos(dynamicAngle), Math.sin(dynamicAngle));

    if (this.weatherWeights.coriolisStorm > 0.28 && step > 0) {
      this.lightningCooldown -= step;
      if (this.lightningCooldown <= 0) {
        this.lightningFlash = 0.85 + Math.random() * 0.85;
        this.lightningSeed = this.elapsed * 13.7 + Math.random() * 97.3;
        this.lightningCooldown = 1.5 + Math.random() * 3.8;
      }
    }
    this.lightningFlash *= Math.pow(0.018, step);

    // Diurnal solar arc
    const dayAngle = ((this.timeOfDay - 5.85) / 24.0) * Math.PI * 2.0;
    const naturalElev = Math.sin(dayAngle) * 0.64;
    const isEvening = dayAngle > Math.PI * 0.5;
    const azimSpan = isEvening ? 0.68 : 0.20;
    const naturalAzim = Math.cos(dayAngle) * azimSpan;
    const zComponent = isEvening ? -0.74 : -0.95;
    this._baseSun.set(
      naturalAzim,
      Math.sin(naturalElev),
      zComponent - Math.abs(Math.sin(dayAngle)) * 0.05
    ).normalize();
    const rawNoonArc = Math.pow(Math.max(0, Math.sin(dayAngle)), 2.2);
    const noonArc = smoothstep(0.08, 0.96, rawNoonArc);
    this.sunDir.copy(this._baseSun).lerp(this._noonSun, noonArc).normalize();
    this.sunDir.lerp(this._eclipseSun, this.eclipseStrength).normalize();

    const krellnOrbit = this.elapsed * 0.018 + this.timeOfDay * 0.04 + 0.45;
    this._natKrelln.set(
      -0.11 + Math.sin(krellnOrbit) * 0.035,
      0.338 + 0.018 * Math.cos(krellnOrbit * 0.7),
      -0.934
    ).normalize();
    const totalityLock = smoothstep(0.65, 0.85, this.eclipseStrength);
    const krellnAlign = this.eclipseStrength * (0.996 + 0.004 * totalityLock);
    this.moonKrellnDir.copy(this._natKrelln).lerp(this.sunDir, krellnAlign).normalize();

    const arvonOrbit = -this.elapsed * 0.024 + this.timeOfDay * 0.05 + 1.65;
    this.moonArvonDir.set(
      0.10 + Math.cos(arvonOrbit) * 0.035,
      0.292 + 0.016 * Math.sin(arvonOrbit * 0.8),
      -0.951
    ).normalize();

    const planetPhase = this.elapsed * 0.006 + 0.32;
    this.gasGiantDir.set(
      0.32 + Math.sin(planetPhase) * 0.025,
      0.345 + Math.cos(planetPhase * 0.5) * 0.014,
      -0.882
    ).normalize();

    const sy = this.sunDir.y;
    const dayFactor = smoothstep(-0.06, 0.20, sy);
    const noonFactor = smoothstep(0.22, 0.58, sy);
    const goldenFactor = Math.exp(-Math.pow((sy - 0.12) / 0.14, 2.0));
    const twilightFactor = Math.exp(-Math.pow((sy + 0.01) / 0.10, 2.0));
    const nightFactor = 1.0 - smoothstep(-0.18, 0.03, sy);

    this.sunColor.setHex(0xfff1dc)
      .lerp(this._tmpColorA.setHex(0xffbf78), goldenFactor * 0.80)
      .lerp(this._tmpColorB.setHex(0xff7d4e), twilightFactor * 0.72)
      .lerp(this._tmpColorA.setHex(0xa8c4f0), this.eclipseStrength * 0.88);

    this.skyZenithColor.setHex(0x0a1328)
      .lerp(this._tmpColorA.setHex(0x273b6b), twilightFactor * 0.78)
      .lerp(this._tmpColorB.setHex(0x4974ae), dayFactor * 0.88)
      .lerp(this._tmpColorA.setHex(0x3869a6), noonFactor * 0.70);

    this.skyHorizonColor.setHex(0x182644)
      .lerp(this._tmpColorA.setHex(0xdc7d58), twilightFactor * 0.84)
      .lerp(this._tmpColorB.setHex(0xf5be86), goldenFactor * 0.84)
      .lerp(this._tmpColorA.setHex(0xf1d1a2), noonFactor * 0.82);

    const storm = this.weatherWeights.coriolisStorm;
    const eclipseDim = 1.0 - this.eclipseStrength * 0.72;

    if (storm > 0.01) {
      this.skyZenithColor.lerp(this._tmpColorA.setHex(0x1f110a), storm * 0.92);
      this.skyHorizonColor.lerp(this._tmpColorB.setHex(0x6e3b1c), storm * 0.92);
    }
    if (this.eclipseStrength > 0.01) {
      this.skyZenithColor.lerp(this._tmpColorA.setHex(0x0d152c), this.eclipseStrength * 0.88);
      this.skyHorizonColor.lerp(this._tmpColorB.setHex(0x7c4842), this.eclipseStrength * 0.76);
    }

    this.fogColor.copy(this.skyHorizonColor).lerp(this.skyZenithColor, 0.14);

    const moonDayFade = 1.0 - smoothstep(0.01, 0.08, sy);
    this.sunIntensity = (0.18 + dayFactor * 2.82 + noonFactor * 0.88) * (1.0 - storm * 0.68) * eclipseDim;
    this.moonIntensity = ((nightFactor * 2.25 + twilightFactor * 1.15) * moonDayFade + this.eclipseStrength * 1.35) * (1.0 - storm * 0.45);

    const nightDarkAtten = 1.0 - nightFactor * 0.66;
    this.ambientIntensity = (1.18 * nightDarkAtten + dayFactor * 0.32 + noonFactor * 0.10) * (0.42 + 0.58 * eclipseDim);

    this.ambientSkyColor.copy(this.skyZenithColor).lerp(this.skyHorizonColor, 0.58 * (1.0 - nightFactor * 0.55));
    this.ambientGroundColor.setHex(0x162038)
      .lerp(this._tmpColorA.setHex(0xc98f5c), dayFactor * 0.88 + twilightFactor * 0.34)
      .lerp(this._tmpColorB.setHex(0x26243c), this.eclipseStrength * 0.80)
      .lerp(this._tmpColorA.setHex(0x6e4226), storm * 0.54);

    this.fogDensity =
      0.0018 +
      noonFactor * 0.0005 +
      goldenFactor * 0.0007 +
      this.weatherWeights.saltation * 0.0020 +
      this.weatherWeights.spiceBlow * 0.0014 +
      storm * 0.0092;
    this.exposure = 1.05 + nightFactor * 0.14 + twilightFactor * 0.16 + this.eclipseStrength * 0.18 - noonFactor * 0.07;

    if (this.thumper.active && step > 0) {
      this.thumper.timer -= step;
      this.thumper.pulsePhase += step * 2.4;
      const wave = Math.max(0, Math.sin(this.thumper.pulsePhase * Math.PI * 2));
      this.thumper.pulseStrength = Math.pow(wave, 8.0);
      if (this.thumper.timer <= 0) {
        this.thumper.active = false;
        this.thumper.pulseStrength = 0;
      }
    } else {
      this.thumper.pulseStrength *= 0.9;
    }

    if (step > 0) {
      this.worm.cooldown = Math.max(0, this.worm.cooldown - step);
      this.worm.patrolAngle += step * 0.085;

      if (this.worm.phase === 'patrol') {
        this.worm.wormsignIntensity *= Math.exp(-step * 2.5);
        this.worm.breachTimer -= step;
        const px = Math.sin(this.worm.patrolAngle) * 74;
        const pz = -122 - Math.cos(this.worm.patrolAngle * 0.7) * 30;
        const vx = Math.cos(this.worm.patrolAngle) * 74 * 0.085;
        const vz = Math.sin(this.worm.patrolAngle * 0.7) * 30 * 0.085 * 0.7;
        this.worm.position.set(px, 0, pz);
        this.worm.headPos.set(px, 2.0, pz);
        this.worm.heading = Math.atan2(vx, vz);
        this.worm.tremor = 0.16 + this.thumper.pulseStrength * 0.45;
        if (this.worm.breachTimer <= 0) {
          this.worm.phase = 'breach';
          this.worm.breachProgress = 0;
          this.worm.breachOrigin.set(
            10 + Math.sin(this.elapsed * 0.37) * 20,
            0,
            -102 - (Math.cos(this.elapsed * 0.23) * 0.5 + 0.5) * 24
          );
          this.worm.heading = 0.38;
        }
      } else if (this.worm.phase === 'hunting') {
        // Actively track toward planted Thumper or noisy player in the Erg!
        if (this.worm.huntSource === 'thumper' && this.thumper.active) {
          this.worm.huntTarget.set(
            this.thumper.position.x,
            0,
            Math.min(this.thumper.position.z - 12.0, -32.0)
          );
        } else if (this.worm.huntSource === 'player' && this.player.active) {
          if (this.player.onOpenErg && !this.player.sandwalking) {
            this.worm.huntTarget.set(
              this.player.feetPosition.x,
              0,
              Math.min(this.player.feetPosition.z - 10.0, -28.0)
            );
          } else if (this.player.wormThreat < 0.15) {
            // Player escaped onto rock or hushed into Sandwalk — Maker loses track!
            this.worm.phase = 'patrol';
            this.worm.breachTimer = 18;
          }
        }

        const dx = this.worm.huntTarget.x - this.worm.position.x;
        const dz = this.worm.huntTarget.z - this.worm.position.z;
        const dist = Math.hypot(dx, dz);
        const speed = 17.5;
        if (dist > 0.5) {
          const nx = dx / dist;
          const nz = dz / dist;
          this.worm.position.x += nx * Math.min(dist, speed * step);
          this.worm.position.z += nz * Math.min(dist, speed * step);
          this.worm.heading = Math.atan2(nx, nz);
        }
        this.worm.headPos.set(this.worm.position.x, 3.0, this.worm.position.z);
        this.worm.wormsignIntensity = Math.min(1.0, this.worm.wormsignIntensity + step * 1.4);
        this.worm.tremor = 0.42 + (1.0 - Math.min(1.0, dist / 90.0)) * 0.55;

        if (dist < 22.0) {
          // Erupt in a colossal dramatic breach arcing across the target!
          const approachAngle = this.worm.heading;
          this.worm.phase = 'breach';
          this.worm.breachProgress = 0;
          this.worm.breachOrigin.set(
            this.worm.position.x - Math.sin(approachAngle) * 14.0,
            0,
            this.worm.position.z - Math.cos(approachAngle) * 14.0
          );
          this.worm.heading = approachAngle;
          // If it hunted the player, reset threat & apply thrilling shockwave shake
          if (this.worm.huntSource === 'player') {
            this.player.wormThreat = 0.0;
            this.player.screenShake = Math.max(this.player.screenShake, 1.0);
            this.pushToast('SHAI-HULUD!', 'Elder Maker Breach', 'Walk without rhythm — press [C] to Sandwalk in the Great Erg.');
          }
        }
      } else if (this.worm.phase === 'breach') {
        this.worm.wormsignIntensity *= Math.exp(-step * 2.0);
        this.worm.breachProgress += step / 8.8;
        const p = this.worm.breachProgress;
        this.worm.tremor = Math.sin(Math.min(1, p) * Math.PI) * 0.95;
        this.worm.position.copy(this.worm.breachOrigin);
        if (p >= 1.0) {
          this.worm.phase = 'patrol';
          this.worm.breachProgress = 0;
          this.worm.breachTimer = 22 + Math.random() * 14;
          this.worm.cooldown = 14.0;
          if (this.thumper.active && this.thumper.plantedByPlayer) {
            this.thumper.timer = Math.min(this.thumper.timer, 2.0);
          }
        }
      }
    } else if (this.worm.phase === 'breach') {
      this.worm.tremor = Math.sin(Math.min(1, this.worm.breachProgress) * Math.PI) * 0.95;
      this.worm.position.copy(this.worm.breachOrigin);
    }

    const devilBlend = this.weatherWeights.dustDevil;
    for (let i = 0; i < this.dustDevils.length; i++) {
      const d = this.dustDevils[i];
      d.strength = devilBlend;
      if (step > 0) {
        d.x += d.vx * step * (0.5 + this.windSpeed * 0.6);
        d.z += d.vz * step * (0.5 + this.windSpeed * 0.6);
        if (d.x > 62) d.x = -62;
        if (d.x < -62) d.x = 62;
        if (d.z > -36) d.z = -126;
        if (d.z < -126) d.z = -36;
      }
    }

    this.spiceBlow.intensity = this.weatherWeights.spiceBlow;

    // Decay spice trance & screen shake smoothly
    if (step > 0) {
      this.player.spiceTrance = Math.max(0, this.player.spiceTrance - step * 0.14);
      this.player.screenShake = Math.max(0, this.player.screenShake - step * 1.6);
    }
  }
}
