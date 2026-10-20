import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Monaco needs a real browser; tests use the textarea editor with the same props.
vi.mock('../features/editor/MonacoSqlEditor', () => import('../features/editor/TextareaSqlEditor'));

afterEach(() => cleanup());

// jsdom lacks layout APIs that the panel library touches; minimal shims are enough for behaviour tests.
class ResizeObserverShim {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverShim as unknown as typeof ResizeObserver;
