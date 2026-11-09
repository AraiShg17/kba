import { marketProbabilities, defaultSelected, allocate, allocateEqual, summary } from './logic.js';

const $ = id => document.getElementById(id);
const yen = value => '¥' + Math.round(value).toLocaleString('ja-JP');
const signed = value => (value >= 0 ? '+' : '−') + yen(Math.abs(value));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const storeKey = 'kba.records.v1';
let current = null;
let selected = [];
let stakes = [];
let records = readRecords();

function readRecords() {
  try {
    const value = JSON.parse(localStorage.getItem(storeKey) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
function persist() {
  try { localStorage.setItem(storeKey, JSON.stringify(records)); }
  catch { alert('保存に失敗しました。ブラウザの保存容量を確認してください。'); }
}
async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '通信エラー');
  return body;
}
function localTime(value) { return new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }); }

async function search() {
  $('refresh').disabled = true;
  $('searchStatus').textContent = 'JRAの出馬表を確認中…';
  $('raceList').replaceChildren();
  try {
    const data = await api('/api/races');
    $('fetchedAt').textContent = '取得 ' + localTime(data.fetchedAt);
    if (data.races.length) {
      $('searchStatus').textContent = data.races.length + '件の8頭立てレースが見つかりました。発売開始時の頭数は購入前に再確認してください。';
      for (const race of data.races) {
        const card = document.createElement('button');
        card.className = 'race-card';
        card.innerHTML = '<span class="race-card-top"><span>' + escapeHtml(race.date.slice(5).replace('-', '/')) + ' · ' + escapeHtml(race.venue) + '</span><span class="eight">8 HEADS</span></span><strong>' + escapeHtml(race.name || race.number + 'レース') + '</strong><small>' + race.number + 'R · ' + escapeHtml(race.course) + ' ' + (race.distance || '') + 'm · ' + escapeHtml(race.time) + '</small><span class="race-cta">分析する <span>→</span></span>';
        card.addEventListener('click', () => loadRace(race));
        $('raceList').append(card);
      }
    } else {
      const available = data.availableDates.length ? 'JRAで現在確認できる日付: ' + data.availableDates.map(d => d.slice(5).replace('-', '/')).join('、') : '出馬表はまだ掲載されていません。';
      $('searchStatus').textContent = '対象日の8頭立てレースは見つかりませんでした。' + available + ' 11月12日以降に再確認してください。';
    }
    if (data.errors.length) $('searchStatus').textContent += ' 一部取得失敗: ' + data.errors.join(' / ');
  } catch (error) { $('searchStatus').textContent = '取得できませんでした: ' + error.message + '。手入力も利用できます。'; }
  $('refresh').disabled = false;
}

async function loadRace(race) {
  $('emptyWorkbench').hidden = true;
  $('workbenchContent').hidden = false;
  $('raceTitle').textContent = race.name || race.number + 'レース';
  $('raceCaption').textContent = race.date + ' / ' + race.venue;
  $('raceMeta').textContent = race.number + 'R · ' + race.course + ' ' + race.distance + 'm · ' + race.time;
  $('jraLink').href = 'https://www.jra.go.jp/JRADB/accessD.html?CNAME=' + encodeURIComponent(race.id);
  $('jraLink').hidden = false;
  $('reloadOdds').hidden = false;
  $('oddsNotice').textContent = '出馬表とオッズを取得中…';
  $('workbench').scrollIntoView({ behavior: 'smooth' });
  try {
    const data = await api('/api/race?id=' + encodeURIComponent(race.id) + '&odds=' + encodeURIComponent(race.oddsCode || ''));
    if (data.horses.length !== 8) throw new Error('現在の出走馬が8頭ではありません');
    current = { ...race, horses: data.horses, fetchedAt: data.fetchedAt };
    selected = defaultSelected(current.horses, $('selectionMode').value);
    $('oddsNotice').textContent = data.oddsError ? 'オッズ取得失敗: ' + data.oddsError + '。数値を確認して手入力できます。' : 'JRAから取得: ' + localTime(data.fetchedAt) + '。複勝オッズは購入時まで変動します。';
    renderWorkbench();
  } catch (error) {
    current = null;
    $('oddsNotice').textContent = '出馬表を読み込めませんでした: ' + error.message;
    $('horseRows').replaceChildren();
  }
}

