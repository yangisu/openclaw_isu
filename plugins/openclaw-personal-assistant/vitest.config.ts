import { defineConfig } from 'vitest/config';

// Git and SQLite integration tests contend on Windows under multi-file parallelism.
export default defineConfig({
  test: {
    fileParallelism: false,
    maxWorkers: 1,
  },
});
