import { packageConfig } from "../../vite.package.ts";

// `.` is the app surface, `./internal` the engine seams for adapter authors
// (ADR-0022), `./sql` the SQL reference backend (ADR-0033).
export default packageConfig({
  entries: { index: "src/index.ts", internal: "src/internal.ts", "sql/index": "src/sql/index.ts" },
});
