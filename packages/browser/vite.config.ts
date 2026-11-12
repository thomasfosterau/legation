import { packageConfig } from "../../vite.package.ts";

// `.` is every browser adapter; `./http-cache` the Cache API HTTP cache alone,
// for a service worker that doesn't run the engine (#678).
export default packageConfig({
  entries: { index: "src/index.ts", "http-cache": "src/http-cache.ts" },
  unbundle: true,
});
