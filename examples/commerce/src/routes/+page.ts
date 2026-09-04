/**
 * Catalog load — universal (#168): it runs on the server for the first
 * render (the no-JS baseline, unchanged) and in the browser on client
 * navigation, where its plain `fetch` of the JSON:API is what the service
 * worker's façade intercepts (ADR-0029). Both tiers read the same
 * declarative reads the page keeps live — one catalog page
 * (`productPage`), the categories, and the variants the stock badges sum —
 * each at its canonical URL (`readPath`), so the SSR request, the tab's
 * subscription and the façade's lookup are one string: the first page
 * (`/jsonapi/products?page[limit]=4&sort=id`) is a prefix of the shell's
 * products pin and is served from the replica; a category page is not
 * (ADR-0029 §3, the strict window) and goes to the network unchanged.
 *
 * The `?category=` and `?after=` search params are the no-JS filter and
 * cursor — plain links the page renders; the enhanced tier reuses the same
 * URL as its reactive input, so both tiers page one read. The document's
 * `links.next` says whether there is a next page; the last row's id is the
 * cursor it continues from.
 */
import type { PageLoad } from "./$types";
import { allCategories, allVariants, productPage } from "../lib/domain.js";
import { readCollection } from "../lib/reads.js";
import { Category, Product, Variant } from "../../server/resources.js";

export const load = (async ({ fetch, url }) => {
  const categoryId = url.searchParams.get("category") ?? undefined;
  const after = url.searchParams.get("after") ?? undefined;
  const [products, categories, variants] = await Promise.all([
    readCollection(fetch, Product.collection(), productPage({ categoryId, cursor: after })),
    readCollection(fetch, Category.collection(), allCategories),
    readCollection(fetch, Variant.collection(), allVariants),
  ]);
  return {
    categoryId,
    after,
    nextCursor: products.links?.next == null ? undefined : products.data.at(-1)?.id,
    products: products.data,
    variants: variants.data,
    categories: categories.data,
  };
}) satisfies PageLoad;
