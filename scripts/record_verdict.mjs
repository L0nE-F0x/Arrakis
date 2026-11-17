import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HISTORY_PATH = path.join(ROOT, 'public/gauntlet/history.json');

const [round, verdict, ...summaryParts] = process.argv.slice(2);
if (!round || !verdict) {
  console.error('Usage: node scripts/record_verdict.mjs <round> <PASS|FAIL> <summary...>');
  process.exit(1);
}

const summary = summaryParts.join(' ');
const history = fs.existsSync(HISTORY_PATH)
  ? JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'))
  : { rounds: [] };

const entry = history.rounds.find(r => r.round === round);
if (entry) {
  entry.verdict = verdict;
  entry.summary = summary;
} else {
  history.rounds.push({
    round,
    title: `Round ${round}`,
    timestamp: new Date().toISOString(),
    verdict,
    summary,
    images: []
  });
}

fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
console.log(`Updated verdict for ${round}: ${verdict}`);
