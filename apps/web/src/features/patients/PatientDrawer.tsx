import { useEffect, useRef, useState } from "react";
import { Alert, Button, Drawer, Group, Input, LoadingOverlay, SegmentedControl, Stack, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { DateInput } from "@mantine/dates";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { GENDERS, createPatientInputSchema, type PatientDetail } from "@patient-app/shared";
import { api, ApiError } from "../../lib/api.ts";

export type DrawerState = { mode: "create" } | { mode: "edit"; id: string } | null;
type Values = { given: string; family: string; gender: string; birthDate: string };
const EMPTY: Values = { given: "", family: "", gender: "unknown", birthDate: "" };

const toValues = (p: PatientDetail): Values => ({ given: p.given, family: p.family, gender: p.gender, birthDate: p.birthDate });

export function PatientDrawer({ state, onClose }: { state: DrawerState; onClose: () => void }) {
  const editId = state?.mode === "edit" ? state.id : undefined;
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [conflict, setConflict] = useState<PatientDetail | null>(null);

  const loaded = useQuery({
    queryKey: ["patient", editId],
    queryFn: () => api.getPatient(editId!),
    enabled: !!editId,
    staleTime: 0,
    gcTime: 0,
  });
  const opened = loaded.data; // the version the user opened

  const form = useForm<Values>({
    initialValues: EMPTY,
    validate: (values) => {
      // Same schema the API enforces, using the user's own time zone.
      const schema = createPatientInputSchema({ tzOffsetHours: -new Date().getTimezoneOffset() / 60 });
      // An unchanged partial date on an existing record stays valid.
      const keepDate = !!opened && values.birthDate === opened.birthDate;
      const r = schema.safeParse(keepDate ? { ...values, birthDate: "2000-01-01" } : values);
      const errors: Record<string, string> = {};
      if (!r.success) for (const i of r.error.issues) errors[String(i.path[0])] ??= i.message;
      return errors;
    },
  });

  // Reset whenever the drawer opens for a different target.
  useEffect(() => {
    setConflict(null);
    save.reset();
    form.setValues(EMPTY);
    form.resetDirty(EMPTY);
    form.clearErrors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.mode, editId]);

  useEffect(() => {
    if (opened) {
      form.setValues(toValues(opened));
      form.resetDirty(toValues(opened));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const save = useMutation({
    mutationFn: (v: Values) => (editId ? api.updatePatient(editId, { ...v, version: opened?.version }) : api.createPatient(v)),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["patients"] });
      void queryClient.invalidateQueries({ queryKey: ["chart", "summary"] }); // an open or cached chart shows the old name
      const unprotected = "conflictProtection" in saved && !saved.conflictProtection;
      notifications.show({
        color: unprotected ? "yellow" : "teal",
        message: unprotected ? "Saved. This server gives no version, so conflict protection wasn't available." : editId ? "Patient saved" : "Patient created",
      });
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409 && e.body?.current) setConflict(e.body.current as PatientDetail);
      else if (e instanceof ApiError && e.status === 422 && e.body?.fields) {
        form.setErrors(e.body.fields);
        focusFirstError();
      }
    },
  });

  function focusFirstError() {
    setTimeout(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus(), 0);
  }

  function reloadCurrent(current: PatientDetail) {
    form.setValues(toValues(current));
    form.resetDirty(toValues(current));
    // The next save is checked against the version the user is now looking at.
    queryClient.setQueryData(["patient", editId], current);
    setConflict(null);
  }

  const loading = !!editId && loaded.isPending;
  const showSaveError = save.isError && !conflict && !(save.error instanceof ApiError && save.error.status === 422);

  return (
    <Drawer opened={!!state} onClose={onClose} title={state?.mode === "create" ? "New patient" : "Edit patient"} position="right" size="md" returnFocus>
      <LoadingOverlay visible={loading} />
      {loaded.isError ? (
        <Alert color="red" icon={<AlertCircle size={18} aria-hidden />} title="Couldn't load this patient">
          <Group justify="space-between">
            <Text size="sm">{loaded.error.message}</Text>
            <Button size="xs" variant="light" color="red" onClick={() => loaded.refetch()}>
              Retry
            </Button>
          </Group>
        </Alert>
      ) : (
        <form ref={formRef} noValidate onSubmit={form.onSubmit((v) => save.mutate(v), focusFirstError)}>
          <Stack gap="md">
            {conflict && (
              <Alert color="yellow" icon={<AlertCircle size={18} aria-hidden />} title="This record changed since you opened it">
                <Stack gap="xs" align="flex-start">
                  <Text size="sm">
                    Current values: {conflict.family || "no family name"}, {conflict.given || "no given name"} · {conflict.gender} · {conflict.birthDate || "no date of birth"}
                  </Text>
                  <Button size="xs" variant="light" onClick={() => reloadCurrent(conflict)}>
                    Reload current values
                  </Button>
                </Stack>
              </Alert>
            )}
            {showSaveError && (
              <Alert color="red" icon={<AlertCircle size={18} aria-hidden />}>
                {save.error.message}
              </Alert>
            )}
            {opened && !opened.version && (
              <Alert color="gray" variant="light">
                Conflict protection is unavailable on this server.
              </Alert>
            )}
            <TextInput label="Given name" {...form.getInputProps("given")} />
            <TextInput label="Family name" withAsterisk data-autofocus {...form.getInputProps("family")} />
            <Input.Wrapper label="Gender" withAsterisk error={form.errors.gender}>
              <SegmentedControl
                fullWidth
                aria-label="Gender"
                data={GENDERS.map((g) => ({ value: g, label: g[0]!.toUpperCase() + g.slice(1) }))}
                {...form.getInputProps("gender")}
              />
            </Input.Wrapper>
            {/* An existing partial date ("1950") can't be shown in a picker, so it stays editable as text. */}
            {opened && opened.birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(opened.birthDate) ? (
              <TextInput label="Date of birth" description="Recorded as a partial date. Enter YYYY-MM-DD to make it exact." withAsterisk {...form.getInputProps("birthDate")} />
            ) : (
              <DateInput
                label="Date of birth"
                description="Pick a date or type it as YYYY-MM-DD"
                placeholder="YYYY-MM-DD"
                valueFormat="YYYY-MM-DD"
                maxDate={new Date()}
                defaultLevel="decade"
                clearable
                withAsterisk
                popoverProps={{ withinPortal: true }}
                {...form.getInputProps("birthDate")}
                value={form.values.birthDate || null}
                onChange={(v) => form.setFieldValue("birthDate", v ?? "")}
              />
            )}
            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={save.isPending} disabled={loading || !!conflict}>
                Save
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Drawer>
  );
}
