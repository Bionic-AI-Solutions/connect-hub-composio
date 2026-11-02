import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PGlite (Postgres in WASM) takes a few seconds to boot the first time in each worker.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
  },
});
