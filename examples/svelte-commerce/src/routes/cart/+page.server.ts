/**
 * Cart load + no-JS actions, all through the JSON:API: lines with their
 * variants included; remove and place-order as plain form posts (the order
 * is recomputed server-side from the authoritative cart either way).
 */
import type { Actions, PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { Effect } from "effect";
import { cartItemId } from "../../../server/jsonapi.js";

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user === undefined) return { lines: [], variants: [] };
  const cart = await Effect.runPromise(
    locals.api.cartItems
      .list({ query: { include: ["variant"] } })
      .pipe(Effect.catchTag("Unauthorized", () => Effect.succeed({ data: [], included: [] })))
  );
  return { lines: cart.data, variants: cart.included ?? [] };
};

export const actions: Actions = {
  remove: async ({ request, locals }) => {
    if (locals.user === undefined) redirect(303, "/account");
    const form = await request.formData();
    await Effect.runPromise(
      locals.api.cartItems.delete({ params: { id: cartItemId(String(form.get("id") ?? "")) } })
    );
    redirect(303, "/cart");
  },
  placeOrder: async ({ locals }) => {
    if (locals.user === undefined) redirect(303, "/account");
    await Effect.runPromise(
      locals.api.orders
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
