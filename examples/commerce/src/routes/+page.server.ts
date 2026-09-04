/**
 * Catalog load — the naive experience reads the JSON:API by the same
 * declarative reads the page keeps live: the first catalog page
 * (`productPage`), the categories, and the variants the stock badges sum.
 * Each is fetched at its canonical URL, so the SSR request and the tab's
 * later subscription are one string. The `?category=` search param is the
 * no-JS filter; the enhanced tier reuses the same URL as its reactive input,
 * so both tiers share one navigation model.
 */
import type { PageServerLoad } from "./$types";
import { Effect } from "effect";
import { allCategories, allVariants, productPage } from "../lib/domain.js";
import { readCollection } from "../../server/client.js";
import { Category, Product, Variant } from "../../server/resources.js";

export const load = (async ({ locals, url }) => {
  const categoryId = url.searchParams.get("category") ?? undefined;
  const user = locals.user?.id;
  const [products, categories, variants] = await Promise.all([
    Effect.runPromise(readCollection(user, Product.collection(), productPage({ categoryId }))),
    Effect.runPromise(readCollection(user, Category.collection(), allCategories)),
    Effect.runPromise(readCollection(user, Variant.collection(), allVariants)),
  ]);
  return {
    categoryId,
    products: products.data,
    variants: variants.data,
    categories: categories.data,
  };
}) satisfies PageServerLoad;
