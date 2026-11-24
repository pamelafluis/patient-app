import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:5173/" });

// Mantine and the virtualizer expect browser features the fake DOM lacks.
window.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
})) as any;
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver ??= RO;
Element.prototype.scrollIntoView ??= () => {};
// No layout engine: give every element a 1000x600 box so the virtualized list renders rows.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1000 });
Element.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON() {} }) as DOMRect;
