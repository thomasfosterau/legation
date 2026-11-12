/**
 * The root SSR load: the session user (Better Auth, resolved by hooks), the
 * browser's client group (read-or-mint cookie), and the app shell's SSR
 * snapshot (#146, `server/snapshot.ts`): the rows the shell keeps live and
 * the CVR cookie they were pulled at, under that group. The tab hands the
 * snapshot to the service worker's engine, which hydrates an empty replica
 * with it; the catalog page renders its first paint from it.
 */
import type { LayoutServerLoad } from "./$types";
import { clientGroupId } from "@thomasfosterau/legation-svelte/kit";
import { shellSnapshot } from "../../server/snapshot.js";

export const load: LayoutServerLoad = async ({ cookies, locals }) => ({
  user: locals.user,
  clientGroupId: clientGroupId(cookies),
  snapshot: await shellSnapshot(cookies, locals.user?.id),
});
