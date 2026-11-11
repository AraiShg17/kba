import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const sourceUrl = 'https://db-keiba.com/jockey-2025/';
const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(20000) });
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const $ = cheerio.load(await response.text());
const normalize = value => value.normalize('NFKC').replace(/[\s·・]/g, '').toLowerCase();
const rows = $('table.tablepress-id-20125').first().find('tr').slice(1).map((_, tr) => {
  const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
  const [rank, name, wins, seconds, thirds, unplaced, starts] = cells;
  if (!name || !Number(starts)) return null;
  if (Number(wins) + Number(seconds) + Number(thirds) + Number(unplaced) !== Number(starts)) throw new Error('bad row: ' + name);
  return { rank: Number(rank), name, key: normalize(name), wins: Number(wins), seconds: Number(seconds),
    thirds: Number(thirds), starts: Number(starts), winRate: Number(wins) / Number(starts),
    top3Rate: (Number(wins) + Number(seconds) + Number(thirds)) / Number(starts) };
}).get();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await writeFile(path.join(root, 'data/jockey-2025.json'), JSON.stringify({ sourceUrl, year: 2025,
  note: 'Third-party compiled JRA results; checked sample 津村明秀 against JRA jockey past-results page.',
  rows }, null, 2) + '\n');
console.log(JSON.stringify({ count: rows.length, tsumu: rows.find(x => x.key === normalize('津村 明秀')) }, null, 2));
