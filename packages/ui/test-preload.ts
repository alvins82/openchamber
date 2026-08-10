// Test preload: stub the Vite-only `?worker&url` specifier before any test
// module is imported. The chat DiffPreview (and WorkerHighlightedCode) import
// it via markdown-worker.ts; under bun test the specifier resolves to an empty
// module with no default export. The worker is only used for syntax
// highlighting and is irrelevant to the tests that render these components.
const { mock } = await import('bun:test');
mock.module(
  new URL('./src/components/chat/markdown/markdown-shiki.worker.ts?worker&url', import.meta.url).href,
  () => ({ default: 'mock-worker-url' }),
);
