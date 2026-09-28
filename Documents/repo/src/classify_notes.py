import pandas as pd, re

notes = pd.read_csv('/mnt/user-data/uploads/shift_notes.csv')

def norm(s):
    if pd.isna(s): return ''
    return str(s).lower()

# Keyword patterns (English + isiZulu + Afrikaans + common typos), checked with regex `re.search`
PATTERNS = {
    # colleague absence / no-show that this employee had to cover for -- an operational failure
    'relief_no_show': [
        r'no show', r'no[- ]call', r'never pitch', r'never came', r'did.?n.?t (come|pitch|show)',
        r'did not (come|pitch|show)', r'no replacement sent', r'no relief\b', r'relief coming,? nobody came',
        r'relief was suppose', r'relief only arrived', r'waited for relief', r'nobody came',
        r'sort the roster', r'akafikanga',  # isiZulu: didn't arrive
        r'ngicela sort',  # isiZulu: please sort this out (relief context)
        r'aflos het nie opgedaag',  # afrikaans: relief did not show up
        r'\babsent\b', r'off sick', r'\bsick\b', r'\bsiek\b',  # afrikaans sick
        r'akezanga.*ngimele',  # isiZulu: "didn't come, I'm covering/taking their place"
        r'took (her|his|their) rounds', r'covering .*(post|shift|for)', r'coering', r'coverin',
        r'relief (never|no)', r'family responsibility leave', r'\bclinic\b',
        r'took .*shift as well', r'2 posts 1 guard', r'double du?ty', r'stood in for',
        r'booked off', r'covered for',
    ],
    # broken equipment forcing manual/slower work -- an operational failure
    'equipment_failure': [
        r'gate motor', r'\bmachine\b', r'machien', r'\bmacine\b', r'scrubber', r'generator fault',
        r'\bfault\b', r'broke(n)? down', r'stukkend', r'manned it by hand', r'manually', r'by hand',
        r'lift out of order', r'out of order',
    ],
    # handover process delays -- an operational failure
    'handover_delay': [
        r'handover', r'oorhandiging', r'\bkeys?\b.*(missing|waiting)?', r'sleutels', r'ob book',
        r'waited .*(handover|key|paperwork)', r'waiting on paperwork', r'gewag',
    ],
    # client / centre-management requested and approved extra work -- billable, not an ops failure
    'client_requested': [
        r'client (asked|wanted|signed|requested)', r'centre (mgmt|mgr|manager|management)',
        r'approved', r'signed off', r'stocktake', r'\baudit\b', r'deep clean', r'\bsetup\b',
        r'\bevent\b', r'extra patrol', r'load[- ]in', r'\bdelivery\b', r'gevra', r'gemeld', r'gedek',
        r'ok.?d by', r'requested by',
    ],
    # nothing informative
    'no_info': [
        r'^ok$', r'^all good$', r'^fine$', r'^all fine$', r'quiet shift', r'^quiet$', r'^n/?a$', r'^-+$',
        r'^\.+$', r'^\s*$', r'as per normal', r'^sharp$', r'\bntr\b', r'nothing to report',
        r'no incidents', r'no issues on site', r'akukho lutho',  # isiZulu: there's nothing
        r'niks om te rapporteer',  # afrikaans: nothing to report
    ],
}

# Overrides: supervisor logs it as client-approved, but note reveals the *real* driver was an ops failure.
OVERRIDE_RE = re.compile(r'real reason|but real|actual reason')

def classify(raw):
    t = norm(raw)
    if t.strip() == '' :
        return 'no_info'
    if OVERRIDE_RE.search(t):
        # find which failure category the "real reason" clause names
        for cat in ['relief_no_show','equipment_failure','handover_delay']:
            for pat in PATTERNS[cat]:
                if re.search(pat, t):
                    return cat
    # priority order: ops-failure categories first (more specific/actionable),
    # then client_requested, then no_info/other
    for cat in ['relief_no_show','equipment_failure','handover_delay','client_requested','no_info']:
        for pat in PATTERNS[cat]:
            if re.search(pat, t):
                return cat
    return 'other'

notes['category'] = notes['note'].apply(classify)

# --- fuzzy fallback pass for the residual 'other' bucket (heavy typos the keyword rules miss) ---
import difflib
ANCHORS = {
    'relief_no_show': [
        'no show no call', 'never pitched', 'did not come in covered the post', 'off sick again covered',
        'control room says relief coming nobody came', 'relief only arrived stayed until then',
        'still on site relief was suppose to come', 'akezanga namhlanje ngimele yena',
        'aflos het nie opgedaag nie moes aanbly', 'covered for again third time this month',
        'absent took her rounds as well', 'stood in for', 'double duty family responsibility leave',
    ],
    'equipment_failure': [
        'gate motor failed manned it by hand', 'machine down took twice as long',
        'masjien is stukkend alles met die hand gedoen', 'generator fault stayed to monitor',
        'lift out of order everything carried up stairs',
    ],
    'handover_delay': ['shift handover delayed', 'oorhandiging was laat gewag vir sleutels'],
    'client_requested': ['client says stay dont know if office approved'],
    'no_info': ['all quiet', 'quiet shift', 'nothing to report'],
}

def fuzzy_classify(raw):
    t = norm(raw)
    if not t.strip():
        return 'no_info'
    best_cat, best_score = 'other', 0.72  # minimum similarity threshold
    for cat, anchors in ANCHORS.items():
        for a in anchors:
            score = difflib.SequenceMatcher(None, t, a).ratio()
            if score > best_score:
                best_score, best_cat = score, cat
    return best_cat

mask_other = notes['category']=='other'
notes.loc[mask_other, 'category'] = notes.loc[mask_other, 'note'].apply(fuzzy_classify)

print(notes['category'].value_counts())
out = notes[['shift_id','category','note']]
out.to_csv('note_classifications.csv', index=False)
print(out.head(10))
