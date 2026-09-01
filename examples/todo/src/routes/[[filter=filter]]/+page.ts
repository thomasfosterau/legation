/**
 * The filter is the URL. One optional, matched route param (`filter.ts`)
 * serves all three views — `/`, `/active`, `/completed` — so the tabs are
 * plain links, the browser's back button works, and a filtered list is
 * shareable. This load turns the raw param into the label the page renders.
 */
import type { PageLoad } from "./$types";

export type Filter = "All" | "Active" | "Completed";

export const load: PageLoad = ({ params }): { filter: Filter } => ({
  filter:
    params.filter === "active" ? "Active" : params.filter === "completed" ? "Completed" : "All",
});
