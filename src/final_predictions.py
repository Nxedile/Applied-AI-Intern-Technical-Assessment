import pandas as pd, numpy as np
from scipy.stats import norm

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
shifts['duration_hr'] = dur/60
shifts['weekday'] = shifts['shift_date'].dt.weekday
shifts['week_start'] = shifts['shift_date'] - pd.to_timedelta(shifts['weekday'], unit='D')

MAX_DATE = shifts['shift_date'].max()
CURRENT_WEEK_START = MAX_DATE - pd.to_timedelta(MAX_DATE.weekday(), unit='D')
known_through_weekday = MAX_DATE.weekday()  # 2 = Wednesday
print("Current week start:", CURRENT_WEEK_START.date(), "known through weekday idx", known_through_weekday)

employees = pd.read_csv('/mnt/user-data/uploads/employees.csv')
all_emp_ids = employees['employee_id'].tolist()

hist = shifts[shifts['week_start'] < CURRENT_WEEK_START]
n_hist_weeks = hist['week_start'].nunique()
cur_week_shifts = shifts[shifts['week_start']==CURRENT_WEEK_START]

grp = hist.groupby(['employee_id','weekday'])['duration_hr']
med = grp.median()
cnt = grp.count()
freq = cnt / n_hist_weeks
expected = (med*freq).reset_index()
expected.columns=['employee_id','weekday','expected_hr']
prof_map = {(r.employee_id, r.weekday): r.expected_hr for r in expected.itertuples()}

known_hours = cur_week_shifts[cur_week_shifts['weekday']<=known_through_weekday].groupby('employee_id')['duration_hr'].sum()

SIGMA = 8.0075  # from backtest v2 residual std

rows = []
for emp in all_emp_ids:
    base = known_hours.get(emp, 0.0)
    if pd.isna(base): base = 0.0
    proj = base
    for wd in range(known_through_weekday+1, 7):
        proj += prof_map.get((emp, wd), 0.0)
    ot = max(0.0, proj-45)
    risk = 1 - norm.cdf((55 - proj)/SIGMA)
    will_breach = 1 if risk >= 0.13 else 0
    rows.append((emp, will_breach, round(float(risk),3), round(base,2), round(proj,2), round(ot,2)))

pred = pd.DataFrame(rows, columns=['employee_id','will_breach','risk_score','known_hours_mon_wed','projected_total_hours','projected_overtime_hours'])
pred = pred.sort_values('risk_score', ascending=False)
print(pred.head(20))
print("total predicted breaches:", pred['will_breach'].sum())
pred.to_csv('predictions_full.csv', index=False)
pred[['employee_id','will_breach','risk_score']].to_csv('predictions.csv', index=False)
