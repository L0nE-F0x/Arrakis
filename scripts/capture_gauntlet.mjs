import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('/home/lonefox/.local/share/mise/installs/playwright/latest/node_modules/playwright');

const ROOT = path.resolve(import.meta.dirname, '..');
const HISTORY_PATH = path.join(ROOT, 'public/gauntlet/history.json');

const SUITES = {
  wave1: [
    { name: '01_cistern_dawn', label: 'Dew Cistern & Open Erg (Dawn)', tod: 6.65, weather: 'calm', cam: 'cistern' },
    { name: '02_erg_golden', label: 'Great Erg Dunes & Astral Sky (Golden Hour)', tod: 17.25, weather: 'saltation', cam: 'ridge' },
    { name: '03_twilight_moons', label: 'Twin Moons & Companion Planet (Twilight)', tod: 19.15, weather: 'calm', cam: 'horizon' },
    { name: '04_yardang_noon', label: 'Sandstone Yardangs & Windtrap Path (Noon)', tod: 12.2, weather: 'mirage', cam: 'yardang' },
    { name: '05_eclipse_vista', label: 'Canopus Solar Eclipse Corona', tod: 11.4, eclipse: true, weather: 'calm', cam: 'horizon' }
  ],
  wave2: [
    { name: '01_cistern_dawn', label: 'Dew Cistern & Riparian Flora (Dawn)', tod: 6.25, weather: 'calm', cam: 'cistern' },
    { name: '02_macro_flora', label: 'Macro Inkvine, Cacti & Agave', tod: 7.4, weather: 'calm', cam: 'flora' },
    { name: '03_canopy_upward', label: 'Tamarisk Canopy & Twin Moons Upward Shot', tod: 17.85, weather: 'calm', cam: 'canopy' },
    { name: '04_erg_golden', label: 'Erg Vista Past Blooming Ridge', tod: 17.35, weather: 'saltation', cam: 'ridge' },
    { name: '05_night_bloom', label: 'Twin-Moon Night & Dew Reflections', tod: 23.2, weather: 'calm', cam: 'flora' }
  ],
  wave3: [
    { name: '01_cistern_dawn', label: 'Opening Shot — Cistern, Mist & Flora (Dawn)', tod: 6.28, weather: 'calm', cam: 'cistern' },
    { name: '02_macro_muaddib', label: 'Macro MuadDib Foraging by Desert Flora', tod: 7.6, weather: 'calm', cam: 'muaddib' },
    { name: '03_canopy_sky', label: 'Tamarisk Canopy & Canopus/Krelln', tod: 17.75, weather: 'calm', cam: 'canopy' },
    { name: '04_worm_breach', label: 'Shai-Hulud Sandworm Breach Across Erg', tod: 17.4, weather: 'saltation', cam: 'worm', breach: true },
    { name: '05_coriolis_storm', label: 'Coriolis Haboob Storm Wall & Static Flash', tod: 16.2, weather: 'coriolisStorm', cam: 'ridge' },
    { name: '06_spice_blow', label: 'Mélange Spice Blow & Dust Devils', tod: 13.4, weather: 'spiceBlow', cam: 'spice' },
    { name: '07_night_moons', label: 'Twin-Moon Night & Starlight Reflection', tod: 23.3, weather: 'calm', cam: 'horizon' },
    { name: '08_hud_overview', label: 'Interactive HUD + Sunrise Panorama', tod: 6.45, weather: 'dustDevil', cam: 'director', hud: true }
  ]
};

function parseArgs() {
  const args = {};
  for (const raw of process.argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, '').split('=');
    args[k] = v ?? true;
  }
  return args;
}

