/**
 * Actions — the write surface
 *
 * Thin wrappers over `useMutation()`. Each is optimistic: the grid updates
 * before any round trip, the same intent replays on rebase, and the backend
 * applies it authoritatively (the read-merge mutators look the row up first).
 */
import * as React from "react";
import { useMutation } from "@legation/react";
import type { Product, ProductPatchType } from "./domain";

export interface Actions {
  readonly updateProduct: (patch: ProductPatchType) => void;
  readonly createProduct: (product: Product) => void;
  readonly deleteProduct: (id: string) => void;
  readonly createCategory: (input: { id: string; name: string; description: string }) => void;
  readonly shipOrder: (id: string) => void;
}

export const useActions = (): Actions => {
  const mutate = useMutation();
  return React.useMemo(
    () => ({
      updateProduct: (patch) => mutate("product/update", patch),
      createProduct: (product) => mutate("product/create", product),
      deleteProduct: (id) => mutate("product/delete", { id }),
      createCategory: (input) => mutate("category/create", input),
      shipOrder: (id) => mutate("order/ship", { id, shippedAt: Date.now() }),
    }),
    [mutate]
  );
};
