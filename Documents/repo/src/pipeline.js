// ---- Core CSV parsing ----
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/\r\n/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length === 1 && rows[r][0] === '') continue;
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = rows[r][c] !== undefined ? rows[r][c] : '';
    out.push(obj);
  }
  return out;
}

function toMin(t) {
  if (!t) return NaN;
  const parts = t.split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function dateToWeekday(dstr) {
  // Monday=0..Sunday=6
  const d = new Date(dstr + 'T00:00:00Z');
  const jsDay = d.getUTCDay(); // Sun=0..Sat=6
  return (jsDay + 6) % 7;
}

function mondayOf(dstr) {
  const d = new Date(dstr + 'T00:00:00Z');
  const wd = dateToWeekday(dstr);
  d.setUTCDate(d.getUTCDate() - wd);
  return d.toISOString().slice(0, 10);
}

function addDaysISO(dstr, n) {
  const d = new Date(dstr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---- Note classification (mirrors the Python rule-based classifier) ----
const PATTERNS = {
  relief_no_show: [
    /no show/, /no[- ]call/, /never pitch/, /never came/, /did.?n.?t (come|pitch|show)/,
    /did not (come|pitch|show)/, /no replacement sent/, /no relief\b/, /relief coming,? nobody came/,
    /relief was suppose/, /relief only arrived/, /waited for relief/, /nobody came/,
    /sort the roster/, /akafikanga/, /ngicela sort/, /aflos het nie opgedaag/,
    /\babsent\b/, /off sick/, /\bsick\b/, /\bsiek\b/,
    /akezanga.*ngimele/,
    /took (her|his|their) rounds/, /covering .*(post|shift|for)/, /coering/, /coverin/,
    /relief (never|no)/, /family responsibility leave/, /\bclinic\b/,
    /took .*shift as well/, /2 posts 1 guard/, /double du?ty/, /stood in for/,
    /booked off/, /covered for/,
  ],
  equipment_failure: [
    /gate motor/, /\bmachine\b/, /machien/, /\bmacine\b/, /scrubber/, /generator fault/,
    /\bfault\b/, /broke(n)? down/, /stukkend/, /manned it by hand/, /manually/, /by hand/,
    /lift out of order/, /out of order/,
  ],
  handover_delay: [
    /handover/, /oorhandiging/, /sleutels/, /ob book/,
    /waited .*(handover|key|paperwork)/, /waiting on paperwork/, /gewag/,
  ],
  client_requested: [
    /client (asked|wanted|signed|requested)/, /centre (mgmt|mgr|manager|management)/,
    /approved/, /signed off/, /stocktake/, /\baudit\b/, /deep clean/, /\bsetup\b/,
    /\bevent\b/, /extra patrol/, /load[- ]in/, /\bdelivery\b/, /gevra/, /gemeld/, /gedek/,
    /ok.?d by/, /requested by/,
  ],
  no_info: [
    /^ok$/, /^all good$/, /^fine$/, /^all fine$/, /quiet shift/, /^quiet$/, /^n\/?a$/, /^-+$/,
    /^\.+$/, /^\s*$/, /as per normal/, /^sharp$/, /\bntr\b/, /nothing to report/,
    /no incidents/, /no issues on site/, /akukho lutho/, /niks om te rapporteer/,
  ],
};
const CATEGORY_ORDER = ['relief_no_show', 'equipment_failure', 'handover_delay', 'client_requested', 'no_info'];
const OVERRIDE_RE = /real reason|but real|actual reason/;

const ANCHORS = {
  relief_no_show: [
    'no show no call', 'never pitched', 'did not come in covered the post', 'off sick again covered',
    'control room says relief coming nobody came', 'relief only arrived stayed until then',
    'still on site relief was suppose to come', 'akezanga namhlanje ngimele yena',
    'aflos het nie opgedaag nie moes aanbly', 'covered for again third time this month',
    'absent took her rounds as well', 'stood in for', 'double duty family responsibility leave',
  ],
  equipment_failure: [
    'gate motor failed manned it by hand', 'machine down took twice as long',
    'masjien is stukkend alles met die hand gedoen', 'generator fault stayed to monitor',
    'lift out of order everything carried up stairs',
  ],
  handover_delay: ['shift handover delayed', 'oorhandiging was laat gewag vir sleutels'],
  client_requested: ['client says stay dont know if office approved'],
  no_info: ['all quiet', 'quiet shift', 'nothing to report'],
};

// crude Levenshtein-ratio (mirrors difflib-style similarity closely enough for this use)
function similarity(a, b) {
  const m = a.length, n = b.length;
  if (m === 0 && n === 0) return 1;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i-1] === b[j-1] ? prev : 1 + Math.min(prev, dp[j], dp[j-1]);
      prev = tmp;
    }
  }
  const dist = dp[n];
  return 1 - dist / Math.max(m, n, 1);
}

function classifyNote(raw) {
  const t = (raw || '').toLowerCase().trim();
  if (t === '') return 'no_info';
  if (OVERRIDE_RE.test(t)) {
    for (const cat of ['relief_no_show', 'equipment_failure', 'handover_delay']) {
      for (const pat of PATTERNS[cat]) if (pat.test(t)) return cat;
    }
  }
  for (const cat of CATEGORY_ORDER) {
    for (const pat of PATTERNS[cat]) if (pat.test(t)) return cat;
  }
  // fuzzy fallback
  let bestCat = 'other', bestScore = 0.72;
  for (const cat of Object.keys(ANCHORS)) {
    for (const anchor of ANCHORS[cat]) {
      const s = similarity(t, anchor);
      if (s > bestScore) { bestScore = s; bestCat = cat; }
    }
  }
  return bestCat;
}

const OPS_FAILURE = new Set(['relief_no_show', 'equipment_failure', 'handover_delay']);

module.exports = { parseCSV, toMin, dateToWeekday, mondayOf, addDaysISO, classifyNote, OPS_FAILURE };
