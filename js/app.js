'use strict';

/* ---------- storage ---------- */

const STORAGE_KEY = 'winterDietTracker.v1';

const DEFAULT_PROFILE = {
  heightCm: 188,
  age: 40,
  startDate: '2026-09-02',
  startWeight: 120,
  goalDate: '2027-04-01',
  goalWeight: 90
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { profile: { ...DEFAULT_PROFILE }, entries: [] };
    const parsed = JSON.parse(raw);
    return {
      profile: { ...DEFAULT_PROFILE, ...(parsed.profile || {}) },
      entries: Array.isArray(parsed.entries) ? parsed.entries : []
    };
  } catch (e) {
    console.error('Failed to load state, starting fresh', e);
    return { profile: { ...DEFAULT_PROFILE }, entries: [] };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();

/* ---------- date helpers ---------- */

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  const MS = 86400000;
  return Math.round((new Date(b) - new Date(a)) / MS);
}
function startOfWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

/* ---------- calculations ---------- */

function sortedEntries() {
  return [...state.entries].sort((a, b) => a.date.localeCompare(b.date));
}

function weighedEntries() {
  return sortedEntries().filter(e => e.weight != null && e.weight !== '');
}

function currentWeight() {
  const w = weighedEntries();
  if (w.length) return Number(w[w.length - 1].weight);
  return Number(state.profile.startWeight);
}

function linearRegressionSlopePerDay(points) {
  // points: [{x: dayIndex, y: weight}]
  const n = points.length;
  if (n < 2) return null;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom; // kg per day
}

function computeStats() {
  const profile = state.profile;
  const cur = currentWeight();
  const totalLost = Number(profile.startWeight) - cur;
  const kgToGo = cur - Number(profile.goalWeight);
  const today = todayISO();
  const daysLeft = Math.max(daysBetween(today, profile.goalDate), 0);
  const weeksLeft = daysLeft / 7;
  const requiredWeeklyRate = weeksLeft > 0 ? kgToGo / weeksLeft : (kgToGo > 0 ? Infinity : 0);

  // actual trend: regression over last 21 days of weighed entries (fallback: all)
  const w = weighedEntries();
  const cutoff = daysBetween('1970-01-01', today) - 21;
  let recent = w.filter(e => daysBetween('1970-01-01', e.date) >= cutoff);
  if (recent.length < 2) recent = w;
  const points = recent.map(e => ({ x: daysBetween('1970-01-01', e.date), y: Number(e.weight) }));
  const slopePerDay = linearRegressionSlopePerDay(points); // negative = losing weight
  const actualWeeklyRate = slopePerDay != null ? -slopePerDay * 7 : null;

  let projectedFinishDate = null;
  if (slopePerDay != null && slopePerDay < 0) {
    const daysToGoal = (Number(profile.goalWeight) - cur) / slopePerDay;
    if (daysToGoal > 0) {
      const d = new Date();
      d.setDate(d.getDate() + Math.round(daysToGoal));
      projectedFinishDate = d.toISOString().slice(0, 10);
    }
  }

  let status = 'neutral';
  if (kgToGo <= 0) status = 'good';
  else if (actualWeeklyRate == null) status = 'neutral';
  else if (actualWeeklyRate >= requiredWeeklyRate * 0.95) status = 'good';
  else if (actualWeeklyRate >= requiredWeeklyRate * 0.75) status = 'warn';
  else status = 'bad';

  return {
    cur, totalLost, kgToGo, daysLeft, weeksLeft,
    requiredWeeklyRate, actualWeeklyRate, projectedFinishDate, status
  };
}

/* rough Mifflin-St Jeor, male. Sedentary base (desk job, no incidental
   exercise) plus explicit add-ons for logged activity, rather than folding
   an assumed activity level into a flat multiplier. */
const ACTIVITY_KCAL = {
  golf: 400,       // walking 18 holes
  dogWalkEach: 120, // per brisk 30-45 min walk
  football: 150     // matchday walking/standing/travel
};

function sedentaryTDEEForWeight(weightKg) {
  const p = state.profile;
  const bmr = 10 * weightKg + 6.25 * Number(p.heightCm) - 5 * Number(p.age) + 5;
  return bmr * 1.2;
}

