import { afterEach, mock } from "bun:test";
import { cleanup } from "@testing-library/react";

// Remove rendered components after every test, in every file.
afterEach(() => cleanup());

// The real virtualizer needs a layout engine to decide which rows are visible. Here it renders
// every row; windowing and scrolling are checked in a real browser instead.
mock.module("@tanstack/react-virtual", () => ({
  useVirtualizer: (o: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: o.count }, (_, index) => ({ index, start: index * 49, end: (index + 1) * 49 })),
    getTotalSize: () => o.count * 49,
  }),
}));
