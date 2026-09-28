import pandas as pd, numpy as np

shifts = pd.read_csv('/mnt/user-data/uploads/shifts.csv', dtype=str)
shifts['shift_date'] = pd.to_datetime(shifts['shift_date'])

def to_min(t):
    if pd.isna(t): return np.nan
    h,m = t.split(':')
    return int(h)*60+int(m)

shifts['in_min'] = shifts['clock_in_time'].apply(to_min)
shifts['out_min'] = shifts['clock_out_time'].apply(to_min)
dur = shifts['out_min'] - shifts['in_min']
dur[dur<0] += 24*60
shifts['duration_hr'] = dur/60  # NaN if clock_out missing -> matches client system (0 contribution)
shifts['weekday'] = shifts['shift_date'].dt.weekday  # 0=Mon
shifts['week_start'] = shifts['shift_date'] - pd.to_timedelta(shifts['weekday'], unit='D')

MAX_DATE = shifts['shift_date'].max()
print("max date", MAX_DATE, MAX_DATE.strftime('%A'))
CURRENT_WEEK_START = MAX_DATE - pd.to_timedelta(MAX_DATE.weekday(), unit='D')
print("current week start", CURRENT_WEEK_START)

all_weeks = sorted(shifts['week_start'].unique())
print("all weeks:", [pd.Timestamp(w).strftime('%Y-%m-%d') for w in all_weeks])
complete_weeks = [w for w in all_weeks if w < CURRENT_WEEK_START]
print(len(complete_weeks), "complete weeks")

employees = pd.read_csv('/mnt/user-data/uploads/employees.csv')
all_emp_ids = employees['employee_id'].tolist()

def weekday_profile(hist_shifts):
    # median duration per employee per weekday (0=Mon..6=Sun), only over days actually worked
    prof = hist_shifts.groupby(['employee_id','weekday'])['duration_hr'].median().reset_index()
    return prof

def project_week(target_week_start, hist_shifts_excl_target, actual_shifts_in_week, known_through_weekday):
    # known_through_weekday inclusive, e.g. 2 = Mon,Tue,Wed known (0,1,2)
    prof = weekday_profile(hist_shifts_excl_target)
    prof_map = {(r.employee_id, r.weekday): r.duration_hr for r in prof.itertuples()}
    actual_known = actual_shifts_in_week[actual_shifts_in_week['weekday'] <= known_through_weekday]
    known_hours = actual_known.groupby('employee_id')['duration_hr'].sum()
    preds = {}
    for emp in all_emp_ids:
        base = known_hours.get(emp, 0.0)
        if pd.isna(base): base = 0.0
        proj = base
        for wd in range(known_through_weekday+1, 7):
            proj += prof_map.get((emp, wd), 0.0)
        preds[emp] = proj
    return pd.Series(preds)

# ---- Backtest: for each complete week, predict using Mon-Wed actual + weekday profile from ALL OTHER weeks ----
results = []
for wk in complete_weeks:
    wk_shifts = shifts[shifts['week_start']==wk]
    hist = shifts[shifts['week_start']!=wk]  # leave-one-week-out
    pred = project_week(wk, hist, wk_shifts, known_through_weekday=2)  # Mon,Tue,Wed known
    actual = wk_shifts.groupby('employee_id')['duration_hr'].sum()
    for emp in all_emp_ids:
        a = actual.get(emp, 0.0)
        if pd.isna(a): a = 0.0
        p = pred.get(emp, 0.0)
        results.append((wk, emp, p, a))

bt = pd.DataFrame(results, columns=['week','employee_id','pred_total','actual_total'])
bt['pred_ot'] = (bt['pred_total']-45).clip(lower=0)
bt['actual_ot'] = (bt['actual_total']-45).clip(lower=0)
bt['actual_breach'] = (bt['actual_ot']>10).astype(int)
bt['error'] = bt['pred_total'] - bt['actual_total']
print("backtest n=", len(bt), "breach rate", bt['actual_breach'].mean())
print("error mean/std", bt['error'].mean(), bt['error'].std())
sigma = bt['error'].std()
bt.to_csv('backtest.csv', index=False)
print(sigma)

print("\n--- v2: frequency-weighted expected hours ---")

def weekday_profile_v2(hist_shifts, n_hist_weeks):
    grp = hist_shifts.groupby(['employee_id','weekday'])['duration_hr']
    med = grp.median()
    cnt = grp.count()  # number of times worked that weekday across n_hist_weeks
    freq = cnt / n_hist_weeks
    expected = (med * freq).reset_index()
    expected.columns = ['employee_id','weekday','expected_hr']
    return expected