async function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for Vite server at ${url}`);
}

async function main() {
  const args = parseArgs();
  const round = args.round || `round-${Date.now()}`;
  const suiteName = args.suite || 'wave1';
  const shots = SUITES[suiteName] || SUITES.wave1;
  const width = Number(args.width || 1280);
  const height = Number(args.height || 720);
  const port = Number(args.port || (5210 + Math.floor(Math.random() * 400)));

  const outDir = path.join(ROOT, 'public/gauntlet/rounds', round);
  fs.mkdirSync(outDir, { recursive: true });

  const vite = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let viteLogs = '';
  vite.stdout.on('data', d => { viteLogs += d.toString(); });
  vite.stderr.on('data', d => { viteLogs += d.toString(); });

  const url = `http://127.0.0.1:${port}/?clean=1`;

  let browser;
  try {
    await waitForServer(`http://127.0.0.1:${port}/`);
    browser = await chromium.launch({
      executablePath: '/usr/bin/google-chrome-stable',
      headless: true,
      args: [
        '--headless=new',
        '--use-gl=angle',
        '--use-angle=gl',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--no-sandbox'
      ]
    });

    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    const warnings = [];
    page.on('pageerror', err => errors.push(`PAGEERROR: ${err.message}`));
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(`CONSOLE_ERROR: ${msg.text()}`);
      else if (msg.type() === 'warning' && /shader|webgl|three/i.test(msg.text())) {
        warnings.push(msg.text());
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => Boolean(window.__ARRAKIS__ && window.__ARRAKIS__.ready), { timeout: 60000 });
    await page.evaluate(() => {
      document.getElementById('loading-veil')?.remove();
    });

    const images = [];
    const metricsList = [];

    for (const shot of shots) {
      await page.evaluate(s => {
        document.body.classList.toggle('screenshot-clean', !s.hud);
        window.__ARRAKIS__.applyShot(s);
      }, shot);

      // Step simulation slightly & allow GPU frames to render cleanly
      await page.evaluate(async () => {
        await window.__ARRAKIS__.renderSteps(6, 0.032);
      });
      await page.waitForTimeout(120);

      const fileName = `${shot.name}.png`;
      const absPath = path.join(outDir, fileName);
      await page.screenshot({ path: absPath });

      const stats = await page.evaluate(() => window.__ARRAKIS__.getStats());
      metricsList.push({ shot: shot.name, ...stats });
      images.push({
        label: shot.label,
        url: `/gauntlet/rounds/${round}/${fileName}`,
        file: absPath
      });
    }

    // Also run a quick 60-frame timing pass for realistic FPS check
    const bench = await page.evaluate(async () => {
      const t0 = performance.now();
      await window.__ARRAKIS__.renderSteps(30, 0.016);
      const dt = performance.now() - t0;
      return { frames: 30, ms: Math.round(dt), avgFrameMs: +(dt / 30).toFixed(2) };
    });

    const report = {
      round,
      suite: suiteName,
      resolution: `${width}x${height}`,
      errors,
      warnings,
      bench,
      stats: metricsList,
      images
    };

    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

    // Append provisional record to public/gauntlet/history.json
    let history = { rounds: [] };
    if (fs.existsSync(HISTORY_PATH)) {
      try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch {}
    }
    history.rounds = history.rounds.filter(r => r.round !== round);
    history.rounds.push({
      round,
      title: `Round ${round} (${suiteName})`,
      timestamp: new Date().toISOString(),
      verdict: errors.length ? 'FAIL' : 'IN_PROGRESS',
      metrics: `${width}x${height} · ${bench.avgFrameMs} ms/frame · Calls: ${metricsList[0]?.calls ?? '?'} · Tris: ${metricsList[0]?.triangles ?? '?'} · Errors: ${errors.length}`,
      summary: errors.length ? errors.join('\n') : 'Awaiting Harsh Critic visual inspection.',
      images: images.map(({ label, url: u }) => ({ label, url: u }))
    });
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));

    console.log(JSON.stringify(report, null, 2));
    if (errors.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (browser) await browser.close();
    vite.kill('SIGTERM');
    if (viteLogs.includes('Error:') && process.exitCode) {
      console.error(viteLogs);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
