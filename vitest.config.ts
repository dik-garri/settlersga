import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/; their copies of the tests must not run here.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
    // Long simulations (hour-long economies, AI matches) exceed the 5 s default on a busy machine.
    testTimeout: 60_000,
  },
});
