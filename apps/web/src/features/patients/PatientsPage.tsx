import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActionIcon, Alert, Anchor, Box, Button, Group, Loader, Skeleton, Stack, Table, Text, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Pencil, Plus } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link, useSearchParams } from "react-router-dom";
import type { PatientListItem } from "@patient-app/shared";
import { api, ApiError } from "../../lib/api.ts";
import { PatientDrawer, type DrawerState } from "./PatientDrawer.tsx";
import { summaryQuery } from "../chart/summaryQuery.ts";

const ROW_HEIGHT = 49; // fixed so scroll positions stay exact
const HOVER_MS = 150;

function usePrefetchOnHover() {
  const client = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancel = useCallback(() => clearTimeout(timer.current), []);
  const start = useCallback(
    (id: string) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void client.prefetchQuery({ ...summaryQuery(id), staleTime: 30_000 }), HOVER_MS);
    },
    [client],
  );
  useEffect(() => cancel, [cancel]);
  return { start, cancel };
}

export function PatientsPage() {
  const [params] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  // Search waits 300 ms and needs 2+ characters; shorter text lists everyone.
  const [debounced] = useDebouncedValue(q, 300);
  const name = debounced.length >= 2 ? debounced : "";
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const list = useInfiniteQuery({
    queryKey: ["patients", name],
    queryFn: ({ pageParam, signal }) => api.listPatients({ name, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });

  // Every loaded page is shown in one scrolling feed; more load as the bottom nears.
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const expiredCursor = list.isError && list.error instanceof ApiError && list.error.body?.error === "cursor";

  async function restart() {
    setNotice("That page expired, so the list restarted from the beginning.");
    list.refetch(); // refetches every loaded page from the first cursor
  }

  return (
    <Stack gap="md" maw={960} mx="auto">
      <Group justify="space-between">
        <Title order={2}>Patients</Title>
        <Button leftSection={<Plus size={16} aria-hidden />} onClick={() => setDrawer({ mode: "create" })}>
          New patient
        </Button>
      </Group>

      {notice && (
        <Alert color="blue" withCloseButton onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      {list.isPending ? (
        <Stack gap="xs" aria-busy="true" aria-label="Loading patients">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} height={36} />
          ))}
        </Stack>
      ) : list.isError && items.length === 0 ? (
        <Alert color="red" icon={<AlertCircle size={18} aria-hidden />} title="Couldn't load patients">
          <Group justify="space-between">
            <Text size="sm">{list.error.message}</Text>
            <Button size="xs" variant="light" color="red" onClick={() => list.refetch()}>
              Retry
            </Button>
          </Group>
        </Alert>
      ) : items.length === 0 ? (
        <Stack align="center" py="xl" gap="xs">
          <Text fw={500}>{name ? `No patients match “${name}”` : "No patients yet"}</Text>
          <Button variant="light" leftSection={<Plus size={16} aria-hidden />} onClick={() => setDrawer({ mode: "create" })}>
            Create patient
          </Button>
        </Stack>
      ) : (
        <>
          <PatientTable
            items={items}
            onEdit={(id) => setDrawer({ mode: "edit", id })}
            canLoadMore={!!list.hasNextPage && !list.isError}
            loadingMore={list.isFetchingNextPage}
            onLoadMore={() => list.fetchNextPage()}
            footer={
              list.isError ? (
                <Group justify="center" gap="xs" py="sm">
                  <Text size="sm" c="red">
                    {expiredCursor ? "That page expired." : list.error.message}
                  </Text>
                  <Button size="xs" variant="light" color="red" onClick={() => (expiredCursor ? restart() : list.fetchNextPage())}>
                    {expiredCursor ? "Restart list" : "Retry"}
                  </Button>
                </Group>
              ) : list.hasNextPage ? (
                <Group justify="center" py="sm">
                  <Loader size="sm" aria-label="Loading more patients" />
                </Group>
              ) : (
                <Text size="sm" c="dimmed" ta="center" py="sm">
                  {items.length} patients · end of list
                </Text>
              )
            }
          />
        </>
      )}

      <PatientDrawer state={drawer} onClose={() => setDrawer(null)} />
    </Stack>
  );
}

function PatientTable({
  items,
  onEdit,
  canLoadMore,
  loadingMore,
  onLoadMore,
  footer,
}: {
  items: PatientListItem[];
  onEdit: (id: string) => void;
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  footer: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const warm = usePrefetchOnHover();

  // Only the rows near the viewport are in the page; the rest are replaced by spacers,
  // so a long feed stays fast and rows scrolled far past are dropped until you scroll back.
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });
  const rows = virtual.getVirtualItems();
  const top = rows.length ? rows[0]!.start : 0;
  const bottom = rows.length ? virtual.getTotalSize() - rows[rows.length - 1]!.end : 0;
  const lastShown = rows.length ? rows[rows.length - 1]!.index : -1;

  // Fetch the next page when the user is within a few rows of the end of what is loaded.
  // A tall screen shows the end immediately, so it fills itself before any scrolling.
  useEffect(() => {
    if (canLoadMore && !loadingMore && lastShown >= items.length - 4) onLoadMore();
  }, [canLoadMore, loadingMore, lastShown, items.length, onLoadMore]);

  return (
    // Fixed to the space left on screen; the list scrolls inside it under a sticky header.
    <Box ref={scrollRef} h="calc(100vh - 200px)" mih={240} style={{ overflow: "auto" }} tabIndex={0} role="region" aria-label="Patient list">
      <Table highlightOnHover verticalSpacing="xs" stickyHeader miw={520} style={{ tableLayout: "fixed" }}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th w={110}>Gender</Table.Th>
            <Table.Th w={140}>Date of birth</Table.Th>
            <Table.Th w={70}>Age</Table.Th>
            <Table.Th w={56} aria-label="Actions" />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {top > 0 && <tr aria-hidden style={{ height: top }} />}
          {rows.map((vr) => {
            const p = items[vr.index]!;
            return (
              <Table.Tr key={p.id} h={ROW_HEIGHT} data-index={vr.index} aria-rowindex={vr.index + 2}>
                <Table.Td style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {/* Hovering or focusing for 150 ms warms the chart, so the click feels instant. */}
                  <Anchor
                    component={Link}
                    to={`/patients/${encodeURIComponent(p.id)}`}
                    c="inherit"
                    fw={500}
                    onMouseEnter={() => warm.start(p.id)}
                    onFocus={() => warm.start(p.id)}
                    onMouseLeave={warm.cancel}
                    onBlur={warm.cancel}
                  >
                    {p.displayName}
                  </Anchor>
                </Table.Td>
                <Table.Td style={{ textTransform: "capitalize" }}>{p.gender}</Table.Td>
                <Table.Td>
                  {p.birthDate || (
                    <Text span c="dimmed">
                      Not recorded
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>{p.age ?? "–"}</Table.Td>
                <Table.Td>
                  <ActionIcon variant="subtle" aria-label={`Edit ${p.displayName}`} onClick={() => onEdit(p.id)}>
                    <Pencil size={16} aria-hidden />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            );
          })}
          {bottom > 0 && <tr aria-hidden style={{ height: bottom }} />}
        </Table.Tbody>
      </Table>
      {footer}
    </Box>
  );
}
