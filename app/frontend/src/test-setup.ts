import '@testing-library/jest-dom/vitest';

// React Flow uses ResizeObserver and DOMRect APIs that jsdom doesn't ship.
// Provide minimal shims so the graph renders during tests.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

if (typeof globalThis.DOMMatrixReadOnly === 'undefined') {
  globalThis.DOMMatrixReadOnly = class {
    m22 = 1;
    constructor(_init?: unknown) {}
  } as unknown as typeof DOMMatrixReadOnly;
}

// HTMLElement.offsetHeight / offsetWidth getters are always 0 in jsdom, which
// makes React Flow think its container has no space and skip rendering nodes.
// Override with a fixed non-zero size so tests can assert on node DOM.
Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { configurable: true, get: () => 800 },
  offsetWidth: { configurable: true, get: () => 1024 },
});
