// Runs test/browser in real browsers through Playwright. Vite resolves the
// package's "browser" conditions and emits zstd.wasm as an asset, the way an
// application bundler would.
//   BROWSERS=chromium,firefox,webkit npx vitest run -c vitest.browser.config.ts
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const browsers = (process.env['BROWSERS'] ?? 'chromium').split(',') as ('chromium' | 'firefox' | 'webkit')[];

export default defineConfig({
  test: {
    include: ['test/browser/**/*.test.ts'],
    testTimeout: 60_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: browsers.map((browser) => ({ browser })),
    },
  },
});
