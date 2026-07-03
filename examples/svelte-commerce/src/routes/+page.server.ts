/**
 * Catalog load — the naive experience reads the JSON:API (products with
 * their variants included, plus categories). The `?category=` search param
 * is the no-JS filter; the enhanced tier reuses the same URL as its
 * reactive input, so both tiers share one navigation model.
 */
import type { PageServerLoad } from "./$types";
import { Effect } from "effect";
import { apiFor } from "../../server/client.js";

export const load: PageServerLoad = async ({ locals, url }) => {
  const categoryId = url.searchParams.get("category") ?? undefined;
  const api = await Effect.runPromise(apiFor(locals.user?.id));
  const [products, categories] = await Promise.all([
    Effect.runPromise(
      api.products.list({
        query: {
          include: ["variants"],
          ...(categoryId === undefined ? {} : { filter: { categoryId } }),
        },
      })
    ),
    Effect.runPromise(api.categories.list({ query: {} })),
  ]);
  return {
    categoryId,
    products: products.data,
    variants: products.included ?? [],
    categories: categories.data,
  };
};
