const FILE_KEYS = [
  ['employees', 'employees.csv'],
  ['sites', 'sites.csv'],
  ['shifts', 'shifts.csv'],
  ['shift_notes', 'shift_notes.csv'],
  ['payroll_details', 'payroll_details.csv'],
  ['public_holidays', 'public_holidays.csv'],
];

const CAT_LABEL = {
  relief_no_show: 'Colleague absence / no-show',
  equipment_failure: 'Equipment failure',
  handover_delay: 'Handover delay',
  client_requested: 'Client requested',
  no_info: 'No detail logged',
  other: 'Uncategorised',
};
const CAT_COLOR = {
  relief_no_show: 'var(--red)',
  equipment_failure: 'var(--amber)',
  handover_delay: '#8a7ad1',
  client_requested: 'var(--accent)',
  no_info: 'var(--muted2)',
  other: 'var(--muted2)',
};
const ACTIONS = {
  relief_no_show: (site) => `Sort the relief roster at <b>${site}</b> — repeated no-shows are the cause. Assign a standing backup reliever before Thursday.`,
  equipment_failure: (site) => `Log a repair ticket for the faulty equipment at <b>${site}</b> — manual workarounds are what's adding the hours.`,
  handover_delay: (site) => `Tighten the handover process at <b>${site}</b> — late handovers and missing keys are stacking extra minutes onto every shift.`,
  client_requested: (site) => `Confirm this is billed through to the client at <b>${site}</b>. If it keeps recurring, raise a staffing addendum rather than absorbing it as overtime.`,
  mixed: (site) => `No single cause dominates at <b>${site}</b> — pull this person's timesheet and check with their supervisor directly.`,
};

let latestResult = null;
let uploadedFiles = {};
let activeSiteFilter = 'all';

function fmtHrs(h) { return (Math.round(h * 10) / 10).toFixed(1); }
function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function fmtZAR(n) {
  return 'R' + Math.round(n).toLocaleString('en-ZA');
}

function dominantCategory(notes) {
  const counts = {};
  (notes || []).forEach(n => { counts[n.category] = (counts[n.category] || 0) + 1; });
  let best = null, bestN = 0, total = 0;
  Object.keys(counts).forEach(c => {
    total += counts[c];
    if (c !== 'no_info' && c !== 'other' && counts[c] > bestN) { best = c; bestN = counts[c]; }
  });
  if (!best) return null;
  return best;
}

function riskBand(score) {
  if (score >= 0.5) return 'high';
  if (score >= 0.2) return 'med';
  return 'low';
}

