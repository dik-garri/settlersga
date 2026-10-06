import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/; their copies of the tests must not run here.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
});
