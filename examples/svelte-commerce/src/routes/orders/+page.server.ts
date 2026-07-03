/** Orders load — the naive tier's read, straight from the JSON:API. */
import type { PageServerLoad } from "./$types";
import { Effect } from "effect";
import { apiFor } from "../../../server/client.js";

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user === undefined) return { orders: [] };
  const api = await Effect.runPromise(apiFor(locals.user.id));
  const orders = await Effect.runPromise(
    api.orders
      .list({ query: {} })
      .pipe(Effect.catchTag("Unauthorized", () => Effect.succeed({ data: [] })))
  );
  return { orders: orders.data };
};
