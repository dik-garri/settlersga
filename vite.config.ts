import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { localisedPage } from './tools/pageLocale';

/** The commit the build is made from: network games let in only browsers running the same build. */
function commit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev';
  } catch {
    return 'dev';
  }
}

/** `en/index.html` and `de/index.html`: the page with its title and link preview in that language (tools/pageLocale.ts). */
function pageLocales(): Plugin {
  return {
    name: 'page-locales',
    apply: 'build',
    // After the build is on disk: the HTML plugin writes index.html last.
    writeBundle(options) {
      const dir = options.dir ?? 'dist';
      const html = readFileSync(join(dir, 'index.html'), 'utf8');
      for (const lang of ['en', 'de'] as const) {
        mkdirSync(join(dir, lang), { recursive: true });
        writeFileSync(join(dir, lang, 'index.html'), localisedPage(html, lang));
      }
    },
  };
}

export default defineConfig({
  // Relative asset paths, so the build works from any sub-path (GitHub Pages serves it under /<repo>/).
  base: './',
  define: { __BUILD_ID__: JSON.stringify(commit()) },
  plugins: [pageLocales()],
});
