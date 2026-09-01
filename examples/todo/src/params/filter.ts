/**
 * Route-param matcher for the todo filter.
 *
 * `/active` and `/completed` are filtered views of the same list and `/` (the
 * optional param omitted) is "all"; anything else is not a filter, so the
 * matcher rejects it and SvelteKit 404s instead of silently showing everything.
 */
import type { ParamMatcher } from "@sveltejs/kit";

export const match: ParamMatcher = (param) => param === "active" || param === "completed";
