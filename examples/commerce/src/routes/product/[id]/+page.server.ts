/**
 * Product detail — the naive tier loads the product with its detail edges
 * (`productDetail`: variants and seller included) and its reviews
 * (`productReviews`, newest first) from the JSON:API at their canonical
 * URLs — the reads the page's live hooks subscribe to. A product the read
 * does not match is the page's 404. The no-JS forms write back through the
 * typed client (cart add, review post); signed-out writes bounce to
 * /account.
 */
import type { Actions, PageServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { Effect } from "effect";
import { productDetail, productReviews } from "../../../lib/domain.js";
import { apiFor, readCollection } from "../../../../server/client.js";
import { productId, variantId } from "../../../../server/jsonapi.js";
import { Product, Review, Seller, Variant } from "../../../../server/resources.js";

export const load = (async ({ locals, params }) => {
  const user = locals.user?.id;
  const [detail, reviews] = await Promise.all([
    Effect.runPromise(readCollection(user, Product.collection(), productDetail(params.id))),
    Effect.runPromise(readCollection(user, Review.collection(), productReviews(params.id))),
  ]);
  const product = detail.data[0];
  if (product === undefined) error(404, "no such product");
  const included = detail.included ?? [];
  return {
    product,
    variants: included.filter((resource): resource is typeof Variant.Type => resource.type === "variants"),
    seller: included.find((resource): resource is typeof Seller.Type => resource.type === "sellers"),
    reviews: reviews.data,
  };
}) satisfies PageServerLoad;

export const actions: Actions = {
  addToCart: async ({ request, locals }) => {
    if (locals.user === undefined) redirect(303, "/account");
    const api = await Effect.runPromise(apiFor(locals.user.id));
    const form = await request.formData();
    const variantIdRaw = String(form.get("variantId") ?? "");
    await Effect.runPromise(
      api.cartItems
        .create({
          payload: {
            data: {
              type: "cartItems",
              attributes: { qty: 1 },
              relationships: { variant: { data: { type: "variants", id: variantId(variantIdRaw) } } },
            },
          },
        })
        .pipe(Effect.catchTag("BadRequest", () => Effect.succeed(undefined)))
    );
    redirect(303, "/cart");
  },
  review: async ({ request, locals, params }) => {
    if (locals.user === undefined) redirect(303, "/account");
    const api = await Effect.runPromise(apiFor(locals.user.id));
    const form = await request.formData();
    await Effect.runPromise(
      api.reviews.create({
        payload: {
          data: {
            type: "reviews",
            attributes: {
              authorName: locals.user.name,
              rating: Number(form.get("rating") ?? 5),
              body: String(form.get("body") ?? ""),
              createdAt: new Date().toISOString(),
            },
            relationships: { product: { data: { type: "products", id: productId(params.id) } } },
          },
        },
      })
    );
    redirect(303, `/product/${params.id}`);
  },
};