function renderWorkbench() {
  if (!current) return;
  const probabilities = marketProbabilities(current.horses);
  const excluded = current.horses.filter((_, i) => !selected[i]).map(h => h.number + '番 ' + h.horse);
  const oddsSource = current.horses.every(h => h.placeLow >= 1) ? '複勝オッズ下限' : '単勝オッズ（複勝未掲載の代用）';
  const method = $('selectionMode').value === 'science' ? oddsSource + 'が高い6頭' : '市場ベースの3着内推定が高い6頭';
  $('selectionReason').textContent = '買わない2頭: ' + (excluded.join('、') || 'なし') + '。初期案は' + method + 'を選びます。';
  $('strategyDots').innerHTML = current.horses.map((h, i) => '<div class="strategy-dot ' + (selected[i] ? 'active' : 'excluded') + '"><span>' + h.number + '</span><small>' + (selected[i] ? '買う' : '除外') + '</small></div>').join('');
  const budget = Math.min(10000, Math.max(600, Math.floor(Number($('budget').value) / 100) * 100 || 10000));
  $('budget').value = budget;
  stakes = allocate(current.horses, selected, budget);
  $('horseRows').innerHTML = current.horses.map((horse, i) => {
    const p = probabilities[i];
    const oddsInput = (kind, value) => '<input class="odds-input" type="number" min="1" max="999" step="0.1" data-index="' + i + '" data-kind="' + kind + '" value="' + (value || '') + '" aria-label="' + escapeHtml(horse.horse + ' ' + kind) + '">';
    return '<tr class="' + (selected[i] ? 'chosen' : '') + '"><td><input class="pick" type="checkbox" data-index="' + i + '" ' + (selected[i] ? 'checked' : '') + ' aria-label="' + escapeHtml(horse.horse + 'を購入') + '"></td><td><div class="horse-name"><span class="horse-number">' + horse.number + '</span><div><strong>' + escapeHtml(horse.horse) + '</strong><small>' + escapeHtml(horse.jockey || '') + '</small></div></div></td><td class="prob">' + (p === null ? '—' : (p * 100).toFixed(1) + '%') + '</td><td>' + oddsInput('winOdds', horse.winOdds) + '</td><td>' + oddsInput('placeLow', horse.placeLow) + '</td><td>' + oddsInput('placeHigh', horse.placeHigh) + '</td><td class="bar-cell"><div class="bar"><span style="width:' + (budget ? stakes[i] / budget * 100 : 0) + '%"></span></div><small>' + (budget ? (stakes[i] / budget * 100).toFixed(1) : '0') + '%</small></td><td class="stake">' + (stakes[i] ? yen(stakes[i]) : '—') + '</td></tr>';
  }).join('');
  $('horseRows').querySelectorAll('.pick').forEach(input => input.addEventListener('change', event => {
    selected[Number(event.target.dataset.index)] = event.target.checked;
    renderWorkbench();
  }));
  $('horseRows').querySelectorAll('.odds-input').forEach(input => input.addEventListener('change', event => {
    const { index, kind } = event.target.dataset;
    current.horses[Number(index)][kind] = Number(event.target.value) || null;
    renderWorkbench();
  }));
  renderScenarios();
}

function renderScenarios() {
  const count = selected.filter(Boolean).length;
  const valid = count === 6 && selected.every((yes, i) => !yes || current.horses[i].placeLow >= 1);
  $('selectionNotice').hidden = valid;
  if (!valid) $('selectionNotice').textContent = count !== 6 ? '6頭を選択してください。現在 ' + count + '頭です。' : '購入する6頭すべての複勝下限オッズを入力してください。';
  $('savePlan').disabled = !valid;
  const result = valid ? summary(current.horses, stakes) : null;
  $('costValue').textContent = result ? yen(result.cost) : '—';
  $('worstValue').textContent = result ? signed(result.worst) : '—';
  $('profitValue').textContent = result ? result.profitable + ' / 56' : '—';
  $('hitSummary').innerHTML = result ? result.byHits.map(row => '<div class="hit-card"><span>' + row.hits + '頭的中 <small>' + row.count + '通り</small></span><strong class="' + (row.worst < 0 ? 'negative' : 'positive') + '">' + signed(row.worst) + '</strong><small>下限の最悪収支 / 上限の最大 ' + signed(row.best) + '</small></div>').join('') : '';
  $('scenarioRows').innerHTML = result ? result.rows.map(row => '<tr><td>' + row.winners.join(' · ') + '</td><td>' + row.hits + '頭</td><td class="' + (row.lowNet < 0 ? 'negative' : 'positive') + '">' + signed(row.lowNet) + '</td><td>' + signed(row.highNet) + '</td></tr>').join('') : '';
  const equal = valid ? summary(current.horses, allocateEqual(current.horses, selected, Number($('budget').value))) : null;
  $('methodComparison').innerHTML = result && equal
    ? '<div><span>等額配分 · 1頭的中の最悪収支</span><strong>' + signed(equal.byHits[0].worst) + '</strong></div><div class="recommended"><span>逆数配分 · 1頭的中の最悪収支</span><strong>' + signed(result.byHits[0].worst) + '</strong></div><p>同じ6頭と購入総額で比較。オッズ下限を固定した概算です。逆数配分が常に有利な結果や利益を保証するものではありません。</p>'
    : '';
}

