// Vitest no-op stub for Next.js `server-only` sentinel. See
// vitest.config.ts alias for wiring. The real `server-only` throws
// when imported from a client bundle; tests run server code directly
// in Node, so an empty export is all we need.
export {};
