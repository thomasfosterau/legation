/**
 * Product detail — the naive tier loads the product (variants included) and
 * its reviews from the JSON:API; the no-JS forms write back through it
 * (cart add, review post). Signed-out writes bounce to /account.
 */
import type { Actions, PageServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { Effect } from "effect";
import { apiFor, run } from "../../../../server/client.js";
import { productId, variantId } from "../../../../server/jsonapi.js";

export const load: PageServerLoad = async ({ locals, params }) => {
  const api = await Effect.runPromise(apiFor(locals.user?.id));
  const [product, reviews] = await Promise.all([
    run(
      api.products.get({ params: { id: productId(params.id) }, query: { include: ["variants"] } }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined))
      )
    ),
    Effect.runPromise(api.reviews.list({ query: { filter: { productId: params.id } } })),
  ]);
  if (product?.data == null) error(404, "no such product");
  return {
    product: product.data,
    variants: product.included ?? [],
    reviews: reviews.data,
  };
};

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