def project_week_v2(hist_shifts_excl_target, n_hist_weeks, actual_shifts_in_week, known_through_weekday):
    prof = weekday_profile_v2(hist_shifts_excl_target, n_hist_weeks)
    prof_map = {(r.employee_id, r.weekday): r.expected_hr for r in prof.itertuples()}
    actual_known = actual_shifts_in_week[actual_shifts_in_week['weekday'] <= known_through_weekday]
    known_hours = actual_known.groupby('employee_id')['duration_hr'].sum()
    preds = {}
    for emp in all_emp_ids:
        base = known_hours.get(emp, 0.0)
        if pd.isna(base): base = 0.0
        proj = base
        for wd in range(known_through_weekday+1, 7):
            proj += prof_map.get((emp, wd), 0.0)
        preds[emp] = proj
    return pd.Series(preds)

results2 = []
for wk in complete_weeks:
    wk_shifts = shifts[shifts['week_start']==wk]
    hist = shifts[shifts['week_start']!=wk]
    n_hist_weeks = len(complete_weeks) + 1 - 1  # all weeks except wk = 9 (since current week partial excluded already? all_weeks includes current)
    n_hist_weeks = hist['week_start'].nunique()
    pred = project_week_v2(hist, n_hist_weeks, wk_shifts, known_through_weekday=2)
    actual = wk_shifts.groupby('employee_id')['duration_hr'].sum()
    for emp in all_emp_ids:
        a = actual.get(emp, 0.0)
        if pd.isna(a): a = 0.0
        p = pred.get(emp, 0.0)
        results2.append((wk, emp, p, a))

bt2 = pd.DataFrame(results2, columns=['week','employee_id','pred_total','actual_total'])
bt2['actual_ot'] = (bt2['actual_total']-45).clip(lower=0)
bt2['actual_breach'] = (bt2['actual_ot']>10).astype(int)
bt2['error'] = bt2['pred_total'] - bt2['actual_total']
print("error mean/std", bt2['error'].mean(), bt2['error'].std())
print(bt2['error'].abs().mean(), "MAE")
sigma2 = bt2['error'].std()

from scipy.stats import norm
bt2['risk_score'] = 1 - norm.cdf((55 - bt2['pred_total'])/sigma2)
bt2['pred_breach'] = (bt2['risk_score']>0.5).astype(int)

def metrics(df, col='pred_breach'):
    tp = ((df[col]==1)&(df['actual_breach']==1)).sum()
    fp = ((df[col]==1)&(df['actual_breach']==0)).sum()
    fn = ((df[col]==0)&(df['actual_breach']==1)).sum()
    tn = ((df[col]==0)&(df['actual_breach']==0)).sum()
    prec = tp/(tp+fp) if tp+fp else float('nan')
    rec = tp/(tp+fn) if tp+fn else float('nan')
    f1 = 2*prec*rec/(prec+rec) if prec and rec else float('nan')
    return dict(tp=tp,fp=fp,fn=fn,tn=tn,precision=prec,recall=rec,f1=f1)

print("model metrics:", metrics(bt2))

# naive baseline: predict breach if last completed week's overtime was already >10 (persistence)
bt2_sorted = bt2.sort_values(['employee_id','week'])
# build lookup of actual_ot by (employee,week)
ot_lookup = bt2.set_index(['employee_id','week'])['actual_ot'].to_dict()
weeks_sorted = complete_weeks
def prev_week(w):
    idx = weeks_sorted.index(w)
    return weeks_sorted[idx-1] if idx>0 else None
naive_breach = []
for r in bt2.itertuples():
    pw = prev_week(r.week)
    val = ot_lookup.get((r.employee_id, pw), 0.0) if pw is not None else 0.0
    naive_breach.append(1 if val>10 else 0)
bt2['naive_breach'] = naive_breach
print("naive (persistence) metrics:", metrics(bt2, 'naive_breach'))

# naive baseline 2: always predict 0 (never breach)
bt2['zero_breach']=0
print("naive (never) metrics:", metrics(bt2,'zero_breach'))

from sklearn.metrics import roc_auc_score
try:
    auc = roc_auc_score(bt2['actual_breach'], bt2['risk_score'])
    print("AUC", auc)
except Exception as e:
    print(e)

bt2.to_csv('backtest_v2.csv', index=False)
print(sigma2)

print("\n--- v3: ratio-scaling (trend) method ---")

def project_week_v3(hist_shifts_excl_target, actual_shifts_in_week, known_through_weekday):
    # historical typical hours through Wed vs typical full week, per employee
    hist_known = hist_shifts_excl_target[hist_shifts_excl_target['weekday']<=known_through_weekday]
    hist_known_sum = hist_known.groupby(['employee_id','week_start'])['duration_hr'].sum()
    hist_full_sum = hist_shifts_excl_target.groupby(['employee_id','week_start'])['duration_hr'].sum()
    # avg per employee
    avg_known = hist_known_sum.groupby('employee_id').mean()
    avg_full = hist_full_sum.groupby('employee_id').mean()

    actual_known = actual_shifts_in_week[actual_shifts_in_week['weekday'] <= known_through_weekday]
    known_hours = actual_known.groupby('employee_id')['duration_hr'].sum()

    preds = {}
    for emp in all_emp_ids:
        ak = known_hours.get(emp, 0.0)
        if pd.isna(ak): ak = 0.0
        hk = avg_known.get(emp, np.nan)
        hf = avg_full.get(emp, np.nan)
        if pd.isna(hk) or hk < 1 or pd.isna(hf):
            preds[emp] = ak  # no history, fallback: just known so far
            continue
        ratio = hf / hk
        preds[emp] = ak * ratio
    return pd.Series(preds)

