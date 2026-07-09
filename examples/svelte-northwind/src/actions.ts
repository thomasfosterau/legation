/**
 * Actions — the write surface
 *
 * Thin wrappers over `getMutate()`. Each is optimistic: the grid updates before
 * any round trip, the same intent replays on rebase, and the backend applies it
 * authoritatively (the read-merge mutators look the row up first). Northwind has
 * no auth, so these are unbound and need no session.
 */
import { Mutation } from "@legation/svelte";
import type { Product, ProductPatchType } from "./domain";

export interface Actions {
  readonly updateProduct: (patch: ProductPatchType) => Promise<void>;
  readonly createProduct: (product: Product) => Promise<void>;
  readonly deleteProduct: (id: string) => Promise<void>;
  readonly createCategory: (input: { id: string; name: string; description: string }) => Promise<void>;
  readonly shipOrder: (id: string) => Promise<void>;
}

export const getActions = (): Actions => {
  const mutate = Mutation.getMutate();
  return {
    updateProduct: (patch) => mutate("product/update", patch),
    createProduct: (product) => mutate("product/create", product),
    deleteProduct: (id) => mutate("product/delete", { id }),
    createCategory: (input) => mutate("category/create", input),
    shipOrder: (id) => mutate("order/ship", { id, shippedAt: Date.now() }),
  };
};
