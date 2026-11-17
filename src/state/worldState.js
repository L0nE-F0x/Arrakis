import * as THREE from 'three';

export const WEATHER_MODES = [
  'calm',
  'mirage',
  'saltation',
  'dustDevil',
  'spiceBlow',
  'coriolisStorm'
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
      position: new THREE.Vector3(8.5, 0, -14.5)
    };

    this.worm = {
      phase: 'patrol',
      patrolAngle: 0.4,
      position: new THREE.Vector3(-25, 0, -125),
      heading: 0.32,
      breachProgress: 0,
      breachTimer: 16,
      breachOrigin: new THREE.Vector3(12, 0, -106),
      tremor: 0
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

  triggerThumper() {
    this.thumper.active = true;
    this.thumper.timer = 18.0;
    this.thumper.pulsePhase = 0;
    this.worm.breachTimer = Math.min(this.worm.breachTimer, 3.2);
    this.worm.breachOrigin.set(12 + Math.sin(this.elapsed) * 14, 0, -104 - Math.random() * 14);
  }

  triggerBreach(originX = 12, originZ = -106, initialProgress = 0) {
    this.worm.phase = 'breach';
    this.worm.breachProgress = initialProgress;
    this.worm.breachOrigin.set(originX, 0, originZ);
    this.worm.position.set(originX, 0, originZ);
    this.worm.heading = 0.38;
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
      if (this.weatherTimer > 28) {
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

    // Diurnal solar arc:
    // - Dawn (6.25..6.65): low golden sun in NNE gap (+0.16..+0.20, +0.08..+0.13, -0.97) casting a luminous path across Dew Cistern!
    // - Noon (12.2): climbs high East-South (+0.64, +0.74, +0.20) for crisp Yardang/Oasis shadows
    // - Golden Hour (17.25..17.35): raking western sun (-0.62, +0.165, -0.76) above Erg crests for dramatic 3D barchan sculpting!
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

    // Asymmetric diagonal celestial triad elevated cleanly above all Erg ridges & framed inside Tamarisk Canopy!
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

    // Authentic deep desert darkness at night & eclipse totality (no daylight-bright tan night!)
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
      this.worm.patrolAngle += step * 0.085;
      if (this.worm.phase === 'patrol') {
        this.worm.breachTimer -= step;
        const px = Math.sin(this.worm.patrolAngle) * 74;
        const pz = -122 - Math.cos(this.worm.patrolAngle * 0.7) * 30;
        const vx = Math.cos(this.worm.patrolAngle) * 74 * 0.085;
        const vz = Math.sin(this.worm.patrolAngle * 0.7) * 30 * 0.085 * 0.7;
        this.worm.position.set(px, 0, pz);
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
      } else if (this.worm.phase === 'breach') {
        this.worm.breachProgress += step / 8.8;
        const p = this.worm.breachProgress;
        this.worm.tremor = Math.sin(Math.min(1, p) * Math.PI) * 0.95;
        this.worm.position.copy(this.worm.breachOrigin);
        if (p >= 1.0) {
          this.worm.phase = 'patrol';
          this.worm.breachProgress = 0;
          this.worm.breachTimer = 20 + Math.random() * 14;
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
  }
}
