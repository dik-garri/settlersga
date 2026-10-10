import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

/** The commit the build is made from: network games let in only browsers running the same build. */
function commit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev';
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  // Relative asset paths, so the build works from any sub-path (GitHub Pages serves it under /<repo>/).
  base: './',
  define: { __BUILD_ID__: JSON.stringify(commit()) },
});
