import { lazy, Suspense } from "react";
import { Button, Group, ScrollArea, SegmentedControl, Skeleton, Stack, Table, Text } from "@mantine/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import { agoLabel, VITAL_KINDS, VITAL_LABELS, type VitalKind } from "@patient-app/shared";
import { api } from "../../lib/api.ts";
import { formatDate } from "../../lib/format.ts";
import { SectionError } from "./SummaryPanel.tsx";

const TrendChart = lazy(() => import("./TrendChart.tsx"));

export function TrendsPanel({ patientId, kind, asOf, onKind }: { patientId: string; kind: VitalKind; asOf: string; onKind: (k: VitalKind) => void }) {
  const q = useInfiniteQuery({
    queryKey: ["chart", "vitals", patientId, kind],
    queryFn: ({ pageParam, signal }) => api.getVitals(patientId, kind, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  const readings = q.data?.pages.flatMap((p) => p.readings) ?? [];
  const dated = readings.filter((r) => r.date).length;

  return (
    <Stack gap="md">
      <ScrollArea type="auto" offsetScrollbars>
        <SegmentedControl
          aria-label="Vital sign"
          value={kind}
          onChange={(v) => onKind(v as VitalKind)}
          data={VITAL_KINDS.map((k) => ({ value: k, label: VITAL_LABELS[k] }))}
        />
      </ScrollArea>

      {q.isPending ? (
        <Skeleton height={260} aria-busy="true" aria-label="Loading readings" />
      ) : q.isError && readings.length === 0 ? (
        <SectionError title={`Couldn't load ${VITAL_LABELS[kind].toLowerCase()} readings`} message={q.error.message} onRetry={() => q.refetch()} />
      ) : readings.length === 0 ? (
        <Text c="dimmed" py="lg">
          No {VITAL_LABELS[kind].toLowerCase()} readings recorded
        </Text>
      ) : (
        <>
          {dated > 1 ? (
            <div role="img" aria-label={`${VITAL_LABELS[kind]} over time, ${dated} readings. The same values are in the table below.`}>
              <Suspense fallback={<Skeleton height={260} />}>
                <TrendChart kind={kind} readings={readings} />
              </Suspense>
            </div>
          ) : (
            <Text size="sm" c="dimmed">
              Not enough dated readings to draw a trend.
            </Text>
          )}
          <Table aria-label={`${VITAL_LABELS[kind]} readings`} verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Date</Table.Th>
                <Table.Th>Reading</Table.Th>
                <Table.Th>Age</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {readings.map((r, i) => (
                <Table.Tr key={i}>
                  <Table.Td>{formatDate(r.date)}</Table.Td>
                  <Table.Td>
                    {r.text} <Text span c="dimmed" size="xs">{r.unit}</Text>
                  </Table.Td>
                  <Table.Td c="dimmed">{agoLabel(r.date, asOf)?.label ?? "–"}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Group justify="center" gap="sm">
            {q.isError && (
              <Text size="sm" c="red">
                {q.error.message}
              </Text>
            )}
            {q.hasNextPage ? (
              <Button variant="light" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                {q.isError ? "Retry" : "Load earlier readings"}
              </Button>
            ) : (
              <Text size="sm" c="dimmed">
                {readings.length} {readings.length === 1 ? "reading" : "readings"} · all loaded
              </Text>
            )}
          </Group>
        </>
      )}
    </Stack>
  );
}