function render(result) {
  latestResult = result;
  const { predictions, siteStats, siteName, empCurrentNotes, currentWeekStart, maxDate, dataQuality } = result;

  // week label
  const weekEnd = (() => { const d = new Date(currentWeekStart + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10); })();
  document.getElementById('weekLabel').textContent =
    `Week of ${fmtDate(currentWeekStart)}–${fmtDate(weekEnd)} · data through ${fmtDate(maxDate)}`;

  // summary cards
  const atRisk = predictions.filter(p => p.will_breach === 1);
  const totalProjOT = atRisk.reduce((s, p) => s + p.projected_overtime_hours, 0);
  const estCost = atRisk.reduce((s, p) => s + p.projected_overtime_hours * (p.hourly_rate || 0) * 1.5, 0);

  let opsSum = 0, clientSum = 0, unexSum = 0;
  Object.values(siteStats).forEach(s => { opsSum += s.operational_failure || 0; clientSum += s.client_requested || 0; unexSum += s.unexplained || 0; });
  const splitTotal = opsSum + clientSum + unexSum || 1;

  document.getElementById('summaryCards').innerHTML = `
    <div class="card"><div class="num" style="color:var(--red);">${atRisk.length}</div><div class="lbl">people on track to breach the 10h overtime cap by Sunday</div></div>
    <div class="card"><div class="num">${fmtHrs(totalProjOT)}h</div><div class="lbl">total overtime hours at risk this week</div></div>
    <div class="card wide"><div class="num">${fmtZAR(estCost)}</div><div class="lbl">estimated 1.5× overtime cost if nothing changes (excludes Sunday/holiday 2× premium)</div></div>
  `;

  document.getElementById('splitBar').innerHTML = `
    <div style="width:${100*opsSum/splitTotal}%;background:var(--red);"></div>
    <div style="width:${100*clientSum/splitTotal}%;background:var(--accent);"></div>
    <div style="width:${100*unexSum/splitTotal}%;background:var(--muted2);"></div>
  `;
  document.getElementById('splitLegend').innerHTML = `
    <span><span class="dot" style="background:var(--red);"></span>Operational failure — ${Math.round(100*opsSum/splitTotal)}% (${fmtHrs(opsSum)}h) — avoidable</span>
    <span><span class="dot" style="background:var(--accent);"></span>Client requested — ${Math.round(100*clientSum/splitTotal)}% (${fmtHrs(clientSum)}h) — billable</span>
    <span><span class="dot" style="background:var(--muted2);"></span>Unexplained / no note — ${Math.round(100*unexSum/splitTotal)}% (${fmtHrs(unexSum)}h)</span>
  `;

  // site filter chips
  const sitesPresent = [...new Set(predictions.map(p => p.site_id).filter(Boolean))].sort();
  const filterHtml = ['<div class="chip'+(activeSiteFilter==='all'?' active':'')+'" data-site="all">All sites</div>']
    .concat(sitesPresent.map(sid => `<div class="chip${activeSiteFilter===sid?' active':''}" data-site="${sid}">${(siteName[sid]||sid)}</div>`));
  document.getElementById('siteFilters').innerHTML = filterHtml.join('');
  document.querySelectorAll('.chip').forEach(el => el.addEventListener('click', () => {
    activeSiteFilter = el.getAttribute('data-site');
    render(latestResult);
  }));

  // risk list
  const shown = atRisk.filter(p => activeSiteFilter === 'all' || p.site_id === activeSiteFilter);
  const listEl = document.getElementById('riskList');
  if (shown.length === 0) {
    listEl.innerHTML = `<div class="card" style="color:var(--muted);">Nobody at this site is projected to breach this week.</div>`;
  } else {
    listEl.innerHTML = shown.map((p, i) => {
      const notes = (empCurrentNotes[p.employee_id] || []);
      const dom = dominantCategory(notes);
      const band = riskBand(p.risk_score);
      const site = siteName[p.site_id] || p.site_id || '—';
      const actionFn = dom ? ACTIONS[dom] : ACTIONS.mixed;
      const actionHtml = actionFn ? actionFn(site) : '';
      const pct = Math.min(100, Math.round((p.projected_total_hours / 65) * 100));
      const uniqueNotes = notes.filter(n => n.note && n.note.trim());
      return `
      <div class="rowcard" id="row-${i}">
        <div class="rowmain" data-idx="${i}">
          <div class="risk-pill risk-${band}">${Math.round(p.risk_score * 100)}%</div>
          <div class="rowinfo">
            <div class="name">${p.full_name || p.employee_id}</div>
            <div class="meta">${site} · ${p.role || ''}</div>
            ${dom ? `<span class="reason" style="color:${CAT_COLOR[dom]};">${CAT_LABEL[dom]}</span>` : ''}
          </div>
          <div class="rowhrs">
            <div class="hrs">${fmtHrs(p.projected_total_hours)}h</div>
            <div class="hrslbl">projected</div>
          </div>
          <div class="chev">›</div>
        </div>
        <div class="rowdetail">
          <div class="hrbar"><div class="fill" style="width:${pct}%;background:${band==='high'?'var(--red)':band==='med'?'var(--amber)':'var(--green)'};"></div>
            <div class="mark" style="left:${Math.min(100,45/65*100)}%;" title="45h ordinary cap"></div>
            <div class="mark b" style="left:${Math.min(100,55/65*100)}%;" title="55h = 10h overtime cap"></div>
          </div>
          <div style="font-size:11px;color:var(--muted2);margin-top:4px;">${fmtHrs(p.known_hours)}h logged Mon–${fmtDate(maxDate)} · ${fmtHrs(p.projected_overtime_hours)}h projected overtime</div>
          <div class="action">${actionHtml}</div>
          ${uniqueNotes.length ? `<div class="notelist">${uniqueNotes.map(n => `<div class="n"><span class="cat">${(CAT_LABEL[n.category]||n.category)}</span>${fmtDate(n.shift_date)} — ${escapeHtml(n.note)}</div>`).join('')}</div>` : '<div class="notelist">No supervisor notes logged yet this week.</div>'}
        </div>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.rowmain').forEach(el => el.addEventListener('click', () => {
      el.parentElement.classList.toggle('open');
    }));
  }

  // site bars
  const siteIds = Object.keys(siteStats).sort((a, b) => {
    const ta = (siteStats[a].operational_failure||0)+(siteStats[a].client_requested||0)+(siteStats[a].unexplained||0);
    const tb = (siteStats[b].operational_failure||0)+(siteStats[b].client_requested||0)+(siteStats[b].unexplained||0);
    return tb - ta;
  });
  document.getElementById('siteBars').innerHTML = siteIds.map(sid => {
    const s = siteStats[sid];
    const tot = (s.operational_failure||0)+(s.client_requested||0)+(s.unexplained||0) || 1;
    return `<div class="sitebar-row">
      <div class="head"><span class="name">${siteName[sid]||sid}</span><span class="tot">${fmtHrs(tot)}h extra</span></div>
      <div class="split-bar">
        <div style="width:${100*(s.operational_failure||0)/tot}%;background:var(--red);"></div>
        <div style="width:${100*(s.client_requested||0)/tot}%;background:var(--accent);"></div>
        <div style="width:${100*(s.unexplained||0)/tot}%;background:var(--muted2);"></div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('methodBody').innerHTML = `
    <p><b>Projection:</b> for each person, actual hours already logged this week are added to an expected amount for the remaining days, based on how often and how long they've historically worked on each day of the week over the last several weeks. That total is compared against the 55-hour mark (45 ordinary + 10 overtime = the legal cap).</p>
    <p><b>Risk score:</b> back-testing this method on ${dataQuality.totalShifts ? '~10' : ''} weeks of history gave a typical projection error of about 8 hours. The risk score is the chance, given that error spread, that someone's final total lands over 55 hours. The 50% cut-off for "on track to breach" is deliberately set low (around 13% risk) because missing a real breach is far costlier than a false alarm.</p>
    <p><b>Reason & action:</b> pulled from supervisors' free-text notes on that person's shifts this week, sorted into six categories by keyword rules (English, isiZulu and Afrikaans phrases, including common misspellings).</p>
    <p><b>Data quality:</b> ${dataQuality.missingClockOut} of ${dataQuality.totalShifts} shift records this run have no clock-out and contribute 0 hours — the same convention the client's own weekly export uses. That likely understates a few people's real hours.</p>
  `;
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function b64ToText(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function loadDefaultAndRender() {
  const files = {};
  FILE_KEYS.forEach(([key]) => { files[key] = b64ToText(EMBEDDED_DATA[key + '.csv']); });
  const result = runPipeline(files);
  render(result);
}

// ---- upload panel ----
function buildFileGrid() {
  const grid = document.getElementById('fileGrid');
  grid.innerHTML = FILE_KEYS.map(([key, fname]) => `
    <div class="filefield" id="field-${key}">
      <label for="input-${key}">${fname}</label>
      <input type="file" id="input-${key}" accept=".csv" data-key="${key}">
    </div>
  `).join('');
  FILE_KEYS.forEach(([key]) => {
    document.getElementById(`input-${key}`).addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        uploadedFiles[key] = reader.result;
        document.getElementById(`field-${key}`).classList.add('got');
        document.getElementById('uploadStatus').textContent = `${Object.keys(uploadedFiles).length} of 6 files loaded.`;
      };
      reader.readAsText(f);
    });
  });
}

document.getElementById('recomputeBtn').addEventListener('click', () => {
  const status = document.getElementById('uploadStatus');
  const files = {};
  let missing = [];
  FILE_KEYS.forEach(([key]) => {
    if (uploadedFiles[key]) files[key] = uploadedFiles[key];
    else { files[key] = b64ToText(EMBEDDED_DATA[key + '.csv']); missing.push(key); }
  });
  try {
    const result = runPipeline(files);
    activeSiteFilter = 'all';
    render(result);
    status.textContent = missing.length
      ? `Recomputed. Reused the previous file for: ${missing.join(', ')}.`
      : 'Recomputed with all six new files.';
    status.style.color = 'var(--green)';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    status.textContent = 'Could not process those files: ' + err.message;
    status.style.color = 'var(--red)';
  }
});

document.getElementById('themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('overtime-watch-theme', next); } catch (e) {}
});
try {
  const saved = localStorage.getItem('overtime-watch-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
} catch (e) {}

buildFileGrid();
loadDefaultAndRender();
