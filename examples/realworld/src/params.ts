/**
 * Route-param matchers for the app.
 *
 * A profile is `/profile/:username` (their articles) with one optional extra
 * segment, `/favorites`. Constraining the param to that single literal means
 * `/profile/emma/anything-else` 404s instead of quietly rendering the profile.
 */
import { defineParams } from "@sveltejs/kit/params";

export const params = defineParams({
  favorites: (param) => (param === "favorites" ? param : undefined),
});
