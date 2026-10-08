/**
 * Route-param matchers for the app.
 *
 * `/active` and `/completed` are filtered views of the same list and `/` (the
 * optional param omitted) is "all"; anything else is not a filter, so the
 * matcher rejects it and SvelteKit 404s instead of silently showing everything.
 */
import { defineParams } from "@sveltejs/kit/params";

export const params = defineParams({
  filter: (param) => (param === "active" || param === "completed" ? param : undefined),
});
