import { packageConfig } from "../../vite.package.ts";

// `.` is the app surface, `./internal` the engine seams for adapter authors
// (ADR-0022).
export default packageConfig({
  entries: { index: "src/index.ts", internal: "src/internal.ts" },
});
