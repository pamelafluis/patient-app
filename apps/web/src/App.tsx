import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { AppShell, Group, Skeleton, Text, TextInput, Anchor, Kbd } from "@mantine/core";
import { Heart, Search } from "lucide-react";
import { Link, Navigate, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { PatientsPage } from "./features/patients/PatientsPage.tsx";

// Route-level code splitting: the chart (and its tabs) load only when a chart is opened.
const PatientChartPage = lazy(() => import("./features/chart/PatientChartPage.tsx").then((m) => ({ default: m.PatientChartPage })));

function HeaderSearch() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const ref = useRef<HTMLInputElement>(null);
  const urlQ = params.get("q") ?? "";
  const [text, setText] = useState(urlQ);
  // Pick up URL changes made elsewhere (Back, links), without fighting typing.
  useEffect(() => {
    // While the user is typing here, the input is the source of truth.
    if (document.activeElement !== ref.current) setText(urlQ);
  }, [urlQ]);

  // "/" focuses search from anywhere that isn't a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <TextInput
      ref={ref}
      aria-label="Search patients by name"
      placeholder="Search patients by name"
      leftSection={<Search size={16} aria-hidden />}
      rightSection={<Kbd size="xs">/</Kbd>}
      w={{ base: 160, sm: 320 }}
      value={text}
      onChange={(e) => {
        // Local state keeps typing instant; the URL follows so Back and refresh work.
        const q = e.currentTarget.value;
        setText(q);
        navigate(q ? `/patients?q=${encodeURIComponent(q)}` : "/patients", { replace: true });
      }}
    />
  );
}

export function App() {
  return (
    <AppShell header={{ height: 60 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Anchor component={Link} to="/patients" underline="never" c="inherit">
            <Group gap={6} wrap="nowrap">
              <Heart size={20} aria-hidden color="var(--mantine-color-teal-6)" />
              <Text fw={600}>Patients</Text>
            </Group>
          </Anchor>
          <HeaderSearch />
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Routes>
          <Route path="/" element={<Navigate to="/patients" replace />} />
          <Route path="/patients" element={<PatientsPage />} />
          <Route
            path="/patients/:id"
            element={
              <Suspense fallback={<Skeleton height={32} width={320} aria-label="Loading patient" />}>
                <PatientChartPage />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/patients" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