function activityCalories(entry) {
  if (!entry) return 0;
  let cals = 0;
  if (entry.golf) cals += ACTIVITY_KCAL.golf;
  if (entry.dogWalks) cals += Number(entry.dogWalks) * ACTIVITY_KCAL.dogWalkEach;
  if (entry.football) cals += ACTIVITY_KCAL.football;
  return cals;
}

function estimateTDEEForEntry(weightKg, entry) {
  return sedentaryTDEEForWeight(weightKg) + activityCalories(entry);
}

function estimateCalories(stats) {
  // no specific day to key activity off, so assume the daily dog walks
  // that are a near-constant in the routine
  const tdee = sedentaryTDEEForWeight(stats.cur) + 2 * ACTIVITY_KCAL.dogWalkEach;
  const requiredRate = isFinite(stats.requiredWeeklyRate) ? stats.requiredWeeklyRate : 0;
  const deficitPerDay = (requiredRate * 7700) / 7;
  const target = Math.max(tdee - deficitPerDay, 1400);
  return { bmr: 10 * stats.cur + 6.25 * Number(state.profile.heightCm) - 5 * Number(state.profile.age) + 5, tdee, deficitPerDay, target };
}

/* actual daily calorie deficit (estimated maintenance - logged calories),
   maintenance adjusted for that day's logged golf/dog walks/football, for
   days with calories logged */
function dailyDeficitEntries() {
  const w = weighedEntries();
  return sortedEntries()
    .filter(e => e.calories != null)
    .map(e => {
      let weightForDay = e.weight != null && e.weight !== '' ? Number(e.weight) : null;
      if (weightForDay == null) {
        const priorWeighed = w.filter(we => we.date <= e.date);
        weightForDay = priorWeighed.length
          ? Number(priorWeighed[priorWeighed.length - 1].weight)
          : Number(state.profile.startWeight);
      }
      const tdee = estimateTDEEForEntry(weightForDay, e);
      return { date: e.date, deficit: tdee - Number(e.calories) };
    });
}

function weeklyDeficitAvg() {
  const wk = startOfWeek(todayISO());
  const list = dailyDeficitEntries().filter(d => d.date >= wk);
  if (!list.length) return null;
  return { avg: list.reduce((s, d) => s + d.deficit, 0) / list.length, count: list.length };
}

/* ---------- rendering: stat grid ---------- */

function statCardHTML(label, value, sub, tone) {
  return `<div class="stat ${tone || ''}">
    <div class="label">${label}</div>
    <div class="value">${value}</div>
    <div class="sub">${sub || ''}</div>
  </div>`;
}

function renderStats() {
  const s = computeStats();
  const grid = document.getElementById('statGrid');
  const rate = s.actualWeeklyRate;
  const rateStr = rate == null ? 'not enough data' : `${rate.toFixed(2)} kg/wk`;
  const reqStr = isFinite(s.requiredWeeklyRate) ? `${s.requiredWeeklyRate.toFixed(2)} kg/wk needed` : 'goal date passed';

  grid.innerHTML = [
    statCardHTML('Current weight', `${s.cur.toFixed(1)} kg`, `${s.totalLost >= 0 ? '-' : '+'}${Math.abs(s.totalLost).toFixed(1)} kg so far`),
    statCardHTML('To go', `${Math.max(s.kgToGo, 0).toFixed(1)} kg`, `goal ${state.profile.goalWeight} kg`),
    statCardHTML('Days left', `${s.daysLeft}`, `by ${state.profile.goalDate}`),
    statCardHTML('Your pace', rateStr, reqStr, s.status),
    statCardHTML('Projected finish', s.projectedFinishDate || '—', s.projectedFinishDate ? 'at current trend' : 'log a few more weigh-ins')
  ].join('');
}

/* ---------- chart ---------- */

