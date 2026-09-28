# Overtime Watch

Ops dashboard for a national facilities-management client: who is going to
breach the BCEA 10-hour weekly overtime cap by Sunday, why, and what to do
about it today.

**Dashboard:** open `dashboard/overtime_watch.html` directly in a browser
(also published at the link in the submission email). It's fully
self-contained and recomputes everything client-side — including loading a
fresh week's CSV export via the "Load next week's export" panel at the
bottom, no server or developer required.

## Repo layout
- `predictions.csv`, `note_classifications.csv`, `NOTES.md` — the three
  required deliverables.
- `dashboard/overtime_watch.html` — the dashboard (self-contained, static).
- `src/` — the Python used to develop and back-test the model
  (`analysis.py`, `final_predictions.py`), the note classifier
  (`classify_notes.py`), the client/operational split analysis
  (`split_analysis.py`), and the JS the dashboard runs in-browser
  (`pipeline.js`, `compute.js`, `app.js` — a direct port of the Python
  logic, checked to produce identical `will_breach` output on the same data).
- `data/` — the seven files as supplied.

## Method, in short
1. Confirmed the client's own overtime/breach formula from
   `weekly_summary.csv` (`overtime = max(0, total_hours-45)`,
   `breached = overtime>10`) and matched shift-level hour computation to it
   exactly (overnight wraparound, missing-clock-out = 0h, same as their
   system).
2. Projected each person's week-end total from hours already logged plus a
   frequency-weighted historical pattern for their remaining weekdays; risk
   score comes from a back-tested projection-error distribution. Leave-one-
   week-out backtest: AUC ≈ 0.82 across 9 historical weeks.
3. Classified supervisor notes with keyword rules (English / isiZulu /
   Afrikaans, typo-tolerant fuzzy fallback) into six categories, split into
   client-requested (billable) vs. operational-failure (avoidable) hours.

See `NOTES.md` for assumptions, the note-sorting validation, and what a
trained model would add.
