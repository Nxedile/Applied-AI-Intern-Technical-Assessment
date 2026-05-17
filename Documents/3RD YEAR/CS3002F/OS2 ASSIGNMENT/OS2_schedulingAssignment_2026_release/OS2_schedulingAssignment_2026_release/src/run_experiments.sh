#!/bin/bash
# run_experiments.sh
# Automates all bar scheduling experiments
# Usage: bash run_experiments.sh
# Run from the directory ABOVE your barScheduling package folder

# ── Configuration ─────────────────────────────────────────────────────────────
PATRONS=(10 30 50)        # different patron counts to test
SCHEDULERS=(0 1 2 3)      # 0=FCFS 1=SJF 2=Priority 3=MLFQ
SWITCH_TIME=5             # context switch delay (ms)
SEEDS=(42 123 999)        # multiple seeds = more reliable averages
# ──────────────────────────────────────────────────────────────────────────────

SCHED_NAMES=("FCFS" "SJF" "PRIORITY" "MLFQ")
RESULTS_DIR="results"
LOG_FILE="$RESULTS_DIR/experiment_log.txt"

mkdir -p "$RESULTS_DIR"
echo "====== Bar Scheduling Experiments ======" | tee "$LOG_FILE"
echo "Started: $(date)" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

total=0
passed=0
failed=0

for patrons in "${PATRONS[@]}"; do
  for sched in "${SCHEDULERS[@]}"; do
    for seed in "${SEEDS[@]}"; do

      name="${SCHED_NAMES[$sched]}"
      label="${name}_p${patrons}_s${seed}"

      echo "▶ Running: $label" | tee -a "$LOG_FILE"

      # Run simulation
      java barScheduling.SchedulingSimulation "$patrons" "$sched" "$SWITCH_TIME" "$seed" \
        >> "$LOG_FILE" 2>&1

      EXIT_CODE=$?
      total=$((total + 1))

      if [ $EXIT_CODE -ne 0 ]; then
        echo "  ✗ FAILED (exit code $EXIT_CODE)" | tee -a "$LOG_FILE"
        failed=$((failed + 1))
        continue
      fi

      # Each scheduler writes its own CSV e.g. results/FCFS_results.csv
      # Rename it so runs don't overwrite each other
      SRC="$RESULTS_DIR/${name}_results.csv"
      DEST="$RESULTS_DIR/${label}_results.csv"

      if [ -f "$SRC" ]; then
        cp "$SRC" "$DEST"
        echo "  ✓ Saved → $DEST" | tee -a "$LOG_FILE"
        passed=$((passed + 1))
      else
        echo "  ✗ CSV not found: $SRC" | tee -a "$LOG_FILE"
        failed=$((failed + 1))
      fi

    done
  done
done

echo "" | tee -a "$LOG_FILE"
echo "====== Done: $passed/$total runs succeeded, $failed failed ======" | tee -a "$LOG_FILE"
echo "Finished: $(date)" | tee -a "$LOG_FILE"

# ── Quick summary: average waiting time per scheduler ─────────────────────────
echo ""
echo "====== Average Waiting Times (seed=42, patrons=30) ======"
for sched in "${SCHEDULERS[@]}"; do
  name="${SCHED_NAMES[$sched]}"
  csv="$RESULTS_DIR/${name}_p30_s42_results.csv"
  if [ -f "$csv" ]; then
    avg=$(awk -F',' '{sum+=$3; count++} END {printf "%.1f", sum/count}' "$csv")
    echo "  $name: avg wait = ${avg} ms"
  fi
done
