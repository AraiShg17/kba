import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = JSON.parse(readFileSync(new URL('../data/backtest-2026-01_to_2026-10.json', import.meta.url)));
const history = JSON.parse(readFileSync(new URL('../data/runner-history-2026-01_to_2026-10.json', import.meta.url)));
const study = JSON.parse(readFileSync(new URL('../data/runner-study-2026-01_to_2026-10.json', import.meta.url)));
const key = r => `${r.date}|${r.venue}|${r.race}`;
const originals = new Map(source.races.map(r => [key(r), r]));

test('馬の成績指標は対象レースより前の出走だけを数える', () => {
  assert.equal(study.races.length, 84);
  for (const race of study.races) {
    const links = history.races[key(race)];
    assert.equal(links.length, 8);
    for (const row of race.rows) {
      const link = links.find(x => x.number === row.number);
      const prior = history.horses[link.horseCode].starts.filter(s => s.date < race.date && s.finish >= 1 && s.fieldSize >= s.finish);
      assert.equal(row.horseStarts, prior.length);
      assert.equal(row.horseWins, prior.filter(s => s.finish === 1).length);
      assert.equal(row.horseTop3, prior.filter(s => s.finish <= 3).length);
    }
  }
});

test('再検証の各方式は同じレースと実際の複勝払戻で集計する', () => {
  for (const race of study.races) {
    const original = originals.get(key(race));
    assert.ok(original);
    assert.deepEqual(race.baseline.highInverse, original.methods.highInverse);
    for (const method of Object.values(race.methods)) {
      assert.equal(method.selectedNumbers.length, 6);
      assert.equal(new Set(method.selectedNumbers).size, 6);
      assert.equal(method.returned - 10000, method.net);
      assert.equal(method.hits, original.payouts.filter(p => method.selectedNumbers.includes(p.number)).length);
    }
  }
  for (const [method, totals] of Object.entries(study.summary.all)) {
    const rows = study.races.map(r => method.startsWith('baseline.') ? r.baseline[method.slice(9)] : r.methods[method]);
    assert.equal(totals.returned, rows.reduce((sum, r) => sum + r.returned, 0));
    assert.equal(totals.net, totals.returned - rows.length * 10000);
  }
});
