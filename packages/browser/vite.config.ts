import { packageConfig } from "../../vite.package.ts";

// `.` is every browser adapter; `./http-cache` the Cache API HTTP cache alone,
// for a service worker that doesn't run the engine.
export default packageConfig({
  entries: {
    index: "src/index.ts",
    "http-cache": "src/http-cache.ts",
    IndexedDbClientStore: "src/IndexedDbClientStore.ts",
    BroadcastMirrorChannel: "src/BroadcastMirrorChannel.ts",
    ServiceWorkerHost: "src/ServiceWorkerHost.ts",
    ElectedHost: "src/ElectedHost.ts",
    CacheApiHttpCache: "src/CacheApiHttpCache.ts",
    HttpCacheInvalidation: "src/HttpCacheInvalidation.ts",
    BrowserConnectivity: "src/BrowserConnectivity.ts",
    BackgroundSync: "src/BackgroundSync.ts",
    PushPoke: "src/PushPoke.ts",
  },
});
