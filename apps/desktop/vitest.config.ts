import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

const PERF_TESTS = 'src/**/*.perf.test.{ts,tsx}';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      // UI flows render the whole workbench in jsdom and take seconds on a busy machine; the 5 s
      // default turns load into failures. Budget tests measure their own timings.
      testTimeout: 20_000,
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            exclude: [...configDefaults.exclude, PERF_TESTS],
            sequence: { groupOrder: 0 },
          },
        },
        {
          // Wall-clock budgets run after every other test, one file at a time, so parallel
          // workers do not skew their timings.
          extends: true,
          test: {
            name: 'perf',
            include: [PERF_TESTS],
            fileParallelism: false,
            sequence: { groupOrder: 1 },
          },
        },
      ],
    },
  }),
);
