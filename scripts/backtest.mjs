import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { parseOdds } from '../server.js';
import { defaultSelected, allocate, allocateEqual } from '../public/logic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const months = (process.argv.find(arg => arg.startsWith('--months='))?.split('=')[1] ||
  Array.from({ length: 10 }, (_, i) => '2026-' + String(i + 1).padStart(2, '0')).join(',')).split(',');
const budget = 10000;
const origin = 'https://www.jra.go.jp/JRADB';
const pageCache = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function page(kind, code) {
  const key = kind + ':' + code;
  if (pageCache.has(key)) return pageCache.get(key);
  if (!/^[a-zA-Z0-9/]+$/.test(code)) throw new Error('invalid JRA code');
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(origin + '/access' + kind + '.html', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ CNAME: code }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const html = iconv.decode(Buffer.from(await response.arrayBuffer()), 'Shift_JIS');
      if (html.includes('パラメータエラー')) throw new Error('parameter error');
      pageCache.set(key, html);
      await delay(80);
      return html;
    } catch (error) { last = error; await delay(400 * (attempt + 1)); }
  }
  throw last;
}
const codeFrom = text => text?.match(/(?:CNAME=|['"])(p[a-zA-Z0-9/]+)(?:['"]|$)/)?.[1] || null;
async function pool(items, worker, size = 3) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
}

function monthCodes(html, month) {
  const short = month.replace('-', '').slice(2);
  const checksum = html.match(new RegExp('objParam\\["' + short + '"\\]="([A-F0-9]+)"'))?.[1];
  if (!checksum) throw new Error('month unavailable: ' + month);
  const yearMonth = month.replace('-', '');
  const currentMonth = html.match(/var yearMonth = "(\d{6})"/)?.[1];
  return 'pw01skl' + (currentMonth && yearMonth >= currentMonth ? '00' : '10') + yearMonth + '/' + checksum;
}

function daysFromMonth(html) {
  const $ = cheerio.load(html);
  return $('#past_result a[onclick*="pw01srl"]').map((_, a) => ({
    venue: $(a).text().trim(),
    code: codeFrom($(a).attr('onclick')),
  })).get().filter(row => row.code);
}

function racesFromDay(html, day) {
  const $ = cheerio.load(html);
  const date = day.code.match(/(20\d{6})\/[A-F0-9]+$/)?.[1];
  return $('tr').map((_, tr) => {
    const count = Number($(tr).find('td.num').text().match(/\d+/)?.[0]);
    if (count !== 8) return null;
    const resultCode = codeFrom($(tr).find('th.race_num a').attr('href'));
    const oddsCode = codeFrom($(tr).find('td.odds a').attr('onclick'));
    if (!resultCode || !oddsCode) return null;
    return {
      date: date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6),
      venue: day.venue,
      race: Number($(tr).find('th.race_num img').attr('alt')?.match(/\d+/)?.[0]),
      name: $(tr).find('td.race_name').text().replace(/\s+/g, ' ').trim(),
      resultCode, oddsCode,
    };
  }).get();
}

function parseResult(html) {
  const $ = cheerio.load(html);
  const entries = $('table.striped tbody tr').map((_, tr) => ({
    placeText: $(tr).find('td.place').text().trim(),
    number: Number($(tr).find('td.num').text().trim()),
  })).get().filter(row => row.number);
  const finishes = entries.map(row => ({ place: Number(row.placeText), number: row.number })).filter(row => row.place);
  const payouts = $('.refund_area li.place .line').map((_, el) => ({
    number: Number($(el).find('.num').text().trim()),
    yenPer100: Number($(el).find('.yen').text().replace(/,/g, '').match(/\d+/)?.[0]),
  })).get().filter(row => row.number && row.yenPer100);
  return { entries, finishes, payouts };
}

function score(horses, payouts, selected, stakes, method) {
  const returned = payouts.reduce((sum, payout) => {
    const index = horses.findIndex(h => h.number === payout.number);
    return sum + (index >= 0 ? (stakes[index] / 100) * payout.yenPer100 : 0);
  }, 0);
  const hits = payouts.filter(p => {
    const index = horses.findIndex(h => h.number === p.number);
    return index >= 0 && selected[index];
  }).length;
  return {
    method,
    selectedNumbers: horses.filter((_, i) => selected[i]).map(h => h.number),
    stakes: horses.map((h, i) => ({ number: h.number, yen: stakes[i] })).filter(row => row.yen),
    hits, returned, net: returned - budget,
  };
}

function summarize(rows, key) {
  const scored = rows.map(r => r.methods[key]).filter(Boolean);
  const net = scored.map(r => r.net);
  const ordered = [...net].sort((a, b) => a - b);
  let cumulative = 0, peak = 0, maxDrawdown = 0;
  for (const n of net) { cumulative += n; peak = Math.max(peak, cumulative); maxDrawdown = Math.max(maxDrawdown, peak - cumulative); }
  return {
    count: scored.length,
    stakeYen: scored.length * budget,
    returnedYen: scored.reduce((sum, r) => sum + r.returned, 0),
    netYen: net.reduce((sum, n) => sum + n, 0),
    roi: scored.length ? net.reduce((sum, n) => sum + n, 0) / (scored.length * budget) : null,
    profitableRaces: net.filter(n => n > 0).length,
    breakEvenRaces: net.filter(n => n === 0).length,
    medianNetYen: ordered.length ? (ordered[Math.floor((ordered.length - 1) / 2)] + ordered[Math.floor(ordered.length / 2)]) / 2 : null,
    minNetYen: ordered[0] ?? null,
    maxNetYen: ordered.at(-1) ?? null,
    maxDrawdownYen: maxDrawdown,
    hitCounts: [1, 2, 3].map(hits => scored.filter(r => r.hits === hits).length),
  };
}

function bootstrapIntervals(rows) {
  let seed = 20261109;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  const inverseRoi = [], advantageRoi = [];
  for (let run = 0; run < 10000; run++) {
    let inverse = 0, equal = 0;
    for (let i = 0; i < rows.length; i++) {
      const race = rows[Math.floor(random() * rows.length)];
      inverse += race.methods.highInverse.net;
      equal += race.methods.highEqual.net;
    }
    inverseRoi.push(inverse / (rows.length * budget));
    advantageRoi.push((inverse - equal) / (rows.length * budget));
  }
  const interval = values => {
    values.sort((a, b) => a - b);
    return [values[250], values[9750]];
  };
  return { method: 'race-level percentile bootstrap, 10000 resamples, LCG seed 20261109',
    highInverseRoi95: interval(inverseRoi), inverseMinusEqualRoi95: interval(advantageRoi) };
}

async function run() {
  const search = await page('S', 'pw01skl00999999/B3');
  const all = [], failures = [];
  for (const month of months) {
    const monthPage = await page('S', monthCodes(search, month));
    const days = daysFromMonth(monthPage);
    console.log(month + ': ' + days.length + '開催日・場を確認');
    const dayPages = await pool(days, async day => {
      try { return racesFromDay(await page('S', day.code), day); }
      catch (error) { failures.push({ stage: 'day', code: day.code, error: error.message }); return []; }
    });
    const races = dayPages.flat();
    console.log(month + ': 8頭立て ' + races.length + 'レース');
    const monthRows = await pool(races, async race => {
      try {
        const [oddsHtml, resultHtml] = await Promise.all([page('O', race.oddsCode), page('S', race.resultCode)]);
        const horses = parseOdds(oddsHtml);
        const result = parseResult(resultHtml);
        const oddsNumbers = new Set(horses.map(h => h.number));
        const entryNumbers = new Set(result.entries.map(e => e.number));
        const payoutNumbers = new Set(result.payouts.map(p => p.number));
        const finishTop = result.finishes.filter(f => f.place <= 3).map(f => f.number).sort((a, b) => a - b);
        const payoutTop = [...payoutNumbers].sort((a, b) => a - b);
        if (horses.length !== 8 || result.entries.length !== 8 || result.payouts.length !== 3 ||
            oddsNumbers.size !== 8 || entryNumbers.size !== 8 || payoutNumbers.size !== 3 ||
            [...oddsNumbers].sort((a, b) => a - b).join(',') !== [...entryNumbers].sort((a, b) => a - b).join(',') ||
            result.entries.some(e => /取消|除外/.test(e.placeText)) ||
            finishTop.join(',') !== payoutTop.join(',') ||
            horses.some(h => !(h.winOdds >= 1) || !(h.placeLow >= 1) || !(h.placeHigh >= h.placeLow))) {
          throw new Error('照合失敗 odds=' + horses.length + ' entries=' + result.entries.length +
            ' payout=' + result.payouts.length + ' top=' + finishTop.join(',') +
            ' payoutTop=' + payoutTop.join(',') + ' oddsNumbers=' + [...oddsNumbers].join(','));
        }
        const high = defaultSelected(horses, 'science');
        const probability = defaultSelected(horses, 'probability');
        const highInverse = allocate(horses, high, budget);
        const highEqual = allocateEqual(horses, high, budget);
        const probabilityInverse = allocate(horses, probability, budget);
        return {
          ...race, resultUrl: 'https://www.jra.go.jp/JRADB/accessS.html?CNAME=' + race.resultCode,
          oddsUrl: 'https://www.jra.go.jp/JRADB/accessO.html?CNAME=' + race.oddsCode,
          horses, payouts: result.payouts,
          methods: {
            highInverse: score(horses, result.payouts, high, highInverse, '高オッズ6頭・逆数配分'),
            highEqual: score(horses, result.payouts, high, highEqual, '高オッズ6頭・等額配分'),
            probabilityInverse: score(horses, result.payouts, probability, probabilityInverse, '市場推定上位6頭・逆数配分'),
          },
        };
      } catch (error) { failures.push({ stage: 'race', code: race.resultCode, error: error.message }); return null; }
    });
    all.push(...monthRows.filter(Boolean));
    console.log(month + ': 完全取得 ' + monthRows.filter(Boolean).length + '件');
  }
  all.sort((a, b) => a.date.localeCompare(b.date) || a.venue.localeCompare(b.venue) || a.race - b.race);
  const report = {
    generatedAt: new Date().toISOString(), months, budgetYen: budget,
    design: '最終オッズで選定・配分し、JRA確定複勝払戻で評価。最終オッズは発走前の購入時点では確定していないため、これは事後情報を使う遡及シミュレーションであり、実行可能な戦略成績ではない。',
    candidates: all.length + failures.filter(f => f.stage === 'race').length,
    failures, methods: {
      highInverse: summarize(all, 'highInverse'),
      highEqual: summarize(all, 'highEqual'),
      probabilityInverse: summarize(all, 'probabilityInverse'),
    },
    uncertainty: bootstrapIntervals(all),
    races: all,
  };
  const dir = path.join(root, 'data');
  await mkdir(dir, { recursive: true });
  const outfile = path.join(dir, 'backtest-' + months[0] + '_to_' + months.at(-1) + '.json');
  await writeFile(outfile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ outfile, candidates: report.candidates, failures: failures.length, methods: report.methods }, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
