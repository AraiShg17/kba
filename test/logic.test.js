import test from 'node:test';
import assert from 'node:assert/strict';
import { marketProbabilities, defaultSelected, allocate, summary } from '../public/logic.js';
import { parseIndex, parseDay, parseRace, parseOdds } from '../server.js';

const horses = Array.from({ length: 8 }, (_, i) => ({
  number: i + 1, horse: '馬' + (i + 1),
  winOdds: 2 + i * 3, placeLow: 1.2 + i * 0.3, placeHigh: 2 + i * 0.5,
}));

test('市場順位モデルの3着内確率の合計は3', () => {
  const probabilities = marketProbabilities(horses);
  assert.ok(probabilities[0] > probabilities[7]);
  assert.ok(Math.abs(probabilities.reduce((a, b) => a + b, 0) - 3) < 1e-9);
});

test('6頭に100円単位で配分し、56通りすべてを計算する', () => {
  const selected = defaultSelected(horses);
  const stakes = allocate(horses, selected, 10000);
  assert.equal(selected.filter(Boolean).length, 6);
  assert.equal(stakes.reduce((a, b) => a + b, 0), 10000);
  assert.ok(stakes.every(s => s % 100 === 0));
  const result = summary(horses, stakes);
  assert.equal(result.rows.length, 56);
  assert.equal(result.byHits.reduce((sum, row) => sum + row.count, 0), 56);
  assert.equal(result.byHits[0].count, 6);
  assert.ok(result.rows.every(row => row.hits >= 1));
  assert.equal(result.worst, Math.min(...result.rows.map(row => row.lowNet)));
});

test('JRAの開催選択からレースとオッズを読み取る', () => {
  const index = '<h3 class="sub_header">11月14日（土曜）</h3><div class="content"><a onclick="return doAction(\'/JRADB/accessD.html\', \'pw01drl123/AB\');">5回東京3日<span>馬番確定</span></a></div>';
  assert.equal(parseIndex(index)[0].venues[0].code, 'pw01drl123/AB');
  const day = '<table><tr><th class="race_num"><img alt="5レース"></th><td class="time">12時25分</td><td class="race_name">新馬戦</td><td class="dist"><span class="course">芝</span><span class="dist">1,800m</span><span class="num">8頭</span></td><td class="syutsuba"><a href="/JRADB/accessD.html?CNAME=pw01dde123/AB">出馬表</a></td><td class="odds"><a onclick="return doAction(\'/JRADB/accessO.html\', \'pw151ou123/CD\')">オッズ</a></td></tr></table>';
  const race = parseDay(day, '2026-11-14', '東京')[0];
  assert.equal(race.count, 8);
  assert.equal(race.oddsCode, 'pw151ou123/CD');
  assert.equal(parseRace('<table class="basic"><tbody><tr><td class="num">1</td><td class="horse"><div class="name"><a>テスト馬</a></div></td><td class="jockey">騎手</td></tr></tbody></table>')[0].horse, 'テスト馬');
  assert.deepEqual(parseOdds('<table class="tanpuku"><tbody><tr><td class="num">1</td><td class="odds_tan">3.2</td><td class="odds_fuku"><span class="min">1.4</span><span class="max">2.0</span></td></tr></tbody></table>')[0], { number: 1, winOdds: 3.2, placeLow: 1.4, placeHigh: 2 });
});
