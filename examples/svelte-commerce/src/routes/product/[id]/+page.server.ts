/**
 * No-JS add-to-cart: a plain form post that commits through the sync
 * server's cart API (ADR-0019's out-of-band writer, done right: the write
 * lands in the process whose invalidation bus pokes live clients, so no
 * polling round-trip is needed). The next full-page load re-snapshots
 * regardless (pull is the correctness path).
 */
import type { Actions } from "./$types";
import { redirect } from "@sveltejs/kit";
import { Effect } from "effect";
import { clientGroupId } from "@legation/sveltekit";

export const actions: Actions = {
  addToCart: async ({ request, cookies, locals }) => {
    const form = await request.formData();
    const variantId = String(form.get("variantId") ?? "");
    const result = await Effect.runPromise(
      locals.api.cart.add({ payload: { clientGroupId: clientGroupId(cookies), variantId } }).pipe(
        Effect.map(() => "ok" as const),
        Effect.catchTag("Unauthorized", () => Effect.succeed("anonymous" as const))
      )
    );
    if (result === "anonymous") redirect(303, "/account");
    redirect(303, "/cart");
  },
};
