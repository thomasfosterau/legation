/**
 * JSON:API resources → engine row seeds.
 *
 * The SSR pages load JSON:API documents (the naive experience). When the
 * sync tier enhances a page, its live hooks want `initial` seeds in the
 * engine's row shape — `{ id, value }` with foreign keys inlined the way
 * the sync collections store them. These mappers translate the resources a
 * load already fetched, so the first client render matches the server
 * markup with zero extra requests.
 */

interface ResourceLike {
  readonly id: string;
  readonly attributes: Record<string, unknown>;
  readonly relationships?: Record<
    string,
    { readonly data?: { readonly id: string } | ReadonlyArray<{ readonly id: string }> | null }
  >;
}

export interface RowSeed {
  readonly id: string;
  readonly value: unknown;
  /** Included edges, when the seed feeds a read with `include`. */
  readonly related: Record<string, unknown>;
}

const refId = (resource: ResourceLike, name: string): string | undefined => {
  const data = resource.relationships?.[name]?.data;
  if (data === null || data === undefined || Array.isArray(data)) return undefined;
  return (data as { readonly id: string }).id;
};

/** Inline the given to-one relationships as `<name>Id` foreign keys. */
export const toRow = (resource: ResourceLike, refs: ReadonlyArray<string> = []): RowSeed => ({
  id: resource.id,
  value: {
    id: resource.id,
    ...resource.attributes,
    ...Object.fromEntries(
      refs.flatMap((name) => {
        const id = refId(resource, name);
        return id === undefined ? [] : [[`${name}Id`, id]];
      })
    ),
  },
  related: {},
});

export const productRows = (resources: ReadonlyArray<ResourceLike>): ReadonlyArray<RowSeed> =>
  resources.map((resource) => toRow(resource, ["category", "seller"]));

export const variantRows = (resources: ReadonlyArray<ResourceLike>): ReadonlyArray<RowSeed> =>
  resources.map((resource) => toRow(resource, ["product"]));

export const sellerRows = (resources: ReadonlyArray<ResourceLike>): ReadonlyArray<RowSeed> =>
  resources.map((resource) => toRow(resource));

export const reviewRows = (resources: ReadonlyArray<ResourceLike>): ReadonlyArray<RowSeed> =>
  resources.map((resource) => toRow(resource, ["product"]));

export const cartItemRows = (resources: ReadonlyArray<ResourceLike>): ReadonlyArray<RowSeed> =>
  resources.map((resource) => toRow(resource, ["variant"]));

export const orderRows = (resources: ReadonlyArray<ResourceLike>): ReadonlyArray<RowSeed> =>
  resources.map((resource) => toRow(resource));

export const orderItemRows = (resources: ReadonlyArray<ResourceLike>): ReadonlyArray<RowSeed> =>
  resources.map((resource) => toRow(resource, ["order", "variant"]));
