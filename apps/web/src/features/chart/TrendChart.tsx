import { LineChart } from "@mantine/charts";
import { VITAL_LABELS, type VitalKind, type VitalReading } from "@patient-app/shared";
import { formatDate } from "../../lib/format.ts";

/** Loaded on demand so the chart library isn't in the first page the user sees. */
export default function TrendChart({ kind, readings }: { kind: VitalKind; readings: VitalReading[] }) {
  // Oldest first, left to right. Readings with no date can't be placed on a time axis.
  const data = readings
    .filter((r) => r.date)
    .slice()
    .reverse()
    .map((r) => ({ date: formatDate(r.date), systolic: r.systolic, diastolic: r.diastolic, value: r.value }));
  const unit = readings[0]?.unit ?? "";
  const series =
    kind === "bp"
      ? [
          { name: "systolic", label: "Systolic", color: "red.6" },
          { name: "diastolic", label: "Diastolic", color: "blue.6" },
        ]
      : [{ name: "value", label: VITAL_LABELS[kind], color: "teal.6" }];
  return <LineChart h={260} data={data} dataKey="date" series={series} unit={unit ? ` ${unit}` : undefined} withLegend={kind === "bp"} curveType="linear" connectNulls />;
}
