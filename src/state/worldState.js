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
    this.timeOfDay = 6.72;
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

    this.sunDir = new THREE.Vector3(0.22, 0.14, -0.96).normalize();
    this.moonKrellnDir = new THREE.Vector3(-0.08, 0.24, -0.96).normalize();
    this.moonArvonDir = new THREE.Vector3(0.20, 0.20, -0.96).normalize();
    this.gasGiantDir = new THREE.Vector3(0.40, 0.23, -0.89).normalize();

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
      heading: 0.25,
      breachProgress: 0,
      breachTimer: 16,
      breachOrigin: new THREE.Vector3(14, 0, -115),
      tremor: 0
    };

    this.spiceBlow = {
      origin: new THREE.Vector3(-22, 0, -68),
      intensity: 0
    };

    this.dustDevils = [
      { x: -34, z: -58, vx: 1.8, vz: -0.7, radius: 3.4, height: 22, spin: 4.5, strength: 0 },
      { x: 38, z: -88, vx: -1.4, vz: 0.9, radius: 4.2, height: 28, spin: -3.8, strength: 0 }
    ];

    this.cameraMode = 'director';
    this.paused = false;

    this._tmpColorA = new THREE.Color();
    this._tmpColorB = new THREE.Color();
    this._baseSun = new THREE.Vector3();
    this._noonSun = new THREE.Vector3(0.64, 0.74, 0.20).normalize();
    this._eclipseSun = new THREE.Vector3(-0.08, 0.24, -0.967).normalize();
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
    this.worm.breachTimer = Math.min(this.worm.breachTimer, 3.8);
    this.worm.breachOrigin.set(8 + Math.sin(this.elapsed) * 26, 0, -92 - Math.random() * 28);
  }

  triggerBreach(originX = 12, originZ = -105) {
    this.worm.phase = 'breach';
    this.worm.breachProgress = 0;
    this.worm.breachOrigin.set(originX, 0, originZ);
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
      saltation: this.targetWeather === 'saltation' ? 1 : this.targetWeather === 'coriolisStorm' ? 0.75 : 0.18,
      dustDevil: this.targetWeather === 'dustDevil' ? 1 : this.targetWeather === 'saltation' ? 0.35 : 0,
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
      this.weatherWeights.dustDevil * 0.25 +
      this.weatherWeights.coriolisStorm * 0.85;
    this.windSpeed = Math.max(0.05, this.baseWind + stormWindBoost + this.windGust * 0.35);
    const dynamicAngle = this.windAngle + 0.12 * Math.sin(this.elapsed * 0.18);
    this.windDir.set(Math.cos(dynamicAngle), Math.sin(dynamicAngle));

    if (this.weatherWeights.coriolisStorm > 0.28 && step > 0) {
      this.lightningCooldown -= step;
      if (this.lightningCooldown <= 0) {
        this.lightningFlash = 0.8 + Math.random() * 0.9;
        this.lightningCooldown = 1.6 + Math.random() * 4.5;
      }
    }
    this.lightningFlash *= Math.pow(0.015, step);

    // Wide diurnal solar arc: rises East (+0.31), arcs overhead Eastern-high (+0.64, +0.74, +0.20) at noon,
    // and sets West (-0.53) so dawn/golden/twilight vistas stay exact while noon lighting & shadows cohere 100%.
    const dayAngle = ((this.timeOfDay - 6.0) / 24.0) * Math.PI * 2.0;
    const naturalElev = Math.sin(dayAngle) * 0.60;
    const isEvening = dayAngle > Math.PI * 0.5;
    const azimSpan = isEvening ? 0.54 : 0.28;
    const naturalAzim = Math.cos(dayAngle) * azimSpan;
    this._baseSun.set(
      naturalAzim,
      Math.sin(naturalElev),
      -0.84 - Math.abs(Math.sin(dayAngle)) * 0.08
    ).normalize();
    const rawNoonArc = Math.pow(Math.max(0, Math.sin(dayAngle)), 2.0);
    const noonArc = smoothstep(0.042, 0.96, rawNoonArc);
    this.sunDir.copy(this._baseSun).lerp(this._noonSun, noonArc).normalize();
    this.sunDir.lerp(this._eclipseSun, this.eclipseStrength).normalize();

    // Krelln (slightly west-center), Arvon (right-center), Companion Planet (upper-right):
    // All sit cleanly east of western sunset so all 3 crescents share unified illumination!
    const krellnOrbit = this.elapsed * 0.022 + this.timeOfDay * 0.14 + 0.9;
    this._natKrelln.set(
      -0.12 + Math.sin(krellnOrbit) * 0.10,
      0.24 + 0.04 * Math.cos(krellnOrbit * 0.7),
      -0.96
    ).normalize();
    const totalityLock = smoothstep(0.65, 0.85, this.eclipseStrength);
    const krellnAlign = this.eclipseStrength * (0.996 + 0.004 * totalityLock);
    this.moonKrellnDir.copy(this._natKrelln).lerp(this.sunDir, krellnAlign).normalize();

    const arvonOrbit = -this.elapsed * 0.030 + this.timeOfDay * 0.18 + 2.0;
    this.moonArvonDir.set(
      0.17 + Math.cos(arvonOrbit) * 0.09,
      0.21 + 0.03 * Math.sin(arvonOrbit * 0.8),
      -0.96
    ).normalize();

    const planetPhase = this.elapsed * 0.008 + 0.35;
    this.gasGiantDir.set(
      0.42 + Math.sin(planetPhase) * 0.05,
      0.23 + Math.cos(planetPhase * 0.5) * 0.02,
      -0.89
    ).normalize();

    const sy = this.sunDir.y;
    const dayFactor = smoothstep(-0.08, 0.20, sy);
    const noonFactor = smoothstep(0.20, 0.58, sy);
    const goldenFactor = Math.exp(-Math.pow((sy - 0.11) / 0.13, 2.0));
    const twilightFactor = Math.exp(-Math.pow((sy + 0.01) / 0.11, 2.0));
    const nightFactor = 1.0 - smoothstep(-0.20, 0.04, sy);

    this.sunColor.setHex(0xfff1dc)
      .lerp(this._tmpColorA.setHex(0xffbf78), goldenFactor * 0.75)
      .lerp(this._tmpColorB.setHex(0xff8052), twilightFactor * 0.68);

    // Rich crisp desert sky: deep azure zenith at noon (NOT dull grey!) warming softly to golden horizon haze
    this.skyZenithColor.setHex(0x162240)
      .lerp(this._tmpColorA.setHex(0x364a78), twilightFactor * 0.72)
      .lerp(this._tmpColorB.setHex(0x4b74ac), dayFactor * 0.88)
      .lerp(this._tmpColorA.setHex(0x3c6da8), noonFactor * 0.68);

    this.skyHorizonColor.setHex(0x324064)
      .lerp(this._tmpColorA.setHex(0xd87b5a), twilightFactor * 0.82)
      .lerp(this._tmpColorB.setHex(0xf4bc86), goldenFactor * 0.82)
      .lerp(this._tmpColorA.setHex(0xf0cfa0), noonFactor * 0.82);

    const storm = this.weatherWeights.coriolisStorm;
    const eclipseDim = 1.0 - this.eclipseStrength * 0.50;

    if (storm > 0.01) {
      this.skyZenithColor.lerp(this._tmpColorA.setHex(0x50321f), storm * 0.85);
      this.skyHorizonColor.lerp(this._tmpColorB.setHex(0xa26438), storm * 0.88);
    }
    if (this.eclipseStrength > 0.01) {
      this.skyZenithColor.lerp(this._tmpColorA.setHex(0x141c34), this.eclipseStrength * 0.78);
      this.skyHorizonColor.lerp(this._tmpColorB.setHex(0xb05f3e), this.eclipseStrength * 0.72);
    }

    this.fogColor.copy(this.skyHorizonColor).lerp(this.skyZenithColor, 0.12);

    const moonDayFade = 1.0 - smoothstep(0.01, 0.08, sy);
    this.sunIntensity = (0.30 + dayFactor * 2.65 + noonFactor * 0.88) * (1.0 - storm * 0.64) * eclipseDim;
    this.moonIntensity = ((nightFactor * 2.45 + twilightFactor * 1.25) * moonDayFade + this.eclipseStrength * 0.95) * (1.0 - storm * 0.45);

    this.ambientIntensity = (1.26 + dayFactor * 0.24 + noonFactor * 0.08) * (0.78 + 0.22 * eclipseDim);

    this.ambientSkyColor.copy(this.skyZenithColor).lerp(this.skyHorizonColor, 0.66);
    this.ambientGroundColor.setHex(0x686a7c)
      .lerp(this._tmpColorA.setHex(0xc88e5b), dayFactor * 0.88 + twilightFactor * 0.44 + this.eclipseStrength * 0.30)
      .lerp(this._tmpColorB.setHex(0x76482a), storm * 0.52);

    this.fogDensity = 0.0018 + noonFactor * 0.0005 + goldenFactor * 0.0007 + this.weatherWeights.saltation * 0.0024 + storm * 0.0110;
    this.exposure = 1.06 + nightFactor * 0.44 + twilightFactor * 0.24 + this.eclipseStrength * 0.28 - noonFactor * 0.08;

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
        this.worm.position.set(
          Math.sin(this.worm.patrolAngle) * 78,
          0,
          -125 - Math.cos(this.worm.patrolAngle * 0.7) * 32
        );
        this.worm.heading = this.worm.patrolAngle;
        this.worm.tremor = 0.15 + this.thumper.pulseStrength * 0.45;
        if (this.worm.breachTimer <= 0) {
          this.worm.phase = 'breach';
          this.worm.breachProgress = 0;
          this.worm.breachOrigin.set(
            Math.sin(this.elapsed * 0.37) * 28,
            0,
            -95 - (Math.cos(this.elapsed * 0.23) * 0.5 + 0.5) * 35
          );
        }
      } else if (this.worm.phase === 'breach') {
        this.worm.breachProgress += step / 8.5;
        const p = this.worm.breachProgress;
        this.worm.tremor = Math.sin(Math.min(1, p) * Math.PI) * 0.9;
        this.worm.position.copy(this.worm.breachOrigin);
        if (p >= 1.0) {
          this.worm.phase = 'patrol';
          this.worm.breachProgress = 0;
          this.worm.breachTimer = 20 + Math.random() * 14;
        }
      }
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
        if (d.z > -28) d.z = -128;
        if (d.z < -128) d.z = -28;
      }
    }

    this.spiceBlow.intensity = this.weatherWeights.spiceBlow;
  }
}