function renderChart() {
  const svg = document.getElementById('chart');
  const p = state.profile;
  const w = weighedEntries();
  const deficits = dailyDeficitEntries();

  const allDates = [p.startDate, p.goalDate, ...w.map(e => e.date), ...deficits.map(d => d.date)];
  const minDayIdx = Math.min(...allDates.map(d => daysBetween('1970-01-01', d)));
  const maxDayIdx = Math.max(...allDates.map(d => daysBetween('1970-01-01', d)));
  const dayRange = Math.max(maxDayIdx - minDayIdx, 1);

  const allWeights = [Number(p.startWeight), Number(p.goalWeight), ...w.map(e => Number(e.weight))];
  const minW = Math.min(...allWeights) - 2;
  const maxW = Math.max(...allWeights) + 2;
  const wRange = Math.max(maxW - minW, 1);

  const PAD = 10, RPAD = 46, W = 640, H = 220;
  const x = day => PAD + ((day - minDayIdx) / dayRange) * (W - PAD - RPAD);
  const y = weight => H - PAD - ((weight - minW) / wRange) * (H - 2 * PAD);

  const targetX1 = x(daysBetween('1970-01-01', p.startDate));
  const targetY1 = y(Number(p.startWeight));
  const targetX2 = x(daysBetween('1970-01-01', p.goalDate));
  const targetY2 = y(Number(p.goalWeight));

  let actualPath = '';
  let dots = '';
  w.forEach((e, i) => {
    const px = x(daysBetween('1970-01-01', e.date));
    const py = y(Number(e.weight));
    actualPath += (i === 0 ? 'M' : 'L') + px.toFixed(1) + ',' + py.toFixed(1) + ' ';
    dots += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.5" fill="var(--accent-2)"></circle>`;
  });

  // secondary (right) axis: calorie deficit, own scale so it fits the same plot area
  let deficitPath = '', deficitDots = '', zeroLine = '', axisLabels = '';
  if (deficits.length) {
    const values = deficits.map(d => d.deficit);
    const rawMin = Math.min(...values, 0);
    const rawMax = Math.max(...values, 0);
    const padAmt = Math.max((rawMax - rawMin) * 0.15, 100);
    const minD = rawMin - padAmt;
    const maxD = rawMax + padAmt;
    const dRange = Math.max(maxD - minD, 1);
    const y2 = val => H - PAD - ((val - minD) / dRange) * (H - 2 * PAD);

    deficits.forEach((d, i) => {
      const px = x(daysBetween('1970-01-01', d.date));
      const py = y2(d.deficit);
      deficitPath += (i === 0 ? 'M' : 'L') + px.toFixed(1) + ',' + py.toFixed(1) + ' ';
      deficitDots += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.5" fill="var(--warn)"></circle>`;
    });

    if (minD < 0 && maxD > 0) {
      const zy = y2(0).toFixed(1);
      zeroLine = `<line x1="${PAD}" y1="${zy}" x2="${W - RPAD}" y2="${zy}" stroke="var(--warn)" stroke-width="1" stroke-dasharray="2,3" opacity="0.5" />`;
    }
    axisLabels = `
      <text x="${W - RPAD + 6}" y="${(PAD + 4).toFixed(1)}" fill="var(--warn)" font-size="9">${Math.round(maxD)}</text>
      <text x="${W - RPAD + 6}" y="${(H - PAD).toFixed(1)}" fill="var(--warn)" font-size="9">${Math.round(minD)}</text>
      <text x="${W - RPAD + 6}" y="${(H / 2).toFixed(1)}" fill="var(--warn)" font-size="9">kcal</text>
    `;
  }

  svg.innerHTML = `
    <line x1="${targetX1.toFixed(1)}" y1="${targetY1.toFixed(1)}" x2="${targetX2.toFixed(1)}" y2="${targetY2.toFixed(1)}"
      stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="5,4" />
    ${actualPath ? `<path d="${actualPath}" fill="none" stroke="var(--accent-2)" stroke-width="2.5" />` : ''}
    ${dots}
    ${zeroLine}
    ${deficitPath ? `<path d="${deficitPath}" fill="none" stroke="var(--warn)" stroke-width="1.75" stroke-dasharray="1,2" />` : ''}
    ${deficitDots}
    ${axisLabels}
  `;
}

/* ---------- week summary ---------- */

