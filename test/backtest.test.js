import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const report = JSON.parse(await readFile(new URL('../data/backtest-2026-01_to_2026-10.json', import.meta.url), 'utf8'));

test('過去検証の対象と払戻の照合が一貫している', () => {
  assert.equal(report.candidates, 110);
  assert.equal(report.races.length, 107);
  assert.equal(report.failures.length, 3);
  const ids = new Set();
  for (const race of report.races) {
    const id = [race.date, race.venue, race.race].join('/');
    assert.ok(!ids.has(id), 'duplicate ' + id);
    ids.add(id);
    assert.equal(race.horses.length, 8);
    assert.equal(race.payouts.length, 3);
    const numbers = new Set(race.horses.map(horse => horse.number));
    assert.equal(numbers.size, 8);
    assert.ok(race.payouts.every(payout => numbers.has(payout.number) && payout.yenPer100 >= 100));
    for (const method of Object.values(race.methods)) {
      assert.equal(method.selectedNumbers.length, 6);
      assert.equal(method.stakes.reduce((sum, stake) => sum + stake.yen, 0), 10000);
      const returned = race.payouts.reduce((sum, payout) =>
        sum + (method.stakes.find(stake => stake.number === payout.number)?.yen || 0) / 100 * payout.yenPer100, 0);
      assert.equal(method.returned, returned);
      assert.equal(method.net, returned - 10000);
      assert.ok(method.hits >= 1);
    }
  }
});

test('過去検証の集計が明細と一致する', () => {
  for (const key of ['highInverse', 'highEqual', 'probabilityInverse']) {
    const methods = report.races.map(race => race.methods[key]);
    assert.equal(report.methods[key].count, methods.length);
    assert.equal(report.methods[key].netYen, methods.reduce((sum, method) => sum + method.net, 0));
    assert.equal(report.methods[key].returnedYen, methods.reduce((sum, method) => sum + method.returned, 0));
    assert.equal(report.methods[key].profitableRaces, methods.filter(method => method.net > 0).length);
  }
  const [low, high] = report.uncertainty.highInverseRoi95;
  assert.ok(low < report.methods.highInverse.roi && report.methods.highInverse.roi < high);
  const [differenceLow, differenceHigh] = report.uncertainty.inverseMinusEqualRoi95;
  assert.ok(differenceLow < 0 && differenceHigh > 0);
});
