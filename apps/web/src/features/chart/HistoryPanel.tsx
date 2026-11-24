import { Badge, Button, Group, Select, Skeleton, Stack, Text } from "@mantine/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import { HISTORY_LABELS, HISTORY_SECTIONS, type HistorySection } from "@patient-app/shared";
import { api, ApiError } from "../../lib/api.ts";
import { formatDate } from "../../lib/format.ts";
import { SectionError } from "./SummaryPanel.tsx";

/** Nothing here loads until the tab is opened, and each section loads on its own. */
export function HistoryPanel({ patientId, section, onSection }: { patientId: string; section: HistorySection; onSection: (s: HistorySection) => void }) {
  const q = useInfiniteQuery({
    queryKey: ["chart", "history", patientId, section],
    queryFn: ({ pageParam, signal }) => api.getHistory(patientId, section, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const expired = q.isError && q.error instanceof ApiError && q.error.body?.error === "cursor";
  const label = HISTORY_LABELS[section].toLowerCase();

  return (
    <Stack gap="md">
      <Select
        label="Show"
        w={260}
        allowDeselect={false}
        value={section}
        onChange={(v) => v && onSection(v as HistorySection)}
        data={HISTORY_SECTIONS.map((s) => ({ value: s, label: HISTORY_LABELS[s] }))}
      />

      {q.isPending ? (
        <Stack gap="xs" aria-busy="true" aria-label={`Loading ${label}`}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={34} />
          ))}
        </Stack>
      ) : q.isError && items.length === 0 ? (
        <SectionError title={`Couldn't load ${label}`} message={q.error.message} onRetry={() => q.refetch()} />
      ) : items.length === 0 && !q.hasNextPage ? (
        <Text c="dimmed" py="lg">
          None recorded
        </Text>
      ) : (
        <>
          <Stack gap={0} component="ul" m={0} p={0} style={{ listStyle: "none" }} aria-label={HISTORY_LABELS[section]}>
            {items.map((i) => (
              <li key={i.id} style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
                <Group justify="space-between" wrap="nowrap" py="xs" align="flex-start">
                  <Stack gap={0}>
                    <Text size="sm" fw={500}>
                      {i.title}
                    </Text>
                    {i.detail && (
                      <Text size="xs" c="dimmed">
                        {i.detail}
                      </Text>
                    )}
                  </Stack>
                  <Group gap="xs" wrap="nowrap">
                    {i.status && (
                      <Badge variant="light" color="gray" size="sm">
                        {i.status}
                      </Badge>
                    )}
                    <Text size="xs" c="dimmed" w={84} ta="right">
                      {i.date ? formatDate(i.date) : "–"}
                    </Text>
                  </Group>
                </Group>
              </li>
            ))}
          </Stack>
          <Group justify="center" gap="sm">
            {q.isError && (
              <Text size="sm" c="red">
                {expired ? "That page expired." : q.error.message}
              </Text>
            )}
            {q.hasNextPage ? (
              <Button variant="light" loading={q.isFetchingNextPage} onClick={() => (expired ? q.refetch() : q.fetchNextPage())}>
                {expired ? "Restart" : q.isError ? "Retry" : "Load more"}
              </Button>
            ) : (
              <Text size="sm" c="dimmed">
                {items.length} {items.length === 1 ? "record" : "records"} · all loaded
              </Text>
            )}
          </Group>
        </>
      )}
    </Stack>
  );
}