function renderWeekSummary() {
  const wk = startOfWeek(todayISO());
  const thisWeek = state.entries.filter(e => e.date >= wk);
  const golf = thisWeek.filter(e => e.golf).length;
  const dogWalks = thisWeek.reduce((s, e) => s + Number(e.dogWalks || 0), 0);
  const pub = thisWeek.filter(e => e.pub).length;
  const football = thisWeek.filter(e => e.football).length;
  const drinks = thisWeek.reduce((s, e) => s + Number(e.drinks || 0), 0);
  const skippedBreakfast = thisWeek.filter(e => e.skippedBreakfast).length;
  const loggedCals = thisWeek.filter(e => e.calories != null);
  const avgCals = loggedCals.length
    ? Math.round(loggedCals.reduce((s, e) => s + Number(e.calories), 0) / loggedCals.length)
    : null;

  const rows = [
    ['Golf rounds', golf],
    ['Dog walks', dogWalks],
    ['Pub nights', `${pub} (${drinks} drinks)`],
    ['Football matches', football],
    ['Breakfasts skipped', skippedBreakfast],
    ['Avg calories logged', avgCals != null ? `${avgCals} kcal (${loggedCals.length}d)` : '—']
  ];
  document.getElementById('weekSummary').innerHTML =
    rows.map(([l, v]) => `<li><span>${l}</span><span>${v}</span></li>`).join('');
}

/* ---------- calorie guide ---------- */

function renderCalorieGuide() {
  const s = computeStats();
  const c = estimateCalories(s);
  const el = document.getElementById('calorieGuide');

  const wk = startOfWeek(todayISO());
  const loggedCals = state.entries.filter(e => e.date >= wk && e.calories != null);
  const avgCals = loggedCals.length
    ? Math.round(loggedCals.reduce((s2, e) => s2 + Number(e.calories), 0) / loggedCals.length)
    : null;
  const avgRow = avgCals != null
    ? `<div class="row"><span>This week's avg intake</span><span>${avgCals} kcal/day</span></div>`
    : `<div class="row"><span>This week's avg intake</span><span>not logged yet</span></div>`;

  const wDef = weeklyDeficitAvg();
  let deficitRow = `<div class="row"><span>This week's actual deficit</span><span>not logged yet</span></div>`;
  if (wDef) {
    const diff = wDef.avg - c.deficitPerDay;
    const diffLabel = diff >= 0 ? `+${Math.round(diff)} ahead` : `${Math.round(diff)} short`;
    const cls = diff >= -50 ? 'good' : (diff >= -300 ? 'warn' : 'bad');
    deficitRow = `<div class="row"><span>This week's actual deficit</span><span class="${cls}">${Math.round(wDef.avg)} kcal/day (${diffLabel}, ${wDef.count}d)</span></div>`;
  }

  el.innerHTML = `
    <div class="row"><span>Estimated maintenance</span><span>${Math.round(c.tdee)} kcal/day</span></div>
    <div class="row"><span>Target on plan days</span><span>${Math.round(c.target)} kcal/day</span></div>
    <div class="row"><span>Deficit needed</span><span>${Math.round(c.deficitPerDay)} kcal/day</span></div>
    ${avgRow}
    ${deficitRow}
    <div class="note">Estimate only (Mifflin-St Jeor). "Actual deficit" adjusts maintenance up on days you log golf, dog walks or a football match, so it reflects the calories you actually burned that day, not just intake.</div>
  `;
}

/* ---------- history table ---------- */

function foodTags(e) {
  const tags = (e.meals || []).map(m => `<span class="tag">${m}</span>`).join('');
  return tags + (e.skippedBreakfast ? '<span class="tag">no breakfast</span>' : '');
}

function renderHistory() {
  const body = document.getElementById('historyBody');
  const rows = sortedEntries().slice().reverse();
  body.innerHTML = rows.map(e => `
    <tr>
      <td>${e.date}</td>
      <td>${e.weight != null && e.weight !== '' ? Number(e.weight).toFixed(1) : '—'}</td>
      <td>${e.calories != null ? e.calories : '—'}</td>
      <td class="notes-cell">${foodTags(e)}</td>
      <td>${e.golf ? '✓' : ''}</td>
      <td>${e.dogWalks || 0}</td>
      <td>${e.pub ? `✓ (${e.drinks || 0})` : ''}</td>
      <td>${e.football ? (e.trip ? '✓ (trip)' : '✓') : ''}</td>
      <td class="notes-cell">${e.notes ? e.notes.replace(/</g, '&lt;') : ''}</td>
      <td><button class="row-del" data-id="${e.id}" title="Delete">✕</button></td>
    </tr>
  `).join('');

  body.querySelectorAll('.row-del').forEach(btn => {
    btn.addEventListener('click', () => {
      state.entries = state.entries.filter(e => e.id !== btn.dataset.id);
      saveState();
      renderAll();
    });
  });
}

