/**
 * The root SSR load: resolve the browser's client group (cookie), read its
 * signed-in user (if any), and snapshot everything the shell needs — the
 * public catalog plus, when signed in, the user's private subsets. The
 * snapshot's CVR cookie continues the conversation on the client's first
 * pull; with JavaScript disabled this load IS the app's read path.
 */
import type { LayoutServerLoad } from "./$types";
import { Effect } from "effect";
import { Transport } from "@legation/effect";
import { loadSnapshot } from "@legation/sveltekit";
import { mutators, shellSubsets } from "../lib/domain.js";

export const load: LayoutServerLoad = async ({ cookies, locals }) => {
  const snapshotFor = (userId: string | undefined) =>
    Effect.runPromise(
      loadSnapshot(cookies, { subsets: shellSubsets(userId), mutators }).pipe(
        Effect.provideService(Transport.ServerHandler, locals.handler)
      )
    );

  const anonymous = await snapshotFor(undefined);
  const userId = await locals.userFor(anonymous.clientGroupId);
  if (userId === undefined) return { ...anonymous, userId: undefined };
  // Signed in: re-snapshot including the private subsets (same group, so
  // the cookie still continues the CVR conversation).
  const withPrivate = await snapshotFor(userId);
  return { ...withPrivate, userId };
};
