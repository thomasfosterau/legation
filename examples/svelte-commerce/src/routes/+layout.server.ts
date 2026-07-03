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
import {
  allCategories,
  allSellers,
  allVariants,
  allReviews,
  mutators,
  myCartItems,
  myOrderItems,
  myOrders,
  myProfile,
  productPage,
} from "../lib/domain.js";

const currentUser = (db: App.Locals["db"], clientGroupId: string): string | undefined => {
  const row = db
    .prepare("SELECT userId FROM client_groups WHERE clientGroupId = ?")
    .get(clientGroupId) as { userId: string } | undefined;
  return row?.userId;
};

export const load: LayoutServerLoad = async ({ cookies, locals }) => {
  const program = Effect.gen(function* () {
    const shellSubsets = [
      productPage({ limit: 100 }),
      allCategories,
      allSellers,
      allVariants,
      allReviews,
    ];
    const first = yield* loadSnapshot(cookies, { subsets: shellSubsets, mutators });
    const userId = currentUser(locals.db, first.clientGroupId);
    if (userId === undefined) return { ...first, userId: undefined };
    // Signed in: re-snapshot including the private subsets (same group, so
    // the cookie still continues the CVR conversation).
    const withPrivate = yield* loadSnapshot(cookies, {
      subsets: [
        ...shellSubsets,
        myCartItems(userId),
        myOrders(userId),
        myOrderItems(userId),
        myProfile(userId),
      ],
      mutators,
    });
    return { ...withPrivate, userId };
  }).pipe(Effect.provideService(Transport.ServerHandler, locals.handler));

  const { snapshot, clientGroupId, userId } = await Effect.runPromise(program);
  return { snapshot, clientGroupId, userId };
};
