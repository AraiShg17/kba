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

export function defaultSelected(horses) {
  const p = marketProbabilities(horses);
  if (p.some(v => v === null)) return horses.map((_, i) => i < 6);
  const order = p.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value);
  const chosen = new Set(order.slice(0, 6).map(x => x.index));
  return horses.map((_, i) => chosen.has(i));
}

export function allocate(horses, selected, budget) {
  const stakes = horses.map(() => 0);
  const indices = selected.map((yes, i) => yes ? i : -1).filter(i => i >= 0);
  const units = Math.floor(Number(budget) / 100);
  if (indices.length !== 6 || units < 6 || indices.some(i => !(horses[i].placeLow > 0))) return stakes;
  for (const i of indices) stakes[i] = 100;
  for (let n = 6; n < units; n++) {
    const i = indices.reduce((best, current) => stakes[current] * horses[current].placeLow < stakes[best] * horses[best].placeLow ? current : best);
    stakes[i] += 100;
  }
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
