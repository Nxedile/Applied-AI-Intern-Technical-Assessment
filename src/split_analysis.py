import pandas as pd, numpy as np

shifts = pd.read_csv('/mnt/user-data/uploads/shifts.csv', dtype=str)
shifts['shift_date'] = pd.to_datetime(shifts['shift_date'])
def to_min(t):
    if pd.isna(t): return np.nan
    h,m = t.split(':'); return int(h)*60+int(m)
shifts['in_min']=shifts['clock_in_time'].apply(to_min)
shifts['out_min']=shifts['clock_out_time'].apply(to_min)
dur = shifts['out_min']-shifts['in_min']; dur[dur<0]+=24*60
shifts['duration_hr']=dur/60

notes = pd.read_csv('note_classifications.csv')
sites = pd.read_csv('/mnt/user-data/uploads/sites.csv')

m = shifts.merge(notes[['shift_id','category']], on='shift_id', how='left')
m['category'] = m['category'].fillna('no_note')

# baseline "normal" shift length per employee = median duration on shifts with no note (or overall median if none)
baseline_no_note = m[m['category'].isin(['no_note','no_info'])].groupby('employee_id')['duration_hr'].median()
overall_median = m.groupby('employee_id')['duration_hr'].median()
def baseline(emp):
    b = baseline_no_note.get(emp, np.nan)
    if pd.isna(b): b = overall_median.get(emp, 9.5)
    return b

m['baseline_hr'] = m['employee_id'].apply(baseline)
m['excess_hr'] = (m['duration_hr'] - m['baseline_hr']).clip(lower=0)

OPS_FAILURE = {'relief_no_show','equipment_failure','handover_delay'}
BILLABLE = {'client_requested'}

def bucket(cat):
    if cat in OPS_FAILURE: return 'operational_failure'
    if cat in BILLABLE: return 'client_requested'
    if cat=='no_note': return 'no_note_baseline'
    return 'unexplained'

m['bucket'] = m['category'].apply(bucket)

print("=== Excess hours by bucket (total across all data) ===")
print(m.groupby('bucket')['excess_hr'].agg(['sum','count','mean']).round(2))

print("\n=== Excess hours by category ===")
print(m.groupby('category')['excess_hr'].agg(['sum','count']).round(2).sort_values('sum', ascending=False))

only_flagged = m[m['bucket'].isin(['operational_failure','client_requested','unexplained'])]
tot = only_flagged['excess_hr'].sum()
print("\nTotal 'extra' hours tied to a note:", round(tot,1))
print("Share operational_failure: {:.1f}%".format(100*only_flagged[only_flagged.bucket=='operational_failure']['excess_hr'].sum()/tot))
print("Share client_requested: {:.1f}%".format(100*only_flagged[only_flagged.bucket=='client_requested']['excess_hr'].sum()/tot))

m2 = m.merge(sites, on='site_id', how='left')
print("\n=== By site: operational-failure excess hours ===")
site_ops = m2[m2['bucket']=='operational_failure'].groupby('site_name')['excess_hr'].sum().sort_values(ascending=False)
print(site_ops.round(1))
site_client = m2[m2['bucket']=='client_requested'].groupby('site_name')['excess_hr'].sum().sort_values(ascending=False)
print("\n=== By site: client-requested excess hours ===")
print(site_client.round(1))

print("\n=== By category within operational_failure, by site (top) ===")
print(m2[m2['bucket']=='operational_failure'].groupby(['site_name','category'])['excess_hr'].sum().round(1))
