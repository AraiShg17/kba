export function marketProbabilities(horses) {
  const weights = horses.map(h => h.winOdds >= 1 ? 1 / h.winOdds : 0);
  const total = weights.reduce((a, b) => a + b, 0);
  if (horses.length !== 8 || weights.some(w => !w) || !total) return horses.map(() => null);
  const probabilities = horses.map(() => 0);
  for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) for (let c = 0; c < 8; c++) {
    if (a === b || a === c || b === c) continue;
    const p = weights[a] / total * weights[b] / (total - weights[a]) * weights[c] / (total - weights[a] - weights[b]);
    probabilities[a] += p; probabilities[b] += p; probabilities[c] += p;
  }
  return probabilities;
}

export function defaultSelected(horses, mode = 'science') {
  const p = marketProbabilities(horses);
  const placeAvailable = horses.every(h => h.placeLow >= 1);
  const winAvailable = horses.every(h => h.winOdds >= 1);
  const values = mode === 'probability'
    ? p
    : placeAvailable ? horses.map(h => h.placeLow) : winAvailable ? horses.map(h => h.winOdds) : horses.map(() => null);
  if (values.some(v => v === null)) return horses.map((_, i) => i < 6);
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value || a.index - b.index);
  const chosen = new Set(order.slice(0, 6).map(x => x.index));
  return horses.map((_, i) => chosen.has(i));
}

// 100円単位のミニマックス配分。1頭だけ的中した場合の最低払戻を最大化する。
// 連続額での比率は 1/複勝オッズ。二分探索で整数単位の最適な最低払戻を求める。
export function allocate(horses, selected, budget) {
  const stakes = horses.map(() => 0);
  const indices = selected.map((yes, i) => yes ? i : -1).filter(i => i >= 0);
  const units = Math.floor(Number(budget) / 100);
  if (indices.length !== 6 || units < 6 || indices.some(i => !(horses[i].placeLow > 0))) return stakes;
  const payoutPerUnit = indices.map(i => Math.round(horses[i].placeLow * 100));
  const needed = target => payoutPerUnit.reduce((sum, payout) => sum + Math.max(1, Math.ceil(target / payout)), 0);
  let low = 0, high = Math.max(...payoutPerUnit) * units;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (needed(mid) <= units) low = mid;
    else high = mid - 1;
  }
  indices.forEach((i, position) => {
    stakes[i] = Math.max(1, Math.ceil(low / payoutPerUnit[position])) * 100;
  });
  let remaining = units - stakes.reduce((sum, amount) => sum + amount / 100, 0);
  while (remaining-- > 0) {
    const i = indices.reduce((best, current) => stakes[current] * horses[current].placeLow < stakes[best] * horses[best].placeLow ? current : best);
    stakes[i] += 100;
  }
  return stakes;
}

export function allocateEqual(horses, selected, budget) {
  const stakes = horses.map(() => 0);
  const indices = selected.map((yes, i) => yes ? i : -1).filter(i => i >= 0);
  const units = Math.floor(Number(budget) / 100);
  if (indices.length !== 6 || units < 6) return stakes;
  const base = Math.floor(units / 6);
  indices.forEach((i, order) => { stakes[i] = (base + (order < units % 6 ? 1 : 0)) * 100; });
  return stakes;
}

export function scenarios(horses, stakes) {
  const cost = stakes.reduce((a, b) => a + b, 0);
  if (horses.length !== 8 || stakes.filter(s => s > 0).length !== 6 || cost <= 0) return [];
  const rows = [];
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) for (let c = b + 1; c < 8; c++) {
    const winners = [a, b, c];
    const low = winners.reduce((sum, i) => sum + stakes[i] * (horses[i].placeLow || 0), 0);
    const high = winners.reduce((sum, i) => sum + stakes[i] * (horses[i].placeHigh || horses[i].placeLow || 0), 0);
    rows.push({ winners: winners.map(i => horses[i].number), hits: winners.filter(i => stakes[i] > 0).length, low: Math.round(low), high: Math.round(high), lowNet: Math.round(low - cost), highNet: Math.round(high - cost) });
  }
  return rows.sort((a, b) => a.lowNet - b.lowNet);
}

export function summary(horses, stakes) {
  const rows = scenarios(horses, stakes);
  const cost = stakes.reduce((a, b) => a + b, 0);
  return {
    cost, rows, worst: rows.length ? rows[0].lowNet : null,
    best: rows.length ? Math.max(...rows.map(r => r.highNet)) : null,
    profitable: rows.filter(r => r.lowNet > 0).length,
    byHits: [1, 2, 3].map(hits => {
      const group = rows.filter(r => r.hits === hits);
      return { hits, count: group.length, worst: group.length ? Math.min(...group.map(r => r.lowNet)) : null, best: group.length ? Math.max(...group.map(r => r.highNet)) : null };
    }),
  };
}
