import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = JSON.parse(await readFile(path.join(root, 'data/backtest-2026-01_to_2026-10.json'), 'utf8'));
const outpath = path.join(root, 'data/runner-history-2026-01_to_2026-10.json');
let output;
try { output = JSON.parse(await readFile(outpath, 'utf8')); }
catch { output = { source: 'JRA JRADB race, horse and jockey pages', generatedAt: null, races: {}, horses: {}, jockeys: {}, errors: [] }; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function page(kind, code) {
  if (!/^[a-zA-Z0-9/]+$/.test(code)) throw new Error('invalid JRA code');
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const response = await fetch(`https://www.jra.go.jp/JRADB/access${kind}.html`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ CNAME: code }), signal: AbortSignal.timeout(20000),
      });
      if (response.status === 403) throw Object.assign(new Error('HTTP 403: JRA access denied'), { fatal: true });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = iconv.decode(Buffer.from(await response.arrayBuffer()), 'Shift_JIS');
      if (html.includes('パラメータエラー')) throw new Error('parameter error');
      await wait(100);
      return cheerio.load(html);
    } catch (error) { if (error.fatal) throw error; last = error; await wait(500 * (i + 1)); }
  }
  throw last;
}
async function pool(items, fn, concurrency = 4) {
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}
const codeFrom = value => value?.match(/(p[a-zA-Z0-9/]+)/)?.[1] ?? null;
const number = value => Number(String(value).replace(/,/g, '').match(/\d+/)?.[0]);
const raceKey = race => `${race.date}|${race.venue}|${race.race}`;

const missingRaces = input.races.filter(r => !output.races[raceKey(r)]);
await pool(missingRaces, async race => {
  try {
    const $ = await page('S', race.resultCode);
    const runners = $('table.striped tbody tr').map((_, tr) => ({
      number: number($(tr).find('td.num').text()),
      horseName: $(tr).find('td.horse').text().trim(),
      horseCode: codeFrom($(tr).find('td.horse a').attr('href')),
      jockeyName: $(tr).find('td.jockey').text().replace(/\s+/g, ' ').trim(),
      jockeyCode: codeFrom($(tr).find('td.jockey a').attr('onclick')),
    })).get().filter(x => x.number);
    if (runners.length !== 8 || runners.some(x => !x.horseCode)) throw new Error('incomplete horse links');
    output.races[raceKey(race)] = runners;
  } catch (error) { if (error.fatal) throw error; output.errors.push({ type: 'race', code: race.resultCode, error: error.message }); }
});
await writeFile(outpath, JSON.stringify(output, null, 2) + '\n');
console.log(`race pages: ${Object.keys(output.races).length}/${input.races.length}`);

const runners = Object.values(output.races).flat();
const horseCodes = [...new Set(runners.map(r => r.horseCode))].filter(code => !output.horses[code]);
let completed = 0;
await pool(horseCodes, async code => {
  try {
    const $ = await page('U', code);
    const starts = $('table').first().find('tr').slice(1).map((_, tr) => {
      const cells = $(tr).find('td');
      const dateText = $(cells[0]).text().trim();
      const m = dateText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      const date = m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
      return date ? {
        date, course: $(cells[3]).text().trim(), fieldSize: number($(cells[5]).text()),
        popularity: number($(cells[6]).text()), finish: number($(cells[7]).text()),
      } : null;
    }).get().filter(x => x.date);
    output.horses[code] = { starts };
  } catch (error) { if (error.fatal) throw error; output.errors.push({ type: 'horse', code, error: error.message }); }
  completed++;
  if (completed % 50 === 0) { await writeFile(outpath, JSON.stringify(output, null, 2) + '\n'); console.log(`horse pages: ${completed}/${horseCodes.length}`); }
});
await writeFile(outpath, JSON.stringify(output, null, 2) + '\n');
console.log(`horse pages total: ${Object.keys(output.horses).length}`);

output.generatedAt = new Date().toISOString();
await writeFile(outpath, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ races: Object.keys(output.races).length, horses: Object.keys(output.horses).length,
  errors: output.errors.length }, null, 2));