function savePlan() {
  if (!current || selected.filter(Boolean).length !== 6 || !summary(current.horses, stakes).rows.length) return;
  records.unshift({
    id: crypto.randomUUID(), savedAt: new Date().toISOString(),
    race: { date: current.date, venue: current.venue, name: current.name, number: current.number },
    horses: current.horses.map((h, i) => ({ number: h.number, horse: h.horse, stake: stakes[i], placeLow: h.placeLow, placeHigh: h.placeHigh })),
    cost: stakes.reduce((a, b) => a + b, 0),
    worst: summary(current.horses, stakes).worst,
    payout: null, refund: 0,
  });
  persist();
  renderLedger();
  $('ledger').scrollIntoView({ behavior: 'smooth' });
}

function renderLedger() {
  const settled = records.filter(r => r.payout !== null);
  const staked = settled.reduce((s, r) => s + r.cost, 0);
  const returned = settled.reduce((s, r) => s + Number(r.payout) + Number(r.refund || 0), 0);
  $('ledgerStats').innerHTML = '<div><span>記録したレース</span><strong>' + records.length + '件</strong></div><div><span>確定済み</span><strong>' + settled.length + '件</strong></div><div><span>確定収支</span><strong class="' + (returned - staked < 0 ? 'negative' : 'positive') + '">' + signed(returned - staked) + '</strong></div>';
  $('ledgerList').innerHTML = records.length ? records.map(r => {
    const done = r.payout !== null;
    const raceLabel = r.race.date + ' / ' + r.race.venue + (r.race.number ? ' ' + r.race.number + 'R' : ' · 手入力');
    return '<article class="ledger-item" data-id="' + escapeHtml(r.id) + '"><div class="ledger-main"><div><span class="eyebrow">' + escapeHtml(raceLabel) + '</span><h3>' + escapeHtml(r.race.name || 'レース') + '</h3><small>保存 ' + escapeHtml(localTime(r.savedAt)) + ' · 購入 ' + yen(r.cost) + '</small></div><strong class="' + (done ? ((r.payout + r.refund - r.cost) < 0 ? 'negative' : 'positive') : '') + '">' + (done ? signed(r.payout + r.refund - r.cost) : '未確定') + '</strong></div><details><summary>買い目・払戻を確認</summary><div class="ledger-horses">' + r.horses.filter(h => h.stake > 0).map(h => '<span>' + h.number + ' ' + escapeHtml(h.horse) + ' <b>' + yen(h.stake) + '</b></span>').join('') + '</div><div class="settle-form"><label>確定払戻額 <input class="payout-input" type="number" min="0" step="10" value="' + (done ? r.payout : '') + '" placeholder="0"></label><label>返還額 <input class="refund-input" type="number" min="0" step="100" value="' + (r.refund || 0) + '"></label><button class="secondary settle">収支を確定</button><button class="text-button delete">削除</button></div></details></article>';
  }).join('') : '<div class="empty-ledger">保存した購入案はまだありません。</div>';
  $('ledgerList').querySelectorAll('.ledger-item').forEach(item => {
    const id = item.dataset.id;
    item.querySelector('.settle').addEventListener('click', () => {
      const record = records.find(r => r.id === id);
      const payoutInput = item.querySelector('.payout-input');
      const refundInput = item.querySelector('.refund-input');
      if (payoutInput.value === '' || Number(payoutInput.value) < 0 || Number(refundInput.value) < 0) return alert('払戻額と返還額を0円以上で入力してください。');
      record.payout = Number(payoutInput.value);
      record.refund = Number(refundInput.value) || 0;
      persist(); renderLedger();
    });
    item.querySelector('.delete').addEventListener('click', () => {
      if (!confirm('この記録を削除しますか？')) return;
      records = records.filter(r => r.id !== id);
      persist(); renderLedger();
    });
  });
}

