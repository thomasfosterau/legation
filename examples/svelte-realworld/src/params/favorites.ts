/**
 * Route-param matcher for the profile's article tab.
 *
 * A profile is `/profile/:username` (their articles) with one optional extra
 * segment, `/favorites`. Constraining the param to that single literal means
 * `/profile/emma/anything-else` 404s instead of quietly rendering the profile.
 */
import type { ParamMatcher } from "@sveltejs/kit";

export const match: ParamMatcher = (param) => param === "favorites";
