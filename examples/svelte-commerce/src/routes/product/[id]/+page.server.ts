/**
 * No-JS add-to-cart: a plain form post that writes SQLite directly in the
 * Kit process. From the sync server's perspective this is an out-of-band
 * writer — no mutator ran, no hint was published in ITS process — so the
 * polling hint source (ADR-0019 tier 2) is what pokes live clients about it.
 * The next full-page load re-snapshots regardless (pull is the correctness
 * path).
 */
import type { Actions } from "./$types";
import { redirect } from "@sveltejs/kit";
import { clientGroupId } from "@legation/sveltekit";

export const actions: Actions = {
  addToCart: async ({ request, cookies, locals }) => {
    const group = clientGroupId(cookies);
    const bound = locals.db
      .prepare("SELECT userId FROM client_groups WHERE clientGroupId = ?")
      .get(group) as { userId: string } | undefined;
    if (bound === undefined) redirect(303, "/account");
    const form = await request.formData();
    const variantId = String(form.get("variantId") ?? "");
    locals.db
      .prepare("INSERT INTO cartItems (id, userId, variantId, qty) VALUES (?, ?, ?, 1)")
      .run(`ci-${crypto.randomUUID()}`, bound.userId, variantId);
    redirect(303, "/cart");
  },
};
