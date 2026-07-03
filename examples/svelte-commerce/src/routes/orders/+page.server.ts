/** Orders load — the naive tier's read, straight from the JSON:API. */
import type { PageServerLoad } from "./$types";
import { Effect } from "effect";

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user === undefined) return { orders: [] };
  const orders = await Effect.runPromise(
    locals.api.orders
      .list({ query: {} })
      .pipe(Effect.catchTag("Unauthorized", () => Effect.succeed({ data: [] })))
  );
  return { orders: orders.data };
};
