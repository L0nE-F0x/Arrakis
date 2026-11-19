import { ARRAKIS_LANDMARKS, QUALITY_PRESETS } from '../state/worldState.js';

const CAM_LABELS = {
  walk: 'Walk Desert',
  director: 'Director',
  free: 'Free Fly',
  cistern: 'Dew Cistern',
  camp: 'Yardang Camp',
  flora: 'Macro Flora',
  nightBloom: 'Night Blooms',
  nightCistern: 'Night Mirror',
  canopy: 'Canopy Sky',
  ridge: 'Great Erg',
  horizon: 'Horizon',
  yardang: 'Yardangs',
  muaddib: "Muad'Dib",
  ornithopter: 'Ornithopter',
  worm: 'Shai-Hulud',
  spice: 'Spice Blow',
  footprints: 'Sandwalk Trail',
  spiceCrater: 'Spice Crater'
};

export function initHud(worldState, cameraController, callbacks = {}) {
  const hudRoot = document.getElementById('hud-root');
  const hudDeck = document.getElementById('hud-deck');
  const telemetryEl = document.getElementById('hud-telemetry');

  const btnWalk = document.getElementById('btn-walk');
  const btnFree = document.getElementById('btn-free');
  const btnDirector = document.getElementById('btn-director');
  const btnAudio = document.getElementById('btn-audio');
  const btnThumper = document.getElementById('btn-thumper');
  const btnDeckToggle = document.getElementById('btn-deck-toggle');
  const btnHideHud = document.getElementById('btn-hide-hud');
  const btnShowHud = document.getElementById('btn-show-hud');

  const readoutTime = document.getElementById('readout-time');
  const sliderTod = document.getElementById('slider-tod');
  const todButtons = Array.from(document.querySelectorAll('#preset-tod button[data-tod]'));
  const chkAutoTime = document.getElementById('chk-auto-time');
  const chkAutoWeather = document.getElementById('chk-auto-weather');

  const readoutWeather = document.getElementById('readout-weather');
  const weatherButtons = Array.from(document.querySelectorAll('#preset-weather button[data-weather]'));
  const readoutWind = document.getElementById('readout-wind');
  const sliderWind = document.getElementById('slider-wind');

  const readoutQuality = document.getElementById('readout-quality');
  const qualityButtons = Array.from(document.querySelectorAll('#preset-quality button[data-quality]'));
  const readoutGpuStats = document.getElementById('readout-gpu-stats');

  const readoutCam = document.getElementById('readout-cam');
  const camButtons = Array.from(document.querySelectorAll('#preset-camera button[data-cam]'));

  const capKicker = document.getElementById('cap-kicker');
  const capTitle = document.getElementById('cap-title');

  // Fremen First-Person Explorer HUD elements
  const fremenHud = document.getElementById('fremen-hud');
  const compassCanvas = document.getElementById('compass-canvas');
  const compassCtx = compassCanvas?.getContext('2d') || null;
  const walkLockHint = document.getElementById('walk-lock-hint');
  const walkReticle = document.getElementById('walk-reticle');
  const interactPrompt = document.getElementById('interact-prompt');

  const opticsOverlay = document.getElementById('optics-overlay');
  const opticsZoomEl = document.getElementById('optics-zoom');
  const opticsBearingEl = document.getElementById('optics-bearing');
  const opticsTargetEl = document.getElementById('optics-target');
  const opticsTargetName = document.getElementById('optics-target-name');
  const opticsTargetSub = document.getElementById('optics-target-sub');

  const gearSandwalk = document.getElementById('gear-sandwalk');
  const gearThumper = document.getElementById('gear-thumper');
  const gearGlowglobe = document.getElementById('gear-glowglobe');
  const gearOptics = document.getElementById('gear-optics');
  const vitalWater = document.getElementById('vital-water');
  const vitalSpice = document.getElementById('vital-spice');
  const vitalDisc = document.getElementById('vital-disc');

  const seismoPanel = document.getElementById('seismo-panel');
  const seismoStatus = document.getElementById('seismo-status');
  const seismoThreat = document.getElementById('seismo-threat');
  const seismoCanvas = document.getElementById('seismo-canvas');
  const seismoCtx = seismoCanvas?.getContext('2d') || null;

  const toastBanner = document.getElementById('toast-banner');
  const toastKicker = document.getElementById('toast-kicker');
  const toastTitle = document.getElementById('toast-title');
  const toastDetail = document.getElementById('toast-detail');

  let audioEnabled = false;
  let hudVisible = true;
  let deckOpen = true;
  let draggingTod = false;
  let draggingWind = false;
  let smoothFps = 60;
  let telemetryCooldown = 0;

  let activeToastTimer = 0;

  // Cached DOM state to minimize layout thrash
  let lastTelemetry = '';
  let lastClock = '';
  let lastWeather = '';
  let lastWind = '';
  let lastCam = '';
  let lastQuality = '';
  let lastKicker = '';
  let lastTitle = '';
  let lastEclipse = null;
  let lastThumper = null;
  let lastAutoTime = null;
  let lastAutoWeather = null;
  let lastTodBucket = null;
  let lastPrompt = null;

  function setHudVisible(visible) {
    hudVisible = Boolean(visible);
    hudRoot?.classList.toggle('clean-mode', !hudVisible);
  }

  function setDeckOpen(open) {
    deckOpen = Boolean(open);
    hudDeck?.classList.toggle('collapsed', !deckOpen);
    btnDeckToggle?.classList.toggle('active', deckOpen);
  }

  function drawCompass() {
    if (!compassCtx || !compassCanvas) return;
    const w = compassCanvas.width;
    const h = compassCanvas.height;
    compassCtx.clearRect(0, 0, w, h);

    // Three.js yaw=0 looks toward -Z (North!). Turning left (+yaw) faces West (-X).
    // Standard compass heading in degrees: 0=N (-Z), 90=E (+X), 180=S (+Z), 270=W (-X).
    const p = worldState.player;
    let headingDeg = ((-p.yaw * 180) / Math.PI) % 360;
    if (headingDeg < 0) headingDeg += 360;

    const pxPerDeg = 2.6;
    const halfSpanDeg = w / (2 * pxPerDeg);

    const cardinals = [
      { deg: 0, label: 'N', major: true },
      { deg: 45, label: 'NE', major: false },
      { deg: 90, label: 'E', major: true },
      { deg: 135, label: 'SE', major: false },
      { deg: 180, label: 'S', major: true },
      { deg: 225, label: 'SW', major: false },
      { deg: 270, label: 'W', major: true },
      { deg: 315, label: 'NW', major: false }
    ];

    const wrapDelta = (targetDeg) => {
      let d = ((targetDeg - headingDeg + 540) % 360) - 180;
      return d;
    };

    // Subtle feathered Fremen gold track baseline
    const baseGrad = compassCtx.createLinearGradient(0, 0, w, 0);
    baseGrad.addColorStop(0.0, 'rgba(230, 173, 102, 0.0)');
    baseGrad.addColorStop(0.18, 'rgba(230, 173, 102, 0.32)');
    baseGrad.addColorStop(0.50, 'rgba(255, 208, 137, 0.48)');
    baseGrad.addColorStop(0.82, 'rgba(230, 173, 102, 0.32)');
    baseGrad.addColorStop(1.0, 'rgba(230, 173, 102, 0.0)');
    compassCtx.strokeStyle = baseGrad;
    compassCtx.lineWidth = 1;
    compassCtx.beginPath();
    compassCtx.moveTo(0, h - 4.5);
    compassCtx.lineTo(w, h - 4.5);
    compassCtx.stroke();

    // Minor 15-deg & major 45-deg ticks
    compassCtx.lineWidth = 1;
    for (let deg = 0; deg < 360; deg += 15) {
      const delta = wrapDelta(deg);
      if (Math.abs(delta) > halfSpanDeg) continue;
      const x = Math.round(w * 0.5 + delta * pxPerDeg) + 0.5;
      const edgeFade = Math.max(0, 1 - Math.abs(delta) / halfSpanDeg);
      const isMajor = deg % 45 === 0;
      compassCtx.strokeStyle = isMajor ? 'rgba(255, 212, 142, 0.78)' : 'rgba(230, 173, 102, 0.36)';
      compassCtx.globalAlpha = edgeFade * (isMajor ? 0.92 : 0.72);
      compassCtx.beginPath();
      compassCtx.moveTo(x, h - 4.5);
      compassCtx.lineTo(x, h - (isMajor ? 11.5 : 8));
      compassCtx.stroke();
    }

    // Cardinal labels with crisp dark halo for legibility over sunlit dunes & night sky
    compassCtx.textAlign = 'center';
    compassCtx.textBaseline = 'middle';
    compassCtx.shadowColor = 'rgba(0, 0, 0, 0.88)';
    compassCtx.shadowBlur = 3;
    for (const c of cardinals) {
      const delta = wrapDelta(c.deg);
      if (Math.abs(delta) > halfSpanDeg - 6) continue;
      const x = w * 0.5 + delta * pxPerDeg;
      const edgeFade = Math.max(0, 1 - Math.abs(delta) / halfSpanDeg);
      compassCtx.globalAlpha = edgeFade;
      compassCtx.font = c.major ? '700 11px Inter, sans-serif' : '600 9.5px Inter, sans-serif';
      compassCtx.fillStyle =
        c.label === 'N' ? '#ffd792' : c.major ? '#f9f0e4' : 'rgba(238, 198, 142, 0.88)';
      compassCtx.fillText(c.label, x, 12.5);
    }

    // Landmark, Thumper & Wormsign directional pips
    const px = p.feetPosition.x;
    const pz = p.feetPosition.z;
    const drawPip = (tx, tz, color, radius = 3.0, diamond = false, glow = null) => {
      const dx = tx - px;
      const dz = tz - pz;
      const dist = Math.hypot(dx, dz);
      if (dist < 4.5) return;
      // Heading: atan2(dx, -dz) maps (0,-1)->0(N), (1,0)->90(E), (0,1)->180(S), (-1,0)->270(W)
      let angDeg = (Math.atan2(dx, -dz) * 180) / Math.PI;
      if (angDeg < 0) angDeg += 360;
      const delta = wrapDelta(angDeg);
      if (Math.abs(delta) > halfSpanDeg - 4) return;
      const x = w * 0.5 + delta * pxPerDeg;
      const edgeFade = Math.max(0, 1 - Math.abs(delta) / halfSpanDeg);
      compassCtx.globalAlpha = edgeFade * 0.96;
      compassCtx.shadowColor = glow || 'rgba(0, 0, 0, 0.9)';
      compassCtx.shadowBlur = glow ? 5 : 2;
      compassCtx.fillStyle = color;
      compassCtx.beginPath();
      if (diamond) {
        compassCtx.moveTo(x, 22 - radius);
        compassCtx.lineTo(x + radius, 22);
        compassCtx.lineTo(x, 22 + radius);
        compassCtx.lineTo(x - radius, 22);
        compassCtx.closePath();
      } else {
        compassCtx.arc(x, 23, radius, 0, Math.PI * 2);
      }
      compassCtx.fill();
    };

    for (let i = 0; i < ARRAKIS_LANDMARKS.length; i++) {
      const lm = ARRAKIS_LANDMARKS[i];
      const known = p.discoveredIds.has(lm.id);
      drawPip(lm.x, lm.z, known ? lm.color : 'rgba(255, 226, 178, 0.66)', known ? 3.0 : 2.4, !known);
    }

    if (worldState.thumper.active) {
      drawPip(worldState.thumper.position.x, worldState.thumper.position.z, '#5ec2ff', 4.0, true, 'rgba(75, 169, 255, 0.85)');
    }
    if (worldState.worm.phase === 'hunting' || worldState.worm.phase === 'breach') {
      drawPip(worldState.worm.position.x, worldState.worm.position.z, '#ff6240', 4.5, true, 'rgba(255, 92, 58, 0.92)');
    }

    compassCtx.shadowBlur = 0;
    compassCtx.shadowColor = 'transparent';
    compassCtx.globalAlpha = 1.0;
  }

  function drawSeismograph() {
    if (!seismoCtx || !seismoCanvas) return;
    const w = seismoCanvas.width;
    const h = seismoCanvas.height;
    seismoCtx.clearRect(0, 0, w, h);

    const p = worldState.player;
    const samples = p.seismicSamples;
    const len = samples.length;
    const cur = p.seismicCursor;

    const isDanger = worldState.worm.phase === 'hunting' || worldState.worm.phase === 'breach' || p.wormThreat > 0.55;
    const isSandwalk = p.sandwalking && p.onOpenErg;

    // Subtle oscilloscope reticle grid (center baseline + +/-32% guides + sweep divisions)
    seismoCtx.strokeStyle = isDanger
      ? 'rgba(255, 106, 70, 0.16)'
      : isSandwalk
        ? 'rgba(98, 186, 255, 0.16)'
        : 'rgba(230, 173, 102, 0.14)';
    seismoCtx.lineWidth = 1;
    seismoCtx.beginPath();
    seismoCtx.moveTo(0, h * 0.5);
    seismoCtx.lineTo(w, h * 0.5);
    seismoCtx.moveTo(0, h * 0.18);
    seismoCtx.lineTo(w, h * 0.18);
    seismoCtx.moveTo(0, h * 0.82);
    seismoCtx.lineTo(w, h * 0.82);
    for (let g = 1; g < 4; g++) {
      const gx = Math.round((w * g) / 4) + 0.5;
      seismoCtx.moveTo(gx, 2);
      seismoCtx.lineTo(gx, h - 2);
    }
    seismoCtx.stroke();

    const strokeCol = isDanger ? '#ff6c47' : isSandwalk ? '#66c2ff' : '#f4bf74';
    const fillCol = isDanger
      ? 'rgba(255, 98, 60, 0.16)'
      : isSandwalk
        ? 'rgba(82, 184, 255, 0.15)'
        : 'rgba(242, 186, 112, 0.13)';
    const glowCol = isDanger
      ? 'rgba(255, 92, 54, 0.72)'
      : isSandwalk
        ? 'rgba(75, 169, 255, 0.65)'
        : 'rgba(230, 168, 92, 0.55)';

    // Soft ribbon fill between trace and midline
    seismoCtx.beginPath();
    seismoCtx.moveTo(0, h * 0.5);
    let lastX = 0;
    let lastY = h * 0.5;
    for (let i = 0; i < len; i++) {
      const s = samples[(cur + i) % len];
      const x = (i / (len - 1)) * w;
      const y = h * 0.5 - s * (h * 0.43);
      seismoCtx.lineTo(x, y);
      lastX = x;
      lastY = y;
    }
    seismoCtx.lineTo(w, h * 0.5);
    seismoCtx.closePath();
    seismoCtx.fillStyle = fillCol;
    seismoCtx.fill();

    // Crisp luminous seismic trace line
    seismoCtx.strokeStyle = strokeCol;
    seismoCtx.lineWidth = isDanger ? 2.1 : 1.7;
    seismoCtx.lineCap = 'round';
    seismoCtx.lineJoin = 'round';
    seismoCtx.shadowColor = glowCol;
    seismoCtx.shadowBlur = isDanger ? 7 : 4;
    seismoCtx.beginPath();
    for (let i = 0; i < len; i++) {
      const s = samples[(cur + i) % len];
      const x = (i / (len - 1)) * w;
      const y = h * 0.5 - s * (h * 0.43);
      if (i === 0) seismoCtx.moveTo(x, y);
      else seismoCtx.lineTo(x, y);
    }
    seismoCtx.stroke();

    // Live leading-edge stylus dot
    seismoCtx.fillStyle = isDanger ? '#ffd0b8' : isSandwalk ? '#d6eeff' : '#ffe4b4';
    seismoCtx.beginPath();
    seismoCtx.arc(Math.min(w - 2.5, lastX), lastY, isDanger ? 2.4 : 1.9, 0, Math.PI * 2);
    seismoCtx.fill();

    seismoCtx.shadowBlur = 0;
    seismoCtx.shadowColor = 'transparent';

    // Update status labels
    seismoPanel?.classList.toggle('danger', isDanger);
    seismoPanel?.classList.toggle('sandwalk', isSandwalk && !isDanger);

    if (seismoStatus) {
      if (worldState.worm.phase === 'breach') seismoStatus.textContent = 'SHAI-HULUD BREACHING!';
      else if (worldState.worm.phase === 'hunting') seismoStatus.textContent = 'WORMSIGN INBOUND!';
      else if (!p.onOpenErg) seismoStatus.textContent = p.inWater ? 'DEW CISTERN · SAFE' : 'SAFE BASIN ROCK';
      else if (p.sandwalking) seismoStatus.textContent = 'OPEN ERG · SANDWALK';
      else if (p.sliding) seismoStatus.textContent = 'SLIPFACE AVALANCHE!';
      else seismoStatus.textContent = 'OPEN ERG · RHYTHMIC';
    }
    if (seismoThreat) {
      seismoThreat.textContent = `${Math.round(p.wormThreat * 100)}%`;
    }
  }

  function syncFremenHudVisuals() {
    const p = worldState.player;
    const isWalk = worldState.cameraMode === 'walk' && p.active;
    hudRoot?.classList.toggle('walk-mode', isWalk);
    hudRoot?.classList.toggle('optics-mode', isWalk && p.opticsActive);
    fremenHud?.classList.toggle('hidden', !isWalk);

    if (!isWalk) return;

    drawCompass();
    drawSeismograph();

    const hideLockHint = p.opticsActive || document.body.classList.contains('screenshot-clean');
    walkLockHint?.classList.toggle('locked', p.pointerLocked);
    walkLockHint?.classList.toggle('hidden', hideLockHint);

    // Crosshair & contextual [E] prompt
    const promptText = p.nearbyPrompt;
    if (promptText !== lastPrompt) {
      lastPrompt = promptText;
      if (interactPrompt) {
        interactPrompt.textContent = promptText || '';
        interactPrompt.classList.toggle('hidden', !promptText);
      }
    }
    walkReticle?.classList.toggle('hidden', p.opticsActive);
    walkReticle?.classList.toggle('active-target', Boolean(promptText));

    // Electro-Optics Overlay
    opticsOverlay?.classList.toggle('hidden', !p.opticsActive);
    if (p.opticsActive) {
      if (opticsZoomEl) opticsZoomEl.textContent = `${p.opticsZoom.toFixed(1)}x · SCROLL ZOOM`;
      let headingDeg = Math.round(((-p.yaw * 180) / Math.PI) % 360);
      if (headingDeg < 0) headingDeg += 360;
      const elevDeg = Math.round((p.pitch * 180) / Math.PI);
      const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
      const dirTxt = dirs[Math.round(headingDeg / 45) % 8];
      if (opticsBearingEl) {
        opticsBearingEl.textContent = `${dirTxt} ${String(headingDeg).padStart(3, '0')}° · ${elevDeg >= 0 ? '+' : ''}${elevDeg}°`;
      }
      if (p.opticsTarget) {
        opticsTargetEl?.classList.remove('hidden');
        if (opticsTargetName) opticsTargetName.textContent = p.opticsTarget.label;
        if (opticsTargetSub) {
          opticsTargetSub.textContent =
            p.opticsTarget.dist !== null
              ? `${p.opticsTarget.sub} · ${p.opticsTarget.dist}m`
              : p.opticsTarget.sub;
        }
      } else {
        opticsTargetEl?.classList.add('hidden');
      }
    }

    // Quick Gear Chips & Stillsuit Vitals (.active always reflects active state; .active-blue adds spice-blue accent)
    gearSandwalk?.classList.toggle('active', p.sandwalking);
    gearSandwalk?.classList.toggle('active-blue', p.sandwalking);
    const thumperLit = p.thumperAiming || worldState.thumper.active;
    gearThumper?.classList.toggle('active', thumperLit);
    gearThumper?.classList.toggle('active-blue', thumperLit);
    gearGlowglobe?.classList.toggle('active', p.glowglobeOn);
    gearOptics?.classList.toggle('active', p.opticsActive);

    if (vitalWater) vitalWater.textContent = `${Math.round(p.hydration * 100)}%`;
    if (vitalSpice) vitalSpice.textContent = String(p.spiceCollected);
    if (vitalDisc) vitalDisc.textContent = `${p.discoveredIds.size}/${ARRAKIS_LANDMARKS.length}`;
  }

  function updateFremenHud(dt) {
    const p = worldState.player;

    // Drain poetic discovery/event toast queue cleanly even outside walk mode
    if (activeToastTimer > 0) {
      activeToastTimer -= dt;
      if (activeToastTimer <= 0.45 && toastBanner) {
        toastBanner.classList.add('fade-out');
      }
      if (activeToastTimer <= 0 && toastBanner) {
        toastBanner.classList.add('hidden');
        toastBanner.classList.remove('fade-out');
      }
    } else if (p.toastQueue.length > 0 && toastBanner && !p.opticsActive) {
      const next = p.toastQueue.shift();
      if (toastKicker) toastKicker.textContent = next.kicker;
      if (toastTitle) toastTitle.textContent = next.title;
      if (toastDetail) toastDetail.textContent = next.detail || '';
      toastBanner.classList.remove('hidden', 'fade-out');
      activeToastTimer = 4.6;
    }

    if (toastBanner && p.opticsActive) {
      toastBanner.classList.add('hidden');
    }

    syncFremenHudVisuals();
  }

  function syncFromState(force = false) {
    const clock = worldState.getClockString();
    if (force || clock !== lastClock) {
      lastClock = clock;
      if (readoutTime) readoutTime.textContent = clock;
    }

    if (sliderTod && (!draggingTod || force)) {
      const todVal = worldState.timeOfDay.toFixed(2);
      if (sliderTod.value !== todVal) sliderTod.value = todVal;
    }

    const todBucket = Math.round(worldState.timeOfDay * 10);
    if (force || todBucket !== lastTodBucket || worldState.eclipseActive !== lastEclipse) {
      lastTodBucket = todBucket;
      lastEclipse = worldState.eclipseActive;
      for (const btn of todButtons) {
        const isEclipseBtn = btn.dataset.eclipse === '1';
        let active = false;
        if (worldState.eclipseActive) {
          active = isEclipseBtn;
        } else if (!isEclipseBtn) {
          const targetTod = parseFloat(btn.dataset.tod);
          const diff = Math.min(
            Math.abs(worldState.timeOfDay - targetTod),
            24 - Math.abs(worldState.timeOfDay - targetTod)
          );
          active = diff < 0.35;
        }
        btn.classList.toggle('active', active);
      }
    }

    if (chkAutoTime && (force || worldState.autoTime !== lastAutoTime)) {
      lastAutoTime = worldState.autoTime;
      chkAutoTime.checked = worldState.autoTime;
    }

    if (chkAutoWeather && (force || worldState.autoWeather !== lastAutoWeather)) {
      lastAutoWeather = worldState.autoWeather;
      chkAutoWeather.checked = worldState.autoWeather;
    }

    const weatherLabel = worldState.getWeatherLabel();
    if (force || weatherLabel !== lastWeather) {
      lastWeather = weatherLabel;
      if (readoutWeather) readoutWeather.textContent = weatherLabel;
      for (const btn of weatherButtons) {
        btn.classList.toggle('active', btn.dataset.weather === worldState.targetWeather);
      }
    }

    const windMsStr = `${(worldState.windSpeed * 10).toFixed(1)} m/s`;
    if (force || windMsStr !== lastWind) {
      lastWind = windMsStr;
      if (readoutWind) readoutWind.textContent = windMsStr;
    }
    if (sliderWind && !draggingWind) {
      const effWindStr = Math.min(1.6, worldState.baseWind).toFixed(2);
      if (sliderWind.value !== effWindStr) sliderWind.value = effWindStr;
    }

    const qTier = worldState.quality;
    if (force || qTier !== lastQuality) {
      lastQuality = qTier;
      const qCfg = QUALITY_PRESETS[qTier] || QUALITY_PRESETS.ultra;
      if (readoutQuality) readoutQuality.textContent = qCfg.label;
      for (const btn of qualityButtons) {
        btn.classList.toggle('active', btn.dataset.quality === qTier);
      }
      if (readoutGpuStats) {
        readoutGpuStats.textContent = `IBL · ${qCfg.godRaySamples}-Tap God Rays · ${qCfg.shadowMapSize}px Shadows · ${qCfg.waterRes}px Water`;
      }
    }

    const camMode = worldState.cameraMode;
    if (force || camMode !== lastCam) {
      lastCam = camMode;
      if (readoutCam) readoutCam.textContent = CAM_LABELS[camMode] || camMode;
      btnWalk?.classList.toggle('active', camMode === 'walk');
      btnFree?.classList.toggle('active', camMode === 'free');
      btnDirector?.classList.toggle('active', camMode === 'director');
      for (const btn of camButtons) {
        btn.classList.toggle('active', btn.dataset.cam === camMode);
      }
    }

    if (btnThumper && (force || worldState.thumper.active !== lastThumper)) {
      lastThumper = worldState.thumper.active;
      btnThumper.classList.toggle('active', worldState.thumper.active);
    }

    const caption = cameraController.getCaption();
    if (caption) {
      if (force || caption.kicker !== lastKicker) {
        lastKicker = caption.kicker;
        if (capKicker) capKicker.textContent = caption.kicker;
      }
      if (force || caption.title !== lastTitle) {
        lastTitle = caption.title;
        if (capTitle) capTitle.textContent = caption.title;
      }
    }

    const weatherTag = worldState.eclipseActive ? `${weatherLabel} · Eclipse` : weatherLabel;
    const windMs = (worldState.windSpeed * 10).toFixed(1);
    const telemetry = `${clock} · ${weatherTag} · Wind ${windMs} m/s · ${Math.round(smoothFps)} FPS`;
    if (force || telemetry !== lastTelemetry) {
      lastTelemetry = telemetry;
      if (telemetryEl) telemetryEl.textContent = telemetry;
    }

    const audioOn = callbacks?.isAudioEnabled?.();
    if (typeof audioOn === 'boolean' && audioOn !== audioEnabled) {
      audioEnabled = audioOn;
      btnAudio?.classList.toggle('active', audioEnabled);
    }

    // Immediately redraw diegetic compass, seismograph, optics overlay & active gear chips when in walk mode
    if (force || worldState.player.active) {
      syncFremenHudVisuals();
    }
  }

  // Event listeners
  const cleanups = [];
  const bind = (el, evt, handler) => {
    if (!el) return;
    el.addEventListener(evt, handler);
    cleanups.push(() => el.removeEventListener(evt, handler));
  };

  function switchMode(nextMode) {
    if (nextMode === 'walk') {
      // Collapse right control deck cleanly so walking feels vast & cinematic
      setDeckOpen(false);
    }
    cameraController.setPreset(nextMode, false);
    if (nextMode === 'walk') {
      callbacks?.onEnterWalk?.();
    }
    syncFromState(true);
  }

  bind(btnWalk, 'click', () => switchMode('walk'));
  bind(btnFree, 'click', () => switchMode('free'));
  bind(btnDirector, 'click', () => switchMode('director'));
  bind(btnDeckToggle, 'click', () => setDeckOpen(!deckOpen));

  if (sliderTod) {
    bind(sliderTod, 'pointerdown', () => { draggingTod = true; });
    bind(sliderTod, 'pointerup', () => { draggingTod = false; });
    bind(sliderTod, 'change', () => { draggingTod = false; });
    bind(sliderTod, 'input', () => {
      const hrs = parseFloat(sliderTod.value);
      worldState.setTimeOfDay(hrs, false);
      syncFromState(true);
    });
  }

  for (const btn of todButtons) {
    bind(btn, 'click', () => {
      const tod = parseFloat(btn.dataset.tod);
      const eclipse = btn.dataset.eclipse === '1';
      worldState.setTimeOfDay(tod, eclipse);
      syncFromState(true);
    });
  }

  bind(chkAutoTime, 'change', () => {
    worldState.autoTime = Boolean(chkAutoTime.checked);
  });

  bind(chkAutoWeather, 'change', () => {
    worldState.autoWeather = Boolean(chkAutoWeather.checked);
  });

  for (const btn of weatherButtons) {
    bind(btn, 'click', () => {
      worldState.setWeather(btn.dataset.weather);
      syncFromState(true);
    });
  }

  for (const btn of qualityButtons) {
    bind(btn, 'click', () => {
      const tier = btn.dataset.quality;
      worldState.setQuality(tier);
      callbacks?.onQualityChange?.(tier);
      syncFromState(true);
    });
  }

  if (sliderWind) {
    bind(sliderWind, 'pointerdown', () => { draggingWind = true; });
    bind(sliderWind, 'pointerup', () => { draggingWind = false; });
    bind(sliderWind, 'change', () => { draggingWind = false; });
    bind(sliderWind, 'input', () => {
      worldState.baseWind = parseFloat(sliderWind.value);
      syncFromState(true);
    });
  }

  for (const btn of camButtons) {
    bind(btn, 'click', () => {
      const cam = btn.dataset.cam;
      if (cam === 'walk') {
        switchMode('walk');
        return;
      }
      if (cam === 'worm' && worldState.worm.phase !== 'breach') {
        worldState.triggerBreach(12, -106, 0.12);
      } else if (cam === 'spice' && worldState.targetWeather !== 'spiceBlow') {
        worldState.setWeather('spiceBlow');
      }
      cameraController.setPreset(cam, false);
      syncFromState(true);
    });
  }

  bind(btnThumper, 'click', () => {
    if (worldState.cameraMode === 'walk') {
      worldState.player.thumperAiming = !worldState.player.thumperAiming;
    } else {
      worldState.triggerThumper();
      callbacks?.onThumper?.();
    }
    syncFromState(true);
  });

  bind(btnAudio, 'click', () => {
    const res = callbacks?.onToggleAudio?.();
    audioEnabled = typeof res === 'boolean' ? res : !audioEnabled;
    btnAudio.classList.toggle('active', audioEnabled);
  });

  // Quick Fremen gear buttons
  bind(gearSandwalk, 'click', () => {
    worldState.player.sandwalking = !worldState.player.sandwalking;
  });
  bind(gearThumper, 'click', () => {
    worldState.player.thumperAiming = !worldState.player.thumperAiming;
  });
  bind(gearGlowglobe, 'click', () => {
    callbacks?.onToggleGlowglobe?.();
  });
  bind(gearOptics, 'click', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' }));
  });

  bind(btnHideHud, 'click', () => setHudVisible(false));
  bind(btnShowHud, 'click', () => setHudVisible(true));

  const onKeyDown = e => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyH') {
      setHudVisible(!hudVisible);
    } else if (e.code === 'Tab') {
      e.preventDefault();
      setDeckOpen(!deckOpen);
    } else if (e.code === 'Digit1') {
      switchMode('walk');
    } else if (e.code === 'Digit2') {
      switchMode('free');
    } else if (e.code === 'Digit3') {
      switchMode('director');
    }
  };
  window.addEventListener('keydown', onKeyDown);
  cleanups.push(() => window.removeEventListener('keydown', onKeyDown));

  function update(dt) {
    if (dt > 0.0005 && dt < 0.5) {
      const instFps = Math.min(144, Math.max(1, 1 / dt));
      smoothFps = smoothFps * 0.9 + instFps * 0.1;
    }
    updateFremenHud(dt);
    telemetryCooldown -= dt;
    if (telemetryCooldown <= 0) {
      telemetryCooldown = 0.18;
      syncFromState(false);
    }
  }

  setDeckOpen(true);
  syncFromState(true);

  return {
    update,
    syncFromState: () => syncFromState(true),
    setHudVisible,
    setDeckOpen,
    dispose() {
      for (const off of cleanups) off();
    }
  };
}
