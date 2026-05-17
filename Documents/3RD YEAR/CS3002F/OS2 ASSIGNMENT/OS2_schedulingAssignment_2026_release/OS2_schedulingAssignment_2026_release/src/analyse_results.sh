#!/bin/bash
# analyse_results.sh
# Reads all experiment CSVs and produces a summary table
# Run from the same folder as run_experiments.sh (src/)
# CSV format: PatronID, Drink, WaitingTime, ResponseTime, TurnaroundTime

RESULTS_DIR="results"
OUTPUT="$RESULTS_DIR/summary.csv"
PRETTY="$RESULTS_DIR/summary_table.txt"

SCHEDULERS=("FCFS" "SJF" "PRIORITY" "MLFQ")
PATRONS=(10 30 50)
SEEDS=(42 123 999)

# ── Write CSV header ───────────────────────────────────────────────────────────
echo "Scheduler,Patrons,Seed,AvgWait,AvgResponse,AvgTurnaround,MinWait,MaxWait,MinTurnaround,MaxTurnaround,Count" > "$OUTPUT"

# ── Pretty table header ────────────────────────────────────────────────────────
{
printf "%-10s %-8s %-6s %10s %11s %13s %10s %10s %13s %13s %6s\n" \
  "Scheduler" "Patrons" "Seed" "AvgWait" "AvgResponse" "AvgTurnaround" "MinWait" "MaxWait" "MinTurnaround" "MaxTurnaround" "Count"
printf '%s\n' "$(printf '%.0s-' {1..105})"
} > "$PRETTY"

# ── Process each CSV ───────────────────────────────────────────────────────────
for sched in "${SCHEDULERS[@]}"; do
  for patrons in "${PATRONS[@]}"; do
    for seed in "${SEEDS[@]}"; do

      csv="$RESULTS_DIR/${sched}_p${patrons}_s${seed}_results.csv"

      if [ ! -f "$csv" ]; then
        echo "  MISSING: $csv"
        continue
      fi

      # Use awk to compute all stats in one pass
      # Columns: $1=PatronID $2=Drink $3=WaitingTime $4=ResponseTime $5=TurnaroundTime
      stats=$(awk -F',' '
        NF >= 5 {
          wait=$3; resp=$4; turn=$5
          sumW+=wait; sumR+=resp; sumT+=turn
          if (NR==1 || wait<minW) minW=wait
          if (NR==1 || wait>maxW) maxW=wait
          if (NR==1 || turn<minT) minT=turn
          if (NR==1 || turn>maxT) maxT=turn
          count++
        }
        END {
          if (count>0)
            printf "%.1f,%.1f,%.1f,%d,%d,%d,%d,%d",
              sumW/count, sumR/count, sumT/count,
              minW, maxW, minT, maxT, count
          else
            print "0,0,0,0,0,0,0,0"
        }
      ' "$csv")

      # Append to CSV
      echo "$sched,$patrons,$seed,$stats" >> "$OUTPUT"

      # Parse for pretty table
      avgW=$(echo "$stats"  | cut -d',' -f1)
      avgR=$(echo "$stats"  | cut -d',' -f2)
      avgT=$(echo "$stats"  | cut -d',' -f3)
      minW=$(echo "$stats"  | cut -d',' -f4)
      maxW=$(echo "$stats"  | cut -d',' -f5)
      minT=$(echo "$stats"  | cut -d',' -f6)
      maxT=$(echo "$stats"  | cut -d',' -f7)
      cnt=$(echo "$stats"   | cut -d',' -f8)

      printf "%-10s %-8s %-6s %10s %11s %13s %10s %10s %13s %13s %6s\n" \
        "$sched" "$patrons" "$seed" \
        "${avgW}ms" "${avgR}ms" "${avgT}ms" \
        "${minW}ms" "${maxW}ms" "${minT}ms" "${maxT}ms" \
        "$cnt" >> "$PRETTY"

    done

    # Blank line between patron groups for readability
    echo "" >> "$PRETTY"

  done
done

# ── Averaged-across-seeds summary (most useful for report) ─────────────────────
REPORT="$RESULTS_DIR/report_summary.txt"
{
echo "======================================================"
echo " AVERAGED ACROSS ALL SEEDS (best for report tables)"
echo "======================================================"
printf "%-10s %-8s %12s %13s %15s\n" \
  "Scheduler" "Patrons" "Avg Wait" "Avg Response" "Avg Turnaround"
printf '%s\n' "$(printf '%.0s-' {1..62})"

for sched in "${SCHEDULERS[@]}"; do
  for patrons in "${PATRONS[@]}"; do

    # Average the per-seed averages using awk on the summary CSV
    awk -F',' -v s="$sched" -v p="$patrons" '
      $1==s && $2==p {
        sumW+=$4; sumR+=$5; sumT+=$6; count++
      }
      END {
        if (count>0)
          printf "%-10s %-8s %11.1fms %12.1fms %14.1fms\n",
            s, p, sumW/count, sumR/count, sumT/count
      }
    ' "$OUTPUT"

  done
  echo ""
done
} > "$REPORT"

# ── Print everything to terminal ───────────────────────────────────────────────
echo ""
echo "====== Full Results (all seeds) ======"
cat "$PRETTY"

echo ""
cat "$REPORT"

echo ""
echo "====== Files saved ======"
echo "  Detailed CSV  → $OUTPUT"
echo "  Full table    → $PRETTY"
echo "  Report table  → $REPORT"
