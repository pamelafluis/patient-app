import { api } from "../../lib/api.ts";

/** Shared by the chart page and the list's hover prefetch. Its own file keeps the list from importing the chart. */
export const summaryQuery = (id: string) => ({
  queryKey: ["chart", "summary", id] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => api.getSummary(id, signal),
});
