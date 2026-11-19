// Procedural Web Audio Arrakis Soundscape & Interactive Fremen Foley Engine
// Synthesizes wind through canyon yardangs, blowing sand saltation, seismic Shai-Hulud rumble,
// Fremen footsteps (dry sand, irregular sandwalk, rock, gravel, cistern water wading),
// slipface sand-sliding avalanches, distance-attenuated Thumper strikes, camp fire crackle,
// spice harvest shimmer, discovery chords, and glowglobe suspensor hum with zero external files.

export function createSoundscape(worldState) {
  let ctx = null;
  let masterGain = null;
  let enabled = false;
  let userMuted = false;

  // Continuous ambient layers
  let windGain = null;
  let windFilterLow = null;
  let windFilterHigh = null;
  let saltGain = null;
  let saltFilter = null;
  let wormGain = null;
  let wormFilter = null;
  let droneGain = null;

  // Continuous dune sand-slide avalanche layer
  let slideGain = null;
  let slideFilter = null;

  // Proximity Windtrap resonant turbine layer
  let trapGain = null;

  // Shared noise buffers for zero-alloc foley triggers
  let pinkBuf = null;
  let whiteBuf = null;

  let lastThumperCycle = -1;
  let hawkTimer = 6.0;
  let lightningPrev = 0;
  let crackleTimer = 0.2;
  let targetSlide = 0;

  function makeNoiseBuffer(audioCtx, seconds = 4.0, color = 'pink') {
    const len = Math.floor(audioCtx.sampleRate * seconds);
    const buf = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      let brown = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        if (color === 'white') {
          data[i] = white * 0.45;
        } else if (color === 'brown') {
          brown = (brown + 0.02 * white) / 1.02;
          data[i] = brown * 3.2;
        } else {
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.96900 * b2 + white * 0.1538520;
          b3 = 0.86650 * b3 + white * 0.3104856;
          b4 = 0.55000 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.0168980;
          data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.08;
          b6 = white * 0.115926;
        }
      }
      const fade = Math.min(2048, Math.floor(len * 0.05));
      for (let i = 0; i < fade; i++) {
        const t = i / fade;
        const tailIdx = len - fade + i;
        const mixed = data[i] * t + data[tailIdx] * (1 - t);
        data[i] = mixed;
        data[tailIdx] = mixed;
      }
    }
    return buf;
  }

  function ensureContext() {
    if (ctx) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    ctx = new AudioCtx();

    masterGain = ctx.createGain();
    masterGain.gain.value = 0.0001;
    masterGain.connect(ctx.destination);

    pinkBuf = makeNoiseBuffer(ctx, 5.0, 'pink');
    whiteBuf = makeNoiseBuffer(ctx, 2.0, 'white');
    const brownBuf = makeNoiseBuffer(ctx, 5.0, 'brown');

    // 1. Canyon Wind
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = pinkBuf;
    windSrc.loop = true;

    windFilterLow = ctx.createBiquadFilter();
    windFilterLow.type = 'bandpass';
    windFilterLow.frequency.value = 220;
    windFilterLow.Q.value = 2.4;

    windFilterHigh = ctx.createBiquadFilter();
    windFilterHigh.type = 'lowpass';
    windFilterHigh.frequency.value = 900;

    windGain = ctx.createGain();
    windGain.gain.value = 0.18;

    windSrc.connect(windFilterLow);
    windFilterLow.connect(windFilterHigh);
    windFilterHigh.connect(windGain);
    windGain.connect(masterGain);
    windSrc.start();

    // 2. Sand Saltation Hiss
    const saltSrc = ctx.createBufferSource();
    saltSrc.buffer = pinkBuf;
    saltSrc.loop = true;

    saltFilter = ctx.createBiquadFilter();
    saltFilter.type = 'bandpass';
    saltFilter.frequency.value = 3400;
    saltFilter.Q.value = 0.9;

    saltGain = ctx.createGain();
    saltGain.gain.value = 0.04;

    saltSrc.connect(saltFilter);
    saltFilter.connect(saltGain);
    saltGain.connect(masterGain);
    saltSrc.start();

    // 3. Shai-Hulud Seismic Rumble
    const wormSrc = ctx.createBufferSource();
    wormSrc.buffer = brownBuf;
    wormSrc.loop = true;

    wormFilter = ctx.createBiquadFilter();
    wormFilter.type = 'lowpass';
    wormFilter.frequency.value = 85;
    wormFilter.Q.value = 1.6;

    wormGain = ctx.createGain();
    wormGain.gain.value = 0.02;

    wormSrc.connect(wormFilter);
    wormFilter.connect(wormGain);
    wormGain.connect(masterGain);
    wormSrc.start();

    // 4. Dune Slipface Sand-Slide Cascade Layer
    const slideSrc = ctx.createBufferSource();
    slideSrc.buffer = pinkBuf;
    slideSrc.loop = true;

    slideFilter = ctx.createBiquadFilter();
    slideFilter.type = 'bandpass';
    slideFilter.frequency.value = 1350;
    slideFilter.Q.value = 0.75;

    slideGain = ctx.createGain();
    slideGain.gain.value = 0.0001;

    slideSrc.connect(slideFilter);
    slideFilter.connect(slideGain);
    slideGain.connect(masterGain);
    slideSrc.start();

    // 5. Windtrap Badgir Proximity Cooling-Flute Drone
    trapGain = ctx.createGain();
    trapGain.gain.value = 0.0001;
    const trapOsc = ctx.createOscillator();
    trapOsc.type = 'triangle';
    trapOsc.frequency.value = 92.5;
    const trapFilt = ctx.createBiquadFilter();
    trapFilt.type = 'lowpass';
    trapFilt.frequency.value = 180;
    trapOsc.connect(trapFilt);
    trapFilt.connect(trapGain);
    trapGain.connect(masterGain);
    trapOsc.start();

    // 6. Subtle Phrygian/Desert Fifth Harmonic Pad
    droneGain = ctx.createGain();
    droneGain.gain.value = 0.04;
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 240;

    const freqs = [73.42, 110.0, 146.83]; // D2 - A2 - D3
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = f < 90 ? 0.34 : 0.15;
      osc.connect(g);
      g.connect(droneFilter);
      osc.start();
    }
    droneFilter.connect(droneGain);
    droneGain.connect(masterGain);
  }

  function playNoiseBurst(dur, freq, q, gainVal, useWhite = false, pitchDrop = 1.0) {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = useWhite ? whiteBuf : pinkBuf;
    const offset = Math.random() * Math.max(0.1, src.buffer.duration - dur - 0.1);

    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(freq, now);
    if (pitchDrop !== 1.0) {
      filt.frequency.exponentialRampToValueAtTime(Math.max(80, freq * pitchDrop), now + dur);
    }
    filt.Q.value = q;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gainVal, now + Math.min(0.02, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(filt);
    filt.connect(g);
    g.connect(masterGain);
    src.start(now, offset, dur + 0.02);
  }

  function playFootstep(surface = 'sand', intensity = 1.0, isSandwalk = false) {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    const jitter = 0.88 + Math.random() * 0.24;
    const amp = Math.min(1.4, Math.max(0.2, intensity));

    if (surface === 'water') {
      // Liquid cistern wading splash + bubble pop
      playNoiseBurst(0.22, 1150 * jitter, 1.1, 0.24 * amp, true, 0.55);
      const pop = ctx.createOscillator();
      pop.type = 'sine';
      pop.frequency.setValueAtTime(320 * jitter, now);
      pop.frequency.exponentialRampToValueAtTime(680 * jitter, now + 0.08);
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.045 * amp, now);
      pg.gain.exponentialRampToValueAtTime(0.0005, now + 0.09);
      pop.connect(pg);
      pg.connect(masterGain);
      pop.start(now);
      pop.stop(now + 0.1);
      return;
    }

    if (surface === 'rock' || surface === 'path') {
      // Crisp dry sandstone/gravel boot tap
      playNoiseBurst(0.08, (surface === 'rock' ? 2100 : 1650) * jitter, 1.8, 0.22 * amp, true, 0.72);
      const thud = ctx.createOscillator();
      thud.type = 'triangle';
      thud.frequency.setValueAtTime(145 * jitter, now);
      thud.frequency.exponentialRampToValueAtTime(52, now + 0.065);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.11 * amp, now);
      tg.gain.exponentialRampToValueAtTime(0.0005, now + 0.075);
      thud.connect(tg);
      tg.connect(masterGain);
      thud.start(now);
      thud.stop(now + 0.08);
      return;
    }

    // Dry Arrakis sand: soft weight thud + granular crystalline crunch (longer drag swish if sandwalking!)
    const crunchDur = isSandwalk ? 0.26 : 0.14;
    const crunchGain = (isSandwalk ? 0.18 : 0.28) * amp;
    playNoiseBurst(crunchDur, (isSandwalk ? 1750 : 2450) * jitter, 0.85, crunchGain, false, 0.68);

    const softThud = ctx.createOscillator();
    softThud.type = 'sine';
    softThud.frequency.setValueAtTime(isSandwalk ? 76 : 95 * jitter, now);
    softThud.frequency.exponentialRampToValueAtTime(34, now + 0.09);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime((isSandwalk ? 0.05 : 0.10) * amp, now);
    sg.gain.exponentialRampToValueAtTime(0.0005, now + 0.10);
    softThud.connect(sg);
    sg.connect(masterGain);
    softThud.start(now);
    softThud.stop(now + 0.11);
  }

  function playJumpLand(surface = 'sand') {
    playFootstep(surface, 1.35, false);
    if (surface === 'sand') {
      playNoiseBurst(0.28, 1250, 0.7, 0.26, false, 0.55);
    }
  }

  function playThumperPlant() {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    // Heavy metallic spike driven deep into dune
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(240, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.28);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.36, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.30);
    osc.connect(g);
    g.connect(masterGain);
    osc.start(now);
    osc.stop(now + 0.32);

    playNoiseBurst(0.24, 1500, 0.9, 0.32, false, 0.5);

    // Metallic brass latch click 140ms later
    const latch = ctx.createOscillator();
    latch.type = 'square';
    latch.frequency.setValueAtTime(860, now + 0.14);
    latch.frequency.exponentialRampToValueAtTime(320, now + 0.19);
    const lg = ctx.createGain();
    lg.gain.setValueAtTime(0.001, now);
    lg.gain.setValueAtTime(0.12, now + 0.14);
    lg.gain.exponentialRampToValueAtTime(0.001, now + 0.20);
    latch.connect(lg);
    lg.connect(masterGain);
    latch.start(now + 0.14);
    latch.stop(now + 0.21);
  }

  function playWaterDrink() {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    playNoiseBurst(0.45, 920, 1.4, 0.18, true, 1.45);
    const notes = [587.33, 880.0];
    notes.forEach((f, idx) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, now + idx * 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now + idx * 0.12);
      g.gain.linearRampToValueAtTime(0.065, now + idx * 0.12 + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0005, now + idx * 0.12 + 0.55);
      o.connect(g);
      g.connect(masterGain);
      o.start(now + idx * 0.12);
      o.stop(now + idx * 0.12 + 0.58);
    });
  }

  function playSpiceHarvest() {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    // Ethereal D-Phrygian crystalline shimmer
    const chord = [293.66, 311.13, 440.0, 587.33, 880.0];
    chord.forEach((f, idx) => {
      const o = ctx.createOscillator();
      o.type = idx < 2 ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(f, now + idx * 0.055);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now + idx * 0.055);
      g.gain.linearRampToValueAtTime(0.055 / (1 + idx * 0.25), now + idx * 0.055 + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0004, now + idx * 0.055 + 1.45);
      o.connect(g);
      g.connect(masterGain);
      o.start(now + idx * 0.055);
      o.stop(now + idx * 0.055 + 1.5);
    });
  }

  function playDiscoveryChime() {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    // Haunting Villeneuve-style deep desert fifth swell (D2 + A2 + F3)
    const freqs = [146.83, 220.0, 349.23];
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(280, now);
    filt.frequency.linearRampToValueAtTime(920, now + 0.65);
    filt.frequency.exponentialRampToValueAtTime(240, now + 2.3);
    filt.connect(masterGain);

    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, now);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(0.045, now + 0.45);
      g.gain.exponentialRampToValueAtTime(0.0004, now + 2.4);
      o.connect(g);
      g.connect(filt);
      o.start(now);
      o.stop(now + 2.45);
    }
  }

  function playGlowglobeToggle(on) {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(on ? 210 : 440, now);
    o.frequency.exponentialRampToValueAtTime(on ? 460 : 180, now + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.075, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0005, now + 0.26);
    o.connect(g);
    g.connect(masterGain);
    o.start(now);
    o.stop(now + 0.28);
  }

  function playThumperStrike(distAtten = 1.0) {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    const a = Math.max(0.12, Math.min(1.2, distAtten));

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(118, now);
    osc.frequency.exponentialRampToValueAtTime(34, now + 0.24);

    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.45 * a, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);

    osc.connect(thumpGain);
    thumpGain.connect(masterGain);
    osc.start(now);
    osc.stop(now + 0.34);

    const clack = ctx.createOscillator();
    clack.type = 'triangle';
    clack.frequency.setValueAtTime(620, now);
    clack.frequency.exponentialRampToValueAtTime(210, now + 0.045);

    const clackGain = ctx.createGain();
    clackGain.gain.setValueAtTime(0.11 * a, now);
    clackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);

    clack.connect(clackGain);
    clackGain.connect(masterGain);
    clack.start(now);
    clack.stop(now + 0.06);
  }

  function playDistantThunder() {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(64, now);
    osc.frequency.exponentialRampToValueAtTime(28, now + 0.85);

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 130;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.28, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, now + 1.15);

    osc.connect(filt);
    filt.connect(g);
    g.connect(masterGain);
    osc.start(now);
    osc.stop(now + 1.2);
  }

  function playDesertHawkCall() {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1950, now);
    osc.frequency.exponentialRampToValueAtTime(1180, now + 0.65);

    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 1550;
    filt.Q.value = 5.0;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.035, now + 0.09);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.72);

    osc.connect(filt);
    filt.connect(g);
    g.connect(masterGain);
    osc.start(now);
    osc.stop(now + 0.75);
  }

  function setEnabled(next, explicitUserAction = false) {
    enabled = Boolean(next);
    if (explicitUserAction) {
      userMuted = !enabled;
    }
    if (enabled) {
      ensureContext();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume();
      }
      if (masterGain && ctx) {
        masterGain.gain.setTargetAtTime(0.75, ctx.currentTime, 0.35);
      }
    } else if (masterGain && ctx) {
      masterGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.25);
    }
    return enabled;
  }

  function ensureStarted() {
    if (!enabled && !userMuted) {
      setEnabled(true, false);
    }
    return enabled;
  }

  function toggle() {
    return setEnabled(!enabled, true);
  }

  function setSlideIntensity(val) {
    targetSlide = Math.max(0, Math.min(1, val || 0));
  }

  function update(dt, camera = null) {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    const w = Math.min(1.8, worldState.windSpeed);
    const storm = worldState.weatherWeights.coriolisStorm;
    const tremor = worldState.worm.tremor;
    const shelteredAtten = worldState.player?.sheltered ? 0.55 : 1.0;

    windFilterLow.frequency.setTargetAtTime((160 + w * 240 + storm * 180) * (0.85 + 0.15 * shelteredAtten), now, 0.15);
    windGain.gain.setTargetAtTime((0.09 + w * 0.24 + storm * 0.26) * shelteredAtten, now, 0.15);

    saltFilter.frequency.setTargetAtTime(2600 + w * 1400, now, 0.15);
    saltGain.gain.setTargetAtTime(Math.max(0.01, (w - 0.2) * 0.09 + storm * 0.18) * shelteredAtten, now, 0.15);

    wormFilter.frequency.setTargetAtTime(60 + tremor * 88, now, 0.1);
    wormGain.gain.setTargetAtTime(0.02 + tremor * 0.46, now, 0.12);

    slideGain.gain.setTargetAtTime(0.0001 + targetSlide * 0.24, now, 0.08);
    slideFilter.frequency.setTargetAtTime(950 + targetSlide * 850, now, 0.08);

    // Distance-aware Windtrap resonant hum & Fremen camp brazier crackles
    const listenerPos = worldState.player?.active ? worldState.player.position : camera?.position;
    let thumperAtten = 1.0;
    if (listenerPos) {
      const distTrap = Math.hypot(listenerPos.x + 21.0, listenerPos.z + 25.0);
      const trapProx = Math.max(0, 1.0 - distTrap / 24.0);
      trapGain.gain.setTargetAtTime(0.0001 + trapProx * trapProx * (0.04 + w * 0.05), now, 0.2);

      const distThumper = Math.hypot(
        listenerPos.x - worldState.thumper.position.x,
        listenerPos.z - worldState.thumper.position.z
      );
      thumperAtten = Math.max(0.18, Math.min(1.15, 18.0 / (distThumper + 12.0)));

      const distFire = Math.hypot(listenerPos.x + 14.5, listenerPos.z - 5.5);
      if (distFire < 14.0) {
        crackleTimer -= dt;
        if (crackleTimer <= 0) {
          crackleTimer = 0.08 + Math.random() * 0.28;
          const fireProx = (1.0 - distFire / 14.0);
          playNoiseBurst(0.032, 2800 + Math.random() * 2400, 3.2, 0.12 * fireProx * fireProx, true, 0.8);
        }
      }
    }

    if (worldState.thumper.active) {
      const cycle = Math.floor(worldState.thumper.pulsePhase);
      if (cycle !== lastThumperCycle) {
        lastThumperCycle = cycle;
        playThumperStrike(thumperAtten);
      }
    } else {
      lastThumperCycle = -1;
    }

    if (worldState.lightningFlash > 0.65 && lightningPrev <= 0.65) {
      playDistantThunder();
    }
    lightningPrev = worldState.lightningFlash;

    if (worldState.sunDir.y > 0.05 && storm < 0.3) {
      hawkTimer -= dt;
      if (hawkTimer <= 0) {
        hawkTimer = 14 + Math.random() * 18;
        playDesertHawkCall();
      }
    }
  }

  return {
    toggle,
    setEnabled,
    ensureStarted,
    isEnabled: () => enabled,
    playFootstep,
    playJumpLand,
    setSlideIntensity,
    playThumperPlant,
    playWaterDrink,
    playSpiceHarvest,
    playDiscoveryChime,
    playGlowglobeToggle,
    update
  };
}
