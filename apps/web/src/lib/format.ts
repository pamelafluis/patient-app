const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "2 Nov 2026", "Mar 2019" or "2019" — as precise as the record is. The date is read
 * as written, so a reading taken late in the evening isn't shifted to another day.
 */
export function formatDate(value: string | undefined): string {
  const m = value ? /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(value) : null;
  if (!m) return "Date not recorded";
  const month = m[2] ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!month) return m[1]!;
  return m[3] ? `${Number(m[3])} ${month} ${m[1]}` : `${month} ${m[1]}`;
}
