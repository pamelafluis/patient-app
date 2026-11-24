import type { ReactNode } from "react";
import { Alert, Badge, Box, Group, Paper, SimpleGrid, Skeleton, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { AlertCircle, Clock, OctagonAlert, TriangleAlert } from "lucide-react";
import { agoLabel, bpStatus, VITAL_KINDS, VITAL_LABELS, type ChartSummary, type Section, type VitalKind, type VitalReading } from "@patient-app/shared";
import { formatDate } from "../../lib/format.ts";

export function SectionError({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <Alert color="red" variant="light" icon={<AlertCircle size={18} aria-hidden />} title={title}>
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm">{message}</Text>
        {onRetry && (
          <UnstyledButton onClick={onRetry} fz="sm" fw={500} c="red" td="underline">
            Retry
          </UnstyledButton>
        )}
      </Group>
    </Alert>
  );
}

function BpFlag({ reading }: { reading: VitalReading }) {
  if (reading.systolic === undefined || reading.diastolic === undefined) return null;
  const status = bpStatus(reading.systolic, reading.diastolic);
  if (status === "at-goal") return null;
  // Color is never the only signal: each status has its own icon and words.
  // The icon carries the color; the words stay in the normal text color so they meet AA contrast in both themes.
  return (
    <Group gap={4} wrap="nowrap">
      {status === "review-now" ? (
        <OctagonAlert size={14} aria-hidden color="var(--mantine-color-red-6)" />
      ) : (
        <TriangleAlert size={14} aria-hidden color="var(--mantine-color-yellow-6)" />
      )}
      <Text size="xs" fw={600} span>
        {status === "review-now" ? "Review now" : "Above goal"}
      </Text>
    </Group>
  );
}

function VitalCard({ kind, reading, asOf, onOpen }: { kind: VitalKind; reading: VitalReading | null; asOf: string; onOpen: () => void }) {
  const ago = reading ? agoLabel(reading.date, asOf) : null;
  return (
    <UnstyledButton onClick={onOpen} aria-label={`${VITAL_LABELS[kind]} trend`} style={{ display: "block" }}>
      <Paper withBorder p="sm" h="100%">
        <Text size="xs" c="dimmed" fw={500}>
          {VITAL_LABELS[kind]}
        </Text>
        {reading ? (
          <>
            <Group gap={4} align="baseline" wrap="nowrap">
              <Text fz={22} fw={600}>
                {reading.text}
              </Text>
              <Text size="xs" c="dimmed">
                {reading.unit}
              </Text>
            </Group>
            {kind === "bp" && <BpFlag reading={reading} />}
            <Text size="xs" c="dimmed">
              {formatDate(reading.date)}
            </Text>
            {ago && (
              <Group gap={4} wrap="nowrap">
                {ago.old && <Clock size={12} aria-hidden color="var(--mantine-color-yellow-6)" />}
                <Text size="xs" span fw={ago.old ? 600 : undefined} c={ago.old ? undefined : "dimmed"}>
                  {ago.label}
                  {ago.old ? " · old reading" : ""}
                </Text>
              </Group>
            )}
          </>
        ) : (
          <Text fz="lg" c="dimmed" mt={4}>
            No reading
          </Text>
        )}
      </Paper>
    </UnstyledButton>
  );
}

function ListPanel<T extends { id: string }>({
  title,
  section,
  empty,
  more,
  row,
}: {
  title: string;
  section: Section<{ items: T[]; more: boolean }>;
  empty: string;
  more: string;
  row: (item: T) => ReactNode;
}) {
  if (section.status === "error") return <SectionError title={`Couldn't load ${title.toLowerCase()}`} message={section.message} />;
  const { items, more: truncated } = section.data;
  return (
    <Box>
      <Title order={4} mb="xs">
        {title} ({items.length}
        {truncated ? "+" : ""})
      </Title>
      {section.notice && (
        <Alert color="yellow" variant="light" mb="xs" icon={<TriangleAlert size={16} aria-hidden />}>
          {section.notice}
        </Alert>
      )}
      {items.length === 0 ? (
        <Text size="sm" c="dimmed">
          {empty}
        </Text>
      ) : (
        <Stack gap={6} component="ul" m={0} p={0} style={{ listStyle: "none" }}>
          {items.map((i) => (
            <li key={i.id}>{row(i)}</li>
          ))}
        </Stack>
      )}
      {truncated && (
        <Text size="xs" c="dimmed" mt="xs">
          {more}
        </Text>
      )}
    </Box>
  );
}

export function SummaryPanel({ summary, onOpenVital }: { summary: ChartSummary; onOpenVital: (kind: VitalKind) => void }) {
  const { vitals } = summary;
  return (
    <Stack gap="lg">
      {vitals.status === "error" ? (
        <SectionError title="Couldn't load vital signs" message={vitals.message} />
      ) : (
        <SimpleGrid cols={{ base: 2, sm: 3, md: 5 }} spacing="sm" aria-label="Latest vital signs" component="section">
          {VITAL_KINDS.map((k) => (
            <VitalCard key={k} kind={k} reading={vitals.data[k]} asOf={summary.asOf} onOpen={() => onOpenVital(k)} />
          ))}
        </SimpleGrid>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xl">
        <ListPanel
          title="Active conditions"
          section={summary.conditions}
          empty="None recorded"
          more="Showing the first conditions only. See Full history for the rest."
          row={(c) => (
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Text size="sm">{c.name}</Text>
              {c.since && (
                <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                  since {formatDate(c.since)}
                </Text>
              )}
            </Group>
          )}
        />
        <ListPanel
          title="Active medications"
          section={summary.medications}
          empty="None recorded"
          more="Showing the first medications only."
          row={(m) => (
            <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
              <Text size="sm">
                {m.name}
                {m.dose && (
                  <Text span c="dimmed">
                    {" "}
                    · {m.dose}
                  </Text>
                )}
              </Text>
              <Badge variant={m.source === "Prescribed" ? "filled" : "default"} color="teal.9" size="sm">
                {m.source}
              </Badge>
            </Group>
          )}
        />
      </SimpleGrid>
    </Stack>
  );
}

export function SummarySkeleton() {
  return (
    <Stack gap="lg" aria-busy="true" aria-label="Loading chart">
      <SimpleGrid cols={{ base: 2, sm: 3, md: 5 }} spacing="sm">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} height={104} />
        ))}
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xl">
        <Skeleton height={120} />
        <Skeleton height={120} />
      </SimpleGrid>
    </Stack>
  );
}
