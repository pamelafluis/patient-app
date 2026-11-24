import { useState } from "react";
import { Alert, Anchor, Button, Group, Skeleton, Stack, Tabs, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, Pencil } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { HISTORY_SECTIONS, VITAL_KINDS, type HistorySection, type VitalKind } from "@patient-app/shared";
import { ApiError } from "../../lib/api.ts";
import { summaryQuery } from "./summaryQuery.ts";
import { formatDate } from "../../lib/format.ts";
import { PatientDrawer, type DrawerState } from "../patients/PatientDrawer.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { SummaryPanel, SummarySkeleton } from "./SummaryPanel.tsx";
import { TrendsPanel } from "./TrendsPanel.tsx";

const TABS = ["summary", "trends", "history"] as const;
type Tab = (typeof TABS)[number];

/** Which tab, vital and history section are showing lives in the URL, so Back and refresh keep them. */
export function PatientChartPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "summary";
  const vital: VitalKind = (VITAL_KINDS as readonly string[]).includes(params.get("vital") ?? "") ? (params.get("vital") as VitalKind) : "bp";
  const section: HistorySection = (HISTORY_SECTIONS as readonly string[]).includes(params.get("section") ?? "") ? (params.get("section") as HistorySection) : "conditions";
  const [drawer, setDrawer] = useState<DrawerState>(null);

  const q = useQuery(summaryQuery(id));
  // Changing tab is a step Back can undo; picking a vital or section within a tab just replaces.
  const set = (next: Record<string, string>) => setParams({ ...Object.fromEntries(params), ...next }, { replace: !("tab" in next) });

  const back = (
    <Anchor component={Link} to="/patients" size="sm">
      <Group gap={4} wrap="nowrap">
        <ArrowLeft size={14} aria-hidden /> Patients
      </Group>
    </Anchor>
  );

  if (q.isPending) {
    return (
      <Stack gap="md" maw={1100} mx="auto">
        {back}
        <Skeleton height={32} width={320} aria-label="Loading patient" />
        <SummarySkeleton />
      </Stack>
    );
  }
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <Stack gap="md" maw={1100} mx="auto">
        {back}
        <Alert color="red" icon={<AlertCircle size={18} aria-hidden />} title={missing ? "Patient not found" : "Couldn't load this chart"}>
          <Group justify="space-between">
            <Text size="sm">{missing ? "This patient doesn't exist on the FHIR server." : q.error.message}</Text>
            {!missing && (
              <Button size="xs" variant="light" color="red" onClick={() => q.refetch()}>
                Retry
              </Button>
            )}
          </Group>
        </Alert>
      </Stack>
    );
  }

  const { patient, asOf } = q.data;
  const facts = [patient.gender, patient.birthDate ? formatDate(patient.birthDate) : "Date of birth not recorded", patient.age !== null ? `${patient.age} y` : null].filter(Boolean);

  return (
    <Stack gap="md" maw={1100} mx="auto">
      {back}
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Title order={2}>{patient.displayName}</Title>
          <Text c="dimmed" tt="capitalize">
            {facts.join(" · ")}
          </Text>
        </div>
        <Button variant="default" leftSection={<Pencil size={16} aria-hidden />} onClick={() => setDrawer({ mode: "edit", id: patient.id })}>
          Edit
        </Button>
      </Group>

      <Tabs value={tab} onChange={(v) => v && set({ tab: v })} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="summary">Summary</Tabs.Tab>
          <Tabs.Tab value="trends">Vitals trends</Tabs.Tab>
          <Tabs.Tab value="history">Full history</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="summary">
          <SummaryPanel summary={q.data} onOpenVital={(k) => set({ tab: "trends", vital: k })} />
        </Tabs.Panel>
        <Tabs.Panel value="trends">
          <TrendsPanel patientId={patient.id} kind={vital} asOf={asOf} onKind={(k) => set({ vital: k })} />
        </Tabs.Panel>
        <Tabs.Panel value="history">
          <HistoryPanel patientId={patient.id} section={section} onSection={(s) => set({ section: s })} />
        </Tabs.Panel>
      </Tabs>

      <PatientDrawer state={drawer} onClose={() => setDrawer(null)} />
    </Stack>
  );
}