function setupManual() {
  $('manualRows').innerHTML = Array.from({ length: 8 }, (_, i) => '<div class="manual-row"><span>' + (i + 1) + '</span><input class="manual-horse" placeholder="馬名" aria-label="' + (i + 1) + '番の馬名"><input class="manual-win" type="number" min="1.1" step="0.1" placeholder="単勝" aria-label="' + (i + 1) + '番の単勝オッズ"><input class="manual-low" type="number" min="1" step="0.1" placeholder="複勝下限" aria-label="' + (i + 1) + '番の複勝下限"><input class="manual-high" type="number" min="1" step="0.1" placeholder="複勝上限" aria-label="' + (i + 1) + '番の複勝上限"></div>').join('');
  $('loadManual').addEventListener('click', () => {
    const horses = [...$('manualRows').querySelectorAll('.manual-row')].map((row, i) => ({
      number: i + 1, horse: row.querySelector('.manual-horse').value.trim(),
      winOdds: Number(row.querySelector('.manual-win').value) || null,
      placeLow: Number(row.querySelector('.manual-low').value) || null,
      placeHigh: Number(row.querySelector('.manual-high').value) || null,
      past: [],
    }));
    if (horses.some(h => !h.horse || !(h.placeLow >= 1))) return alert('8頭すべての馬名と複勝下限を入力してください。');
    current = { date: $('manualDate').value, venue: $('manualVenue').value.trim(), name: $('manualName').value.trim() || '手入力レース', number: 0, course: '', distance: '', time: '', horses };
    selected = defaultSelected(horses, $('selectionMode').value);
    $('emptyWorkbench').hidden = true; $('workbenchContent').hidden = false;
    $('raceCaption').textContent = current.date + ' / ' + current.venue;
    $('raceTitle').textContent = current.name;
    $('raceMeta').textContent = '手入力データ · 8頭';
    $('oddsNotice').textContent = '手入力データです。馬名・オッズの正確性をJRAで確認してください。';
    $('jraLink').hidden = true;
    $('reloadOdds').hidden = true;
    renderWorkbench();
    $('workbench').scrollIntoView({ behavior: 'smooth' });
  });
}

$('refresh').addEventListener('click', search);
$('budget').addEventListener('change', renderWorkbench);
$('autoSelect').addEventListener('click', () => { if (current) { selected = defaultSelected(current.horses, $('selectionMode').value); renderWorkbench(); } });
$('selectionMode').addEventListener('change', () => { if (current) { selected = defaultSelected(current.horses, $('selectionMode').value); renderWorkbench(); } });
$('reloadOdds').addEventListener('click', () => { if (current?.id) loadRace(current); });
$('savePlan').addEventListener('click', savePlan);
$('exportData').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), records }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'kba-records-' + new Date().toISOString().slice(0, 10) + '.json'; link.click(); URL.revokeObjectURL(link.href);
});
$('importData').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.version !== 1 || !Array.isArray(data.records) || data.records.some(r => !r.id || !r.race || !Array.isArray(r.horses) || !Number.isFinite(r.cost) || (r.payout !== null && !Number.isFinite(r.payout)) || !Number.isFinite(r.refund))) throw new Error('対応していない記録形式です');
    const known = new Set(records.map(r => r.id));
    const added = data.records.filter(r => !known.has(r.id));
    records = [...added, ...records];
    persist(); renderLedger();
    alert(added.length + '件の記録を読み込みました。');
  } catch (error) { alert('読み込みに失敗しました: ' + error.message); }
  event.target.value = '';
});
$('askAi').addEventListener('click', async () => {
  if (!current) return;
  $('askAi').disabled = true; $('aiOutput').hidden = false; $('aiOutput').textContent = '分析中…';
  try { $('aiOutput').textContent = (await api('/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(current) })).text; }
  catch (error) { $('aiOutput').textContent = '分析に失敗しました: ' + error.message; }
  $('askAi').disabled = false;
});
api('/api/ai/status').then(data => { $('askAi').disabled = !data.available; $('askAi').textContent = data.available ? 'AIで分析' : 'APIキー未設定'; }).catch(() => {});
setupManual(); renderLedger(); search();