results3 = []
for wk in complete_weeks:
    wk_shifts = shifts[shifts['week_start']==wk]
    hist = shifts[shifts['week_start']!=wk]
    pred = project_week_v3(hist, wk_shifts, known_through_weekday=2)
    actual = wk_shifts.groupby('employee_id')['duration_hr'].sum()
    for emp in all_emp_ids:
        a = actual.get(emp, 0.0)
        if pd.isna(a): a = 0.0
        p = pred.get(emp, 0.0)
        results3.append((wk, emp, p, a))

bt3 = pd.DataFrame(results3, columns=['week','employee_id','pred_total','actual_total'])
bt3['actual_ot'] = (bt3['actual_total']-45).clip(lower=0)
bt3['actual_breach'] = (bt3['actual_ot']>10).astype(int)
bt3['error'] = bt3['pred_total'] - bt3['actual_total']
print("error mean/std", bt3['error'].mean(), bt3['error'].std(), "MAE", bt3['error'].abs().mean())
sigma3 = bt3['error'].std()
bt3['risk_score'] = 1 - norm.cdf((55 - bt3['pred_total'])/sigma3)
bt3['pred_breach'] = (bt3['risk_score']>0.5).astype(int)
print("v3 metrics:", metrics(bt3))
print("AUC v3:", roc_auc_score(bt3['actual_breach'], bt3['risk_score'].fillna(0)))

print("\n--- v4: blend v2 + v3 (average) ---")
blend_pred = (bt2['pred_total'].values + bt3['pred_total'].values)/2
bt4 = bt2[['week','employee_id','actual_total','actual_ot','actual_breach']].copy()
bt4['pred_total'] = blend_pred
sigma4 = (bt4['pred_total']-bt4['actual_total']).std()
bt4['risk_score'] = 1-norm.cdf((55-bt4['pred_total'])/sigma4)
bt4['pred_breach'] = (bt4['risk_score']>0.5).astype(int)
print("blend MAE", (bt4['pred_total']-bt4['actual_total']).abs().mean())
print("blend metrics:", metrics(bt4))
print("AUC blend:", roc_auc_score(bt4['actual_breach'], bt4['risk_score'].fillna(0)))

print("\n--- fix & compare AUCs, pick threshold ---")
print("bt2 NaNs in risk_score:", bt2['risk_score'].isna().sum(), "pred_total NaNs:", bt2['pred_total'].isna().sum())
bt2['risk_score'] = bt2['risk_score'].fillna(0)
print("AUC v2 (freq-weighted):", roc_auc_score(bt2['actual_breach'], bt2['risk_score']))
print("AUC v3 (ratio-scaling):", roc_auc_score(bt3['actual_breach'], bt3['risk_score'].fillna(0)))

from sklearn.metrics import precision_recall_curve
prec, rec, thr = precision_recall_curve(bt3['actual_breach'], bt3['risk_score'].fillna(0))
f1s = 2*prec*rec/(prec+rec+1e-9)
best = np.argmax(f1s)
print("v3 best F1", f1s[best], "at thr", thr[best] if best < len(thr) else None, "prec", prec[best], "rec", rec[best])

# Also try v3 with threshold tuned for recall>=0.7
for target_rec in [0.6,0.7,0.8]:
    idx = np.where(rec>=target_rec)[0]
    if len(idx):
        i = idx[np.argmax(prec[idx])]
        t = thr[i] if i < len(thr) else 1.0
        print(f"target recall {target_rec}: thr={t:.3f} prec={prec[i]:.3f} rec={rec[i]:.3f}")

print("\n--- v2 threshold tuning ---")
prec2, rec2, thr2 = precision_recall_curve(bt2['actual_breach'], bt2['risk_score'])
f1s2 = 2*prec2*rec2/(prec2+rec2+1e-9)
best2 = np.argmax(f1s2)
print("v2 best F1", f1s2[best2], "thr", thr2[best2] if best2<len(thr2) else None, "prec", prec2[best2], "rec", rec2[best2])
for target_rec in [0.6,0.7,0.75,0.8]:
    idx = np.where(rec2>=target_rec)[0]
    if len(idx):
        i = idx[np.argmax(prec2[idx])]
        t = thr2[i] if i < len(thr2) else 1.0
        print(f"target recall {target_rec}: thr={t:.3f} prec={prec2[i]:.3f} rec={rec2[i]:.3f}")
