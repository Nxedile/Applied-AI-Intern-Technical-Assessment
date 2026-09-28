const { parseCSV, toMin, dateToWeekday, mondayOf, classifyNote, OPS_FAILURE } = require('./pipeline.js');

const SIGMA = 8.0075;      // residual std from backtesting the projection model
const RISK_THRESHOLD = 0.13; // tuned on backtest for ~70% recall on breaches

function normCdf(x) {
  // Abramowitz-Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

function runPipeline(files) {
  // files: {employees, sites, shifts, shift_notes, payroll_details, public_holidays} raw CSV text
  const employees = parseCSV(files.employees || '');
  const sites = parseCSV(files.sites || '');
  const payroll = parseCSV(files.payroll_details || '');
  const shiftsRaw = parseCSV(files.shifts || '');
  const notesRaw = parseCSV(files.shift_notes || '');

  const siteName = {};
  sites.forEach(s => siteName[s.site_id] = s.site_name);
  const empMeta = {};
  employees.forEach(e => empMeta[e.employee_id] = e);
  const rateMap = {};
  payroll.forEach(p => rateMap[p.employee_id] = parseFloat(p.hourly_rate) || 0);

  // ---- shifts: durations, weekday, week_start ----
  const shifts = shiftsRaw.map(s => {
    const inM = toMin(s.clock_in_time), outM = toMin(s.clock_out_time);
    let dur = NaN;
    if (!isNaN(inM) && !isNaN(outM)) {
      let d = outM - inM;
      if (d < 0) d += 24 * 60;
      dur = d / 60;
    }
    return {
      shift_id: s.shift_id, employee_id: s.employee_id, site_id: s.site_id,
      shift_date: s.shift_date, duration_hr: dur,
      weekday: dateToWeekday(s.shift_date), week_start: mondayOf(s.shift_date),
    };
  });

  let maxDate = shifts.reduce((m, s) => s.shift_date > m ? s.shift_date : m, shifts[0].shift_date);
  const currentWeekStart = mondayOf(maxDate);
  const knownThroughWeekday = dateToWeekday(maxDate);

  const allEmpIds = employees.map(e => e.employee_id);

  const hist = shifts.filter(s => s.week_start < currentWeekStart && !isNaN(s.duration_hr));
  const curWeek = shifts.filter(s => s.week_start === currentWeekStart);

  // count distinct historical weeks
  const histWeeksSet = new Set(shifts.filter(s => s.week_start < currentWeekStart).map(s => s.week_start));
  const nHistWeeks = histWeeksSet.size || 1;

  // per employee+weekday: list of durations (for median) and count (for frequency)
  const key = (e, wd) => e + '|' + wd;
  const histByKey = {};
  hist.forEach(s => {
    const k = key(s.employee_id, s.weekday);
    (histByKey[k] = histByKey[k] || []).push(s.duration_hr);
  });
  function median(arr) {
    const a = [...arr].sort((x, y) => x - y);
    const n = a.length;
    if (n === 0) return 0;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }
  const expectedHrMap = {};
  Object.keys(histByKey).forEach(k => {
    const arr = histByKey[k];
    const freq = arr.length / nHistWeeks;
    expectedHrMap[k] = median(arr) * freq;
  });

  const knownHours = {};
  curWeek.filter(s => s.weekday <= knownThroughWeekday && !isNaN(s.duration_hr)).forEach(s => {
    knownHours[s.employee_id] = (knownHours[s.employee_id] || 0) + s.duration_hr;
  });

  const predictions = allEmpIds.map(emp => {
    let proj = knownHours[emp] || 0;
    for (let wd = knownThroughWeekday + 1; wd <= 6; wd++) {
      proj += expectedHrMap[key(emp, wd)] || 0;
    }
    const ot = Math.max(0, proj - 45);
    const risk = 1 - normCdf((55 - proj) / SIGMA);
    return {
      employee_id: emp,
      will_breach: risk >= RISK_THRESHOLD ? 1 : 0,
      risk_score: Math.round(risk * 1000) / 1000,
      known_hours: Math.round((knownHours[emp] || 0) * 100) / 100,
      projected_total_hours: Math.round(proj * 100) / 100,
      projected_overtime_hours: Math.round(ot * 100) / 100,
      site_id: (empMeta[emp] || {}).primary_site_id,
      full_name: (empMeta[emp] || {}).full_name,
      role: (empMeta[emp] || {}).role,
      hourly_rate: rateMap[emp] || 0,
    };
  });
  predictions.sort((a, b) => b.risk_score - a.risk_score);

  // ---- note classification ----
  const noteClassifications = notesRaw.map(n => ({
    shift_id: n.shift_id, category: classifyNote(n.note), note: n.note,
  }));
  const catByShift = {};
  noteClassifications.forEach(n => catByShift[n.shift_id] = n.category);

  // ---- excess-hours split (client_requested vs operational_failure) ----
  const shiftsWithCat = shifts.map(s => ({ ...s, category: catByShift[s.shift_id] || 'no_note' }));
  // baseline = median duration on no-note/no-info shifts per employee (fallback overall median)
  const baselinePool = {}, allPool = {};
  shiftsWithCat.forEach(s => {
    if (isNaN(s.duration_hr)) return;
    (allPool[s.employee_id] = allPool[s.employee_id] || []).push(s.duration_hr);
    if (s.category === 'no_note' || s.category === 'no_info') {
      (baselinePool[s.employee_id] = baselinePool[s.employee_id] || []).push(s.duration_hr);
    }
  });
  const baselineHr = {};
  allEmpIds.forEach(e => {
    baselineHr[e] = baselinePool[e] ? median(baselinePool[e]) : (allPool[e] ? median(allPool[e]) : 9.5);
  });

  const siteStats = {}; // site_id -> {operational_failure, client_requested, unexplained}
  shiftsWithCat.forEach(s => {
    if (isNaN(s.duration_hr)) return;
    const excess = Math.max(0, s.duration_hr - baselineHr[s.employee_id]);
    let bucket = null;
    if (OPS_FAILURE.has(s.category)) bucket = 'operational_failure';
    else if (s.category === 'client_requested') bucket = 'client_requested';
    else if (s.category === 'other' || s.category === 'no_info') bucket = 'unexplained';
    if (!bucket) return;
    const sid = s.site_id;
    siteStats[sid] = siteStats[sid] || { operational_failure: 0, client_requested: 0, unexplained: 0 };
    siteStats[sid][bucket] += excess;
    siteStats[sid][s.category] = (siteStats[sid][s.category] || 0) + excess;
  });

  // ---- per at-risk employee: dominant reason this current week + recent notes ----
  const empCurrentNotes = {};
  curWeek.forEach(s => {
    const cat = catByShift[s.shift_id];
    if (!cat) return;
    (empCurrentNotes[s.employee_id] = empCurrentNotes[s.employee_id] || []).push({
      shift_date: s.shift_date, category: cat, note: (notesRaw.find(n => n.shift_id === s.shift_id) || {}).note,
    });
  });

  return {
    currentWeekStart, maxDate, knownThroughWeekday,
    predictions, noteClassifications, siteStats, empCurrentNotes,
    siteName, dataQuality: {
      totalShifts: shifts.length,
      missingClockOut: shifts.filter(s => isNaN(s.duration_hr)).length,
    },
  };
}

module.exports = { runPipeline };
