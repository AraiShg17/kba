import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocate } from '../public/logic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const races = JSON.parse(await readFile(path.join(root, 'data/backtest-2026-01_to_2026-10.json'), 'utf8')).races;
const history = JSON.parse(await readFile(path.join(root, 'data/runner-history-2026-01_to_2026-10.json'), 'utf8'));
const jockeyYear = JSON.parse(await readFile(path.join(root, 'data/jockey-2025.json'), 'utf8'));
const normalize = value => value.normalize('NFKC').replace(/^[▲△◇★☆]/, '').replace(/[\s·・]/g, '').toLowerCase();
const jockeyByName = new Map(jockeyYear.rows.map(x => [x.key, x]));
const key = r => `${r.date}|${r.venue}|${r.race}`;
const budget = 10000;
const outputs = [];
const coverage = { complete: 0, missingRace: 0, missingHorse: 0, missingJockey: 0, noPriorHorseStarts: 0 };

for (const race of races) {
  const runners = history.races[key(race)];
  if (!runners) { coverage.missingRace++; continue; }
  const rows = race.horses.map(h => {
    const r = runners.find(x => x.number === h.number);
    const starts = history.horses[r?.horseCode]?.starts?.filter(s => s.date < race.date && s.finish >= 1 && s.fieldSize >= s.finish) ?? null;
    const jockey = r ? jockeyByName.get(normalize(r.jockeyName)) ?? null : null;
    if (!starts) coverage.missingHorse++;
    if (!jockey) coverage.missingJockey++;
    if (starts?.length === 0) coverage.noPriorHorseStarts++;
    const horseEdge = starts ? starts.reduce((sum, s) => sum + (s.finish <= 3 ? 1 : 0) - Math.min(3 / s.fieldSize, 1), 0) / (starts.length + 8) : 0;
    const horseWinEdge = starts ? starts.reduce((sum, s) => sum + (s.finish === 1 ? 1 : 0) - 1 / s.fieldSize, 0) / (starts.length + 8) : 0;
    const jockeyTop3 = jockey && jockey.starts ? (jockey.wins + jockey.seconds + jockey.thirds + 25) / (jockey.starts + 100) : 0.25;
    const jockeyWin = jockey && jockey.starts ? (jockey.wins + 8) / (jockey.starts + 100) : 0.08;
    return { ...h, horseName: r?.horseName, jockeyName: r?.jockeyName,
      horseStarts: starts?.length ?? null, horseWins: starts?.filter(s => s.finish === 1).length ?? null,
      horseTop3: starts?.filter(s => s.finish <= 3).length ?? null,
      horseEdge, horseWinEdge, jockey2025Starts: jockey?.starts ?? null, jockey2025Top3: jockey?.top3Rate ?? null,
      jockey2025Win: jockey?.winRate ?? null, jockeyTop3, jockeyWin,
      hit: race.payouts.some(p => p.number === h.number) };
  });
  if (rows.length !== 8 || new Set(rows.map(x => x.number)).size !== 8) continue;
  coverage.complete++;
  const rank = prop => new Map([...rows].sort((a, b) => b[prop] - a[prop] || a.number - b.number).map((x, i) => [x.number, 7 - i]));
  const horseRanks = rank('horseEdge'), jockeyRanks = rank('jockeyTop3');
  const score = {
    horse: rows.map(x => x.horseEdge), jockey: rows.map(x => x.jockeyTop3),
    horseWin: rows.map(x => x.horseWinEdge), jockeyWin: rows.map(x => x.jockeyWin),
    combined: rows.map(x => horseRanks.get(x.number) + jockeyRanks.get(x.number)),
  };
  const methods = {};
  for (const [name, scores] of Object.entries(score)) {
    const chosen = [...rows.keys()].sort((a, b) => scores[b] - scores[a] || rows[a].number - rows[b].number).slice(0, 6);
    const selected = rows.map((_, i) => chosen.includes(i));
    const stakes = allocate(race.horses, selected, budget);
    const returned = race.payouts.reduce((sum, p) => sum + stakes[rows.findIndex(x => x.number === p.number)] * p.yenPer100 / 100, 0);
    methods[name] = { selectedNumbers: rows.filter((_, i) => selected[i]).map(x => x.number),
      hits: rows.filter((x, i) => selected[i] && x.hit).length, returned, net: returned - budget };
  }
  outputs.push({ date: race.date, venue: race.venue, race: race.race, resultUrl: race.resultUrl,
    rows, methods, baseline: { highInverse: race.methods.highInverse, probabilityInverse: race.methods.probabilityInverse } });
}

const stats = (sample, method) => {
  const values = sample.map(r => method.startsWith('baseline.') ? r.baseline[method.slice(9)] : r.methods[method]);
  const returned = values.reduce((sum, x) => sum + x.returned, 0);
  return { races: sample.length, cost: sample.length * budget, returned, net: returned - sample.length * budget,
    roi: sample.length ? returned / (sample.length * budget) : null,
    profitable: values.filter(x => x.net > 0).length,
    hits: values.reduce((sum, x) => sum + x.hits, 0) };
};
const methods = ['baseline.highInverse', 'baseline.probabilityInverse', 'horse', 'jockey', 'horseWin', 'jockeyWin', 'combined'];
const sets = { all: outputs, train: outputs.filter(r => r.date < '2026-07-01'), test: outputs.filter(r => r.date >= '2026-07-01') };
const summary = Object.fromEntries(Object.entries(sets).map(([name, rows]) => [name,
  Object.fromEntries(methods.map(method => [method, stats(rows, method)]))]));
const allRunners = outputs.flatMap(r => r.rows.map(x => ({ ...x,
  placePayoutPer100: races.find(source => key(source) === key(r))?.payouts.find(p => p.number === x.number)?.yenPer100 ?? 0 })));
const riders = jockeyYear.rows.filter(x => x.starts >= 100).sort((a, b) => b.top3Rate - a.top3Rate).slice(0, 15)
  .map(x => ({ name: x.name, starts: x.starts, winRate: x.winRate, top3Rate: x.top3Rate }));
const alphaNamed = allRunners.filter(x => /^[A-ZＡ-Ｚ][.．]/.test(x.jockeyName ?? ''));
const group = a => ({ starts: a.length, top3: a.filter(x => x.hit).length,
  top3Rate: a.length ? a.filter(x => x.hit).length / a.length : null,
  averageWinOdds: a.length ? a.reduce((sum, x) => sum + x.winOdds, 0) / a.length : null,
  placeStakeYen: a.length * 100,
  placeReturnYen: a.reduce((sum, x) => sum + x.placePayoutPer100, 0),
  names: [...new Set(a.map(x => x.jockeyName))].sort() });
const report = { generatedAt: new Date().toISOString(), source: 'JRA JRADB pages and 2025 jockey performance',
  design: 'Horse starts strictly before each target race; jockey 2025 rates known before all 2026 races. Ranking rules fixed without using 2026 results. Jockey rates from db-keiba, cross-checked with one JRA page. Place stakes use final odds, so simulated return still has look-ahead and is not executable.',
  coverage, summary, jockeyLeaders2025: riders,
  alphabetInitialJockeys: { named: group(alphaNamed), others: group(allRunners.filter(x => !alphaNamed.includes(x))) },
  races: outputs };
await writeFile(path.join(root, 'data/runner-study-2026-01_to_2026-10.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ coverage, summary, jockeyLeaders2025: riders.slice(0, 8), alphabetInitialJockeys: report.alphabetInitialJockeys }, null, 2));
