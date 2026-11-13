// jsdom gaps that OpenUI components hit on mount. Import this only from tests that render OpenUI,
// so no other test file sees a changed environment (vitest isolates each file).
// Without them, the error loops OpenUI's element boundary until React aborts the whole tree.

// Table (ScrollableTable) and the charts observe their own size.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

// PieChart reads matchMedia in an effect.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

// BarChart measures label text on a 2D canvas context, which jsdom returns as null.
HTMLCanvasElement.prototype.getContext = function getContext() {
  return { font: "", measureText: (text: string) => ({ width: text.length * 6 }) }
} as unknown as typeof HTMLCanvasElement.prototype.getContext