/* ---------- render orchestrator ---------- */

function renderAll() {
  renderStats();
  renderChart();
  renderWeekSummary();
  renderCalorieGuide();
  renderHistory();
}

/* ---------- form handling ---------- */

function fillProfileForm() {
  const p = state.profile;
  document.getElementById('p-height').value = p.heightCm;
  document.getElementById('p-age').value = p.age;
  document.getElementById('p-startDate').value = p.startDate;
  document.getElementById('p-startWeight').value = p.startWeight;
  document.getElementById('p-goalDate').value = p.goalDate;
  document.getElementById('p-goalWeight').value = p.goalWeight;
}

function initLogForm() {
  document.getElementById('f-date').value = todayISO();
  document.getElementById('logDateHint').textContent = 'defaults to today';
}

function readLogForm() {
  const meals = Array.from(document.querySelectorAll('#mealChips input:checked')).map(c => c.value);
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
    date: document.getElementById('f-date').value || todayISO(),
    weight: document.getElementById('f-weight').value || null,
    skippedBreakfast: document.getElementById('f-skippedBreakfast').checked,
    meals,
    calories: document.getElementById('f-calories').value ? Number(document.getElementById('f-calories').value) : null,
    golf: document.getElementById('f-golf').checked,
    dogWalks: Number(document.getElementById('f-dogwalks').value),
    pub: document.getElementById('f-pub').checked,
    drinks: Number(document.getElementById('f-drinks').value || 0),
    football: document.getElementById('f-football').checked,
    trip: document.getElementById('f-trip').checked,
    notes: document.getElementById('f-notes').value.trim()
  };
}

function resetLogForm() {
  document.getElementById('logForm').reset();
  document.getElementById('f-date').value = todayISO();
  document.getElementById('f-skippedBreakfast').checked = true;
  document.getElementById('f-dogwalks').value = '2';
}

/* ---------- events ---------- */

document.getElementById('logForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const entry = readLogForm();
  // replace existing entry for same date if present
  state.entries = state.entries.filter(e => e.date !== entry.date);
  state.entries.push(entry);
  saveState();
  resetLogForm();
  renderAll();
});

document.getElementById('clearFormBtn').addEventListener('click', resetLogForm);

document.getElementById('profileForm').addEventListener('submit', ev => {
  ev.preventDefault();
  state.profile = {
    heightCm: Number(document.getElementById('p-height').value),
    age: Number(document.getElementById('p-age').value),
    startDate: document.getElementById('p-startDate').value,
    startWeight: Number(document.getElementById('p-startWeight').value),
    goalDate: document.getElementById('p-goalDate').value,
    goalWeight: Number(document.getElementById('p-goalWeight').value)
  };
  saveState();
  renderAll();
});

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `winter-diet-tracker-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', ev => {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      state = {
        profile: { ...DEFAULT_PROFILE, ...(parsed.profile || {}) },
        entries: Array.isArray(parsed.entries) ? parsed.entries : []
      };
      saveState();
      fillProfileForm();
      renderAll();
    } catch (e) {
      alert('Could not read that file: ' + e.message);
    }
  };
  reader.readAsText(file);
  ev.target.value = '';
});

document.getElementById('resetBtn').addEventListener('click', () => {
  if (!confirm('This clears all logged entries and profile settings. Continue?')) return;
  state = { profile: { ...DEFAULT_PROFILE }, entries: [] };
  saveState();
  fillProfileForm();
  resetLogForm();
  renderAll();
});

/* ---------- init ---------- */

fillProfileForm();
initLogForm();
renderAll();
