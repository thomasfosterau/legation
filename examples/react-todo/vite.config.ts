import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The React plugin handles JSX/Fast Refresh; the engine and its React bindings
// are consumed from `../../packages/*` as built dependencies (`workspace:*`).
export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
});
