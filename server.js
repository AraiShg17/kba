import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import dotenv from 'dotenv';

const root = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(root, '.env.local'), quiet: true });
const jra = 'https://www.jra.go.jp';
const port = Number(process.env.PORT || 3000);
const cache = new Map();

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function jraPage(kind, code, ttl = 30000) {
  if (!/^[a-zA-Z0-9/]+$/.test(code) || code.length > 100) throw new Error('JRAのページ指定が不正です');
  const key = kind + ':' + code;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.html;
  const response = await fetch(jra + '/JRADB/access' + kind + '.html', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ CNAME: code }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error('JRA応答: ' + response.status);
  const html = iconv.decode(Buffer.from(await response.arrayBuffer()), 'Shift_JIS');
  if (html.includes('パラメータエラー')) throw new Error('JRAのページを取得できませんでした');
  cache.set(key, { html, at: Date.now() });
  return html;
}

function codeFrom(text = '') {
  return text.match(/(?:CNAME=|['"])(p[a-zA-Z0-9/]+)(?:['"]|$)/)?.[1] || null;
}

export function parseIndex(html) {
  const $ = cheerio.load(html);
  const days = [];
  $('.sub_header').each((_, el) => {
    const md = $(el).text().match(/(\d+)月(\d+)日/);
    if (!md) return;
    const venues = $(el).next('.content').find('a[onclick*="pw01drl"]').map((_, a) => ({
      venue: $(a).text().replace(/馬番確定/g, '').trim(),
      code: codeFrom($(a).attr('onclick')),
    })).get().filter(v => v.code);
    if (venues.length) days.push({ date: '2026-' + md[1].padStart(2, '0') + '-' + md[2].padStart(2, '0'), venues });
  });
  return days;
}

export function parseDay(html, date, venue) {
  const $ = cheerio.load(html);
  const rows = [];
  $('tr').each((_, tr) => {
    const num = Number($(tr).find('.race_num img').attr('alt')?.match(/\d+/)?.[0]);
    const count = Number($(tr).find('td.dist .num').first().text().match(/\d+/)?.[0]);
    const id = codeFrom($(tr).find('td.syutsuba a').attr('href'));
    if (!num || !count || !id) return;
    rows.push({
      id, date, venue, number: num, count,
      name: $(tr).find('td.race_name').text().replace(/\s+/g, ' ').trim(),
      time: $(tr).find('td.time').text().trim(),
      course: $(tr).find('td.dist .course').text().trim(),
      distance: Number($(tr).find('td.dist .dist').text().replace(/,/g, '').match(/\d+/)?.[0]) || null,
      oddsCode: codeFrom($(tr).find('td.odds a').attr('onclick')),
    });
  });
  return rows;
}

export function parseRace(html) {
  const $ = cheerio.load(html);
  return $('table.basic tbody tr').map((_, tr) => {
    const number = Number($(tr).find('td.num').first().text().trim());
    const horse = $(tr).find('td.horse .name a').first().text().trim();
    if (!number || !horse) return null;
    const past = $(tr).find('td.past').map((_, td) => $(td).text().replace(/\s+/g, ' ').trim().slice(0, 160)).get().filter(Boolean);
    return { number, horse, jockey: $(tr).find('td.jockey').text().replace(/\s+/g, ' ').trim(), past };
  }).get();
}

export function parseOdds(html) {
  const $ = cheerio.load(html);
  return $('table.tanpuku tbody tr').map((_, tr) => {
    const number = Number($(tr).find('td.num').first().text().trim());
    if (!number) return null;
    return {
      number,
      winOdds: Number($(tr).find('td.odds_tan').text().trim()) || null,
      placeLow: Number($(tr).find('td.odds_fuku .min').text().trim()) || null,
      placeHigh: Number($(tr).find('td.odds_fuku .max').text().trim()) || null,
    };
  }).get();
}

async function findRaces(dates) {
  const index = parseIndex(await jraPage('D', 'pw01dli00/F3'));
  const found = index.filter(day => dates.includes(day.date));
  const pages = await Promise.all(found.flatMap(day => day.venues.map(async v => {
    try { return { races: parseDay(await jraPage('D', v.code), day.date, v.venue) }; }
    catch (error) { return { error: day.date + ' ' + v.venue + ': ' + error.message }; }
  })));
  return {
    availableDates: index.map(day => day.date),
    races: pages.flatMap(p => p.races || []).filter(r => r.count === 8),
    errors: pages.filter(p => p.error).map(p => p.error),
    fetchedAt: new Date().toISOString(),
  };
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 50000) throw new Error('入力が大きすぎます');
  }
  return JSON.parse(body || '{}');
}

async function aiAnalysis(race) {
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('OPENAI_API_KEY が未設定です'), { status: 503 });
  const horses = (race.horses || []).slice(0, 8).map(h => ({
    number: h.number, horse: h.horse, winOdds: h.winOdds,
    placeLow: h.placeLow, placeHigh: h.placeHigh, past: h.past,
  }));
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      instructions: '日本語で簡潔に競馬データを分析する。提供されていない情報は推測しない。利益や的中の保証をしない。市場オッズ由来の確率は独立した予測ではないことを明記する。各馬の強みと不確実性を述べ、購入判断の参考にする。',
      input: JSON.stringify({ race: race.name, date: race.date, venue: race.venue, horses }),
      max_output_tokens: 650,
    }),
    signal: AbortSignal.timeout(25000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'AI応答: ' + response.status);
  return data.output?.flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('\n') || '分析文を取得できませんでした';
}

const files = {
  '/': ['public/index.html', 'text/html'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/logic.js': ['public/logic.js', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost:' + port);
    if (url.pathname === '/api/races' && req.method === 'GET') {
      const dates = (url.searchParams.get('dates') || '2026-11-14,2026-11-15').split(',').filter(d => /^2026-\d{2}-\d{2}$/.test(d)).slice(0, 2);
      return json(res, 200, await findRaces(dates));
    }
    if (url.pathname === '/api/race' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      const oddsCode = url.searchParams.get('odds') || '';
      const horses = parseRace(await jraPage('D', id));
      let odds = [], oddsError = null;
      if (oddsCode) {
        try { odds = parseOdds(await jraPage('O', oddsCode, 15000)); }
        catch (error) { oddsError = error.message; }
      }
      return json(res, 200, { horses: horses.map(h => ({ ...h, ...(odds.find(o => o.number === h.number) || {}) })), oddsError, fetchedAt: new Date().toISOString() });
    }
    if (url.pathname === '/api/ai/status' && req.method === 'GET') return json(res, 200, { available: Boolean(process.env.OPENAI_API_KEY) });
    if (url.pathname === '/api/ai' && req.method === 'POST') return json(res, 200, { text: await aiAnalysis(await readBody(req)) });
    if (files[url.pathname] && req.method === 'GET') {
      const [file, contentType] = files[url.pathname];
      res.writeHead(200, { 'content-type': contentType + '; charset=utf-8' });
      return res.end(await readFile(path.join(root, file)));
    }
    return json(res, 404, { error: '見つかりません' });
  } catch (error) { return json(res, error.status || 500, { error: error.message || '取得に失敗しました' }); }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + port));
}
export { server };
