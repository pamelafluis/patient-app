import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/charts/styles.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider, createTheme, type CSSVariablesResolver } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";

const theme = createTheme({ primaryColor: "teal" });

// Mantine's default "dimmed" gray is under 4.5:1 on white; darken it (and lighten it in dark mode) for WCAG AA.
const resolver: CSSVariablesResolver = () => ({
  variables: {},
  light: { "--mantine-color-dimmed": "var(--mantine-color-gray-7)", "--mantine-color-anchor": "var(--mantine-color-teal-9)" },
  dark: { "--mantine-color-dimmed": "var(--mantine-color-dark-1)", "--mantine-color-anchor": "var(--mantine-color-teal-3)" },
});
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} cssVariablesResolver={resolver} defaultColorScheme="auto">
      <Notifications position="top-right" />
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </MantineProvider>
  </React.StrictMode>,
);
