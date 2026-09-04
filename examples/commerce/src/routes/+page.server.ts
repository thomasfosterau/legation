/**
 * Catalog load — the naive experience reads the JSON:API by the same
 * declarative reads the page keeps live: one catalog page (`productPage`),
 * the categories, and the variants the stock badges sum. Each is fetched at
 * its canonical URL, so the SSR request and the tab's later subscription
 * are one string. The `?category=` and `?after=` search params are the
 * no-JS filter and cursor — plain links the page renders; the enhanced tier
 * reuses the same URL as its reactive input, so both tiers page one read.
 * The document's `links.next` says whether there is a next page; the last
 * row's id is the cursor it continues from.
 */
import type { PageServerLoad } from "./$types";
import { Effect } from "effect";
import { allCategories, allVariants, productPage } from "../lib/domain.js";
import { readCollection } from "../../server/client.js";
import { Category, Product, Variant } from "../../server/resources.js";

export const load = (async ({ locals, url }) => {
  const categoryId = url.searchParams.get("category") ?? undefined;
  const after = url.searchParams.get("after") ?? undefined;
  const user = locals.user?.id;
  const [products, categories, variants] = await Promise.all([
    Effect.runPromise(
      readCollection(user, Product.collection(), productPage({ categoryId, cursor: after }))
    ),
    Effect.runPromise(readCollection(user, Category.collection(), allCategories)),
    Effect.runPromise(readCollection(user, Variant.collection(), allVariants)),
  ]);
  return {
    categoryId,
    after,
    nextCursor: products.links?.next == null ? undefined : products.data.at(-1)?.id,
    products: products.data,
    variants: variants.data,
    categories: categories.data,
  };
}) satisfies PageServerLoad;
