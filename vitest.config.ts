import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Route every outbound fetch from the Worker (and its Durable Objects) to the mock Garmin
        // worker below, so tests never touch Garmin Connect or the consumer-key document.
        outboundService: "garmin-mock",
        workers: [
          {
            name: "garmin-mock",
            modules: true,
            scriptPath: "./test/garmin-mock.worker.js",
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
