/**
 * Orders load — the naive tier's read, straight from the JSON:API at the
 * canonical URL of `myOrders` (newest first), the read the page keeps live.
 */
import type { PageServerLoad } from "./$types";
import { Effect } from "effect";
import { myOrders } from "../../lib/domain.js";
import { readCollection } from "../../../server/client.js";
import { Order } from "../../lib/resources.js";

export const load = (async ({ locals }) => {
  if (locals.user === undefined) return { orders: [] };
  const orders = await Effect.runPromise(
    readCollection(locals.user.id, Order.collection(), myOrders(locals.user.id))
  );
  return { orders: orders.data };
}) satisfies PageServerLoad;
