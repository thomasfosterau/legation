/**
 * The root SSR load: the session user (Better Auth, resolved by hooks) and
 * the browser's client group (read-or-mint cookie). Content loads live on
 * each page, against the JSON:API — this layout only supplies the shell.
 */
import type { LayoutServerLoad } from "./$types";
import { clientGroupId } from "@thomasfosterau/legation-svelte/kit";

export const load: LayoutServerLoad = ({ cookies, locals }) => ({
  user: locals.user,
  clientGroupId: clientGroupId(cookies),
});
