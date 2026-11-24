import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, useLocation } from "react-router-dom";
import { App } from "../src/App.tsx";
import { mockApi, renderApp } from "./helpers.tsx";

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}
const box = () => screen.getByLabelText("Search patients by name") as HTMLInputElement;
const stub = () => mockApi({ "GET /api/patients": () => ({ body: { items: [] } }) });

describe("header search", () => {
  test("typing in the box shows the text and updates the URL (the real fast-typing check is in the browser tests)", async () => {
    stub();
    renderApp(
      <>
        <App />
        <Where />
      </>,
    );
    await userEvent.type(box(), "adams", { delay: 0 });
    expect(box().value).toBe("adams");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/patients?q=adams"));
  });

  test("pressing / focuses the search, but not while typing in another field", async () => {
    stub();
    renderApp(
      <>
        <App />
        <input aria-label="other" />
      </>,
    );
    await userEvent.keyboard("/");
    expect(document.activeElement).toBe(box());
    await userEvent.click(screen.getByLabelText("other"));
    await userEvent.keyboard("/");
    expect((screen.getByLabelText("other") as HTMLInputElement).value).toBe("/");
    expect(document.activeElement).toBe(screen.getByLabelText("other"));
  });

  test("a URL change made elsewhere updates the box when it isn't focused", async () => {
    stub();
    renderApp(
      <>
        <App />
        <Link to="/patients?q=jones">jump</Link>
      </>,
    );
    await userEvent.click(screen.getByText("jump"));
    await waitFor(() => expect(box().value).toBe("jones"));
  });
});
