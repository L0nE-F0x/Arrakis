// Procedural Web Audio Arrakis Soundscape
// Synthesizes wind through canyon yardangs, blowing sand saltation, seismic Shai-Hulud rumble,
// Fremen Thumper strikes, dry storm crackle, and subtle desert harmonic drones with zero external files.

export function createSoundscape(worldState) {
  let ctx = null;
  let masterGain = null;
  let enabled = false;

  // Wind & sand layers
  let windGain = null;
  let windFilterLow = null;
  let windFilterHigh = null;
  let saltGain = null;
  let saltFilter = null;

  // Worm seismic layer
  let wormGain = null;
  let wormFilter = null;

  // Ambient drone
  let droneGain = null;

  // Track thumper beat triggers
  let lastThumperCycle = -1;
  let hawkTimer = 6.0;
  let lightningPrev = 0;

  function makeNoiseBuffer(audioCtx, seconds = 4.0, color = 'pink') {
    const len = Math.floor(audioCtx.sampleRate * seconds);
    const buf = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      let brown = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        if (color === 'brown') {
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
      // Crossfade ends gently so loop seam is silent
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

    const pinkBuf = makeNoiseBuffer(ctx, 5.0, 'pink');
    const brownBuf = makeNoiseBuffer(ctx, 5.0, 'brown');

    // Canyon Wind (bandpass resonant whistle)
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

    // Sand Saltation Hiss (high crystalline grain drift)
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

    // Shai-Hulud Seismic Rumble
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

    // Subtle Phrygian/Desert Fifth Harmonic Pad (very restrained atmospheric bed)
    droneGain = ctx.createGain();
    droneGain.gain.value = 0.045;
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 260;

    const freqs = [73.42, 110.0, 146.83]; // D2 - A2 - D3
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = f < 90 ? 0.35 : 0.16;
      osc.connect(g);
      g.connect(droneFilter);
      osc.start();
    }
    droneFilter.connect(droneGain);
    droneGain.connect(masterGain);
  }

  function playThumperStrike() {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;

    // Deep sand drum thump
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(118, now);
    osc.frequency.exponentialRampToValueAtTime(34, now + 0.24);

    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.45, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);

    osc.connect(thumpGain);
    thumpGain.connect(masterGain);
    osc.start(now);
    osc.stop(now + 0.34);

    // Metallic brass latch snap
    const clack = ctx.createOscillator();
    clack.type = 'triangle';
    clack.frequency.setValueAtTime(620, now);
    clack.frequency.exponentialRampToValueAtTime(210, now + 0.045);

    const clackGain = ctx.createGain();
    clackGain.gain.setValueAtTime(0.12, now);
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

  function setEnabled(next) {
    enabled = Boolean(next);
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

  function toggle() {
    return setEnabled(!enabled);
  }

  function update(dt) {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    const w = Math.min(1.8, worldState.windSpeed);
    const storm = worldState.weatherWeights.coriolisStorm;
    const tremor = worldState.worm.tremor;

    windFilterLow.frequency.setTargetAtTime(160 + w * 240 + storm * 180, now, 0.15);
    windGain.gain.setTargetAtTime(0.09 + w * 0.24 + storm * 0.26, now, 0.15);

    saltFilter.frequency.setTargetAtTime(2600 + w * 1400, now, 0.15);
    saltGain.gain.setTargetAtTime(Math.max(0.01, (w - 0.2) * 0.09 + storm * 0.18), now, 0.15);

    wormFilter.frequency.setTargetAtTime(60 + tremor * 85, now, 0.1);
    wormGain.gain.setTargetAtTime(0.02 + tremor * 0.42, now, 0.12);

    if (worldState.thumper.active) {
      const cycle = Math.floor(worldState.thumper.pulsePhase);
      if (cycle !== lastThumperCycle) {
        lastThumperCycle = cycle;
        playThumperStrike();
      }
    } else {
      lastThumperCycle = -1;
    }

    if (worldState.lightningFlash > 0.65 && lightningPrev <= 0.65) {
      playDistantThunder();
    }
    lightningPrev = worldState.lightningFlash;

    // Occasional distant soaring desert hawk cry in daylight calm
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
    isEnabled: () => enabled,
    update
  };
}
