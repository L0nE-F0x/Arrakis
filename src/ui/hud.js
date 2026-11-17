const CAM_LABELS = {
  director: 'Director',
  free: 'Free Orbit',
  cistern: 'Dew Cistern',
  flora: 'Macro Flora',
  nightBloom: 'Night Blooms',
  nightCistern: 'Night Mirror',
  canopy: 'Canopy Sky',
  ridge: 'Erg & Worm',
  horizon: 'Horizon',
  yardang: 'Yardangs',
  muaddib: "Muad'Dib",
  worm: 'Shai-Hulud',
  spice: 'Spice Blow'
};

export function initHud(worldState, cameraController, callbacks = {}) {
  const hudRoot = document.getElementById('hud-root');
  const telemetryEl = document.getElementById('hud-telemetry');
  const btnDirector = document.getElementById('btn-director');
  const btnAudio = document.getElementById('btn-audio');
  const btnThumper = document.getElementById('btn-thumper');
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

  const readoutCam = document.getElementById('readout-cam');
  const camButtons = Array.from(document.querySelectorAll('#preset-camera button[data-cam]'));

  const capKicker = document.getElementById('cap-kicker');
  const capTitle = document.getElementById('cap-title');

  let audioEnabled = false;
  let hudVisible = true;
  let draggingTod = false;
  let draggingWind = false;
  let smoothFps = 60;
  let telemetryCooldown = 0;

  // Cached UI values to avoid needless DOM mutations
  let lastTelemetry = '';
  let lastClock = '';
  let lastWeather = '';
  let lastWind = '';
  let lastCam = '';
  let lastKicker = '';
  let lastTitle = '';
  let lastEclipse = null;
  let lastThumper = null;
  let lastAutoTime = null;
  let lastAutoWeather = null;
  let lastTodBucket = null;

  function setHudVisible(visible) {
    hudVisible = Boolean(visible);
    hudRoot?.classList.toggle('clean-mode', !hudVisible);
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
      const effWindStr = Math.min(1.0, worldState.windSpeed).toFixed(2);
      if (sliderWind.value !== effWindStr) sliderWind.value = effWindStr;
    }

    const camMode = worldState.cameraMode;
    if (force || camMode !== lastCam) {
      lastCam = camMode;
      if (readoutCam) readoutCam.textContent = CAM_LABELS[camMode] || camMode;
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
  }

  // Event listeners
  const cleanups = [];
  const bind = (el, evt, handler) => {
    if (!el) return;
    el.addEventListener(evt, handler);
    cleanups.push(() => el.removeEventListener(evt, handler));
  };

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
      if (cam === 'worm' && worldState.worm.phase !== 'breach') {
        worldState.triggerBreach(12, -106, 0.12);
      } else if (cam === 'spice' && worldState.targetWeather !== 'spiceBlow') {
        worldState.setWeather('spiceBlow');
      }
      cameraController.setPreset(cam, false);
      syncFromState(true);
    });
  }

  bind(btnDirector, 'click', () => {
    const next = worldState.cameraMode === 'director' ? 'free' : 'director';
    cameraController.setPreset(next, false);
    syncFromState(true);
  });

  bind(btnThumper, 'click', () => {
    worldState.triggerThumper();
    callbacks?.onThumper?.();
    syncFromState(true);
  });

  bind(btnAudio, 'click', () => {
    const res = callbacks?.onToggleAudio?.();
    audioEnabled = typeof res === 'boolean' ? res : !audioEnabled;
    btnAudio.classList.toggle('active', audioEnabled);
  });

  bind(btnHideHud, 'click', () => setHudVisible(false));
  bind(btnShowHud, 'click', () => setHudVisible(true));

  const onKeyDown = e => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyH') {
      setHudVisible(!hudVisible);
    }
  };
  window.addEventListener('keydown', onKeyDown);
  cleanups.push(() => window.removeEventListener('keydown', onKeyDown));

  function update(dt) {
    if (dt > 0.0005 && dt < 0.5) {
      const instFps = Math.min(144, Math.max(1, 1 / dt));
      smoothFps = smoothFps * 0.9 + instFps * 0.1;
    }
    telemetryCooldown -= dt;
    if (telemetryCooldown <= 0) {
      telemetryCooldown = 0.18;
      syncFromState(false);
    }
  }

  syncFromState(true);

  return {
    update,
    syncFromState: () => syncFromState(true),
    setHudVisible,
    dispose() {
      for (const off of cleanups) off();
    }
  };
}
