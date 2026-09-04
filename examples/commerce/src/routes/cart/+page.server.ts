/**
 * Cart load + no-JS actions, all through the JSON:API: the lines with their
 * variants included (`myCartItems`, at its canonical URL — the read the
 * page keeps live); remove and place-order as plain form posts through the
 * typed client (the order is recomputed server-side from the authoritative
 * cart either way).
 */
import type { Actions, PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { Effect } from "effect";
import { myCartItems } from "../../lib/domain.js";
import { apiFor, readCollection, run } from "../../../server/client.js";
import { cartItemId } from "../../../server/jsonapi.js";
import { CartItem } from "../../../server/resources.js";

export const load = (async ({ locals }) => {
  if (locals.user === undefined) return { lines: [], variants: [] };
  const cart = await Effect.runPromise(
    readCollection(locals.user.id, CartItem.collection(), myCartItems(locals.user.id))
  );
  return { lines: cart.data, variants: cart.included ?? [] };
}) satisfies PageServerLoad;

export const actions: Actions = {
  remove: async ({ request, locals }) => {
    if (locals.user === undefined) redirect(303, "/account");
    const api = await Effect.runPromise(apiFor(locals.user.id));
    const form = await request.formData();
    await run(api.cartItems.delete({ params: { id: cartItemId(String(form.get("id") ?? "")) } }));
    redirect(303, "/cart");
  },
  placeOrder: async ({ locals }) => {
    if (locals.user === undefined) redirect(303, "/account");
    const api = await Effect.runPromise(apiFor(locals.user.id));
    await Effect.runPromise(
      api.orders
        .create({
          payload: {
            data: {
              type: "orders",
              attributes: {
                status: "placed",
                totalCents: 0, // authoritative values are recomputed server-side
                createdAt: new Date().toISOString(),
              },
              relationships: {},
            },
          },
        })
        .pipe(Effect.catchTag("BadRequest", () => Effect.succeed(undefined)))
    );
    redirect(303, "/orders");
  },
};
