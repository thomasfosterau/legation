/**
 * Data layer — base collection stores + derived relational views
 *
 * Two shapes live here:
 *
 * - **Base collection stores** (`query(subset)` → typed `Readable`), one per
 *   collection, for the screens that read a single collection (Products,
 *   Suppliers) and for the per-order line-item lookup.
 * - **Derived views** built with the `Derive` combinators (`@legation/effect`'s
 *   client-local query tier, ADR-0027): the orders join/group screen, the
 *   category product-counts, and the customer order-counts are no longer
 *   hand-rolled `Map`-joins re-run on every render — they are join/groupBy
 *   pipelines the engine maintains **incrementally** from row deltas, exposed
 *   as Svelte stores through the same `observe`→`Readable` bridge `query` uses
 *   (so "framework bindings need nothing new"). A derived view sees only the
 *   already-synced rows; it never widens what syncs (the boundary rule).
 *
 * Presentation order stays a component concern (`$derived` sorts for display) —
 * the derived stores carry the incrementally-maintained *set*; the screen
 * orders it.
 */
import { readable, derived, type Readable } from "svelte/store";
import { getContext, setContext } from "svelte";
import { Effect, Fiber, Stream } from "effect";
import { Query, Runtime } from "@legation/svelte";
import { ClientView, Derive } from "@legation/effect/internal";
import {
  allCategories,
  allCustomers,
  allEmployees,
  allOrderDetails,
  allOrders,
  allProducts,
  allSuppliers,
} from "./domain";
import type {
  Category,
  Customer,
  Employee,
  Order,
  OrderDetail,
  Product,
  Supplier,
} from "./domain";

export interface ProductView {
  readonly product: Product;
  readonly categoryName: string;
  readonly supplierCompany: string;
}
export interface OrderView {
  readonly order: Order;
  readonly customerCompany: string;
  readonly employeeName: string;
  readonly lineCount: number;
  readonly total: number;
}
export interface OrderLine {
  readonly detail: OrderDetail;
  readonly productName: string;
}
export interface CategoryCount {
  readonly category: Category;
  readonly count: number;
}
export interface CustomerCount {
  readonly customer: Customer;
  readonly orders: number;
}
export interface ProductFilter {
  readonly search: string;
  readonly categoryId: string | null;
}

export const lineTotal = (d: OrderDetail): number =>
  d.unitPrice * d.quantity * (1 - d.discount);

// ─── The observe → Readable bridge for a derived pipeline ────────────────────
//
// The mirror image of `@legation/svelte`'s `query` store, but over a `Derive`
// pipeline instead of a raw subset: fork the pipeline's stream, push each
// emission through `set`, interrupt on the last unsubscribe. The runtime is
// read during init (the `getContext` rule), so build these in `createData`.

const deriveStore = <T>(
  initial: T,
  build: (view: ClientView.Reader) => Stream.Stream<T, unknown>
): Readable<T> => {
  const runtime = Runtime.getEngineRuntime();
  return readable<T>(initial, (set) => {
    const run = Effect.flatMap(ClientView.ClientView, (view) =>
      Stream.runForEach(build(view), (value) => Effect.sync(() => set(value)))
    ).pipe(Effect.catchCause(() => Effect.void));
    const fiber = runtime.runFork(run);
    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
  });
};

/** Map a derived pipeline's `(id, value)` rows to their values for the store. */
const values = <T>(source: Derive.Source<unknown>): Stream.Stream<ReadonlyArray<T>, unknown> =>
  Stream.map(source, (rows) => rows.map((row) => row.value as T));

// ─── Data (base stores + derived views) ──────────────────────────────────────

export interface Data {
  readonly categories: Readable<ReadonlyArray<Category>>;
  readonly suppliers: Readable<ReadonlyArray<Supplier>>;
  readonly products: Readable<ReadonlyArray<Product>>;
  readonly customers: Readable<ReadonlyArray<Customer>>;
  readonly employees: Readable<ReadonlyArray<Employee>>;
  readonly orders: Readable<ReadonlyArray<Order>>;
  readonly orderDetails: Readable<ReadonlyArray<OrderDetail>>;
  /** orders ⋈ customers ⋈ employees ⋈ (orderDetails grouped + rolled up) — incremental. */
  readonly orderViews: Readable<ReadonlyArray<OrderView>>;
  /** categories ⋈ (products grouped by categoryId → count) — incremental. */
  readonly categoryCounts: Readable<ReadonlyArray<CategoryCount>>;
  /** customers ⋈ (orders grouped by customerId → count) — incremental. */
  readonly customerCounts: Readable<ReadonlyArray<CustomerCount>>;
}

/** Build the base stores + derived views. Call during init, after setEngineRuntime. */
export const createData = (): Data => ({
  // `query` is typed by `Subset.for(...)`, so `r.value` is the row type — no cast.
  categories: derived(Query.query(allCategories), (rows) => rows.map((r) => r.value)),
  suppliers: derived(Query.query(allSuppliers), (rows) => rows.map((r) => r.value)),
  products: derived(Query.query(allProducts), (rows) => rows.map((r) => r.value)),
  customers: derived(Query.query(allCustomers), (rows) => rows.map((r) => r.value)),
  employees: derived(Query.query(allEmployees), (rows) => rows.map((r) => r.value)),
  orders: derived(Query.query(allOrders), (rows) => rows.map((r) => r.value)),
  orderDetails: derived(Query.query(allOrderDetails), (rows) => rows.map((r) => r.value)),

  orderViews: deriveStore<ReadonlyArray<OrderView>>([], (view) => {
    // Roll each order's line items up into a per-order total, keyed by orderId.
    const lineTotals = Derive.map(
      Derive.groupBy(view.observe(allOrderDetails), (d) => (d as OrderDetail).orderId),
      (group) => {
        const g = group as { key: string; rows: ReadonlyArray<OrderDetail> };
        return {
          orderId: g.key,
          lineCount: g.rows.length,
          total: g.rows.reduce((sum, d) => sum + lineTotal(d), 0),
        };
      }
    );
    // orders left-joined to customers, then employees, then the roll-up —
    // each an arbitrary-key join, the chain composing combinator over combinator.
    const withCustomer = Derive.join(view.observe(allOrders), view.observe(allCustomers), {
      leftKey: (o) => (o as Order).customerId,
      rightKey: (c) => (c as Customer).id,
      kind: "left",
      combine: (o, c) => ({
        order: o as Order,
        customerCompany: c ? (c as Customer).company : (o as Order).customerId,
      }),
    });
    const withEmployee = Derive.join(withCustomer, view.observe(allEmployees), {
      leftKey: (v) => (v as { order: Order }).order.employeeId,
      rightKey: (e) => (e as Employee).id,
      kind: "left",
      combine: (v, e) => ({
        ...(v as { order: Order; customerCompany: string }),
        employeeName: e ? `${(e as Employee).firstName} ${(e as Employee).lastName}` : "—",
      }),
    });
    const withTotals = Derive.join(withEmployee, lineTotals, {
      leftKey: (v) => (v as { order: Order }).order.id,
      rightKey: (a) => (a as { orderId: string }).orderId,
      kind: "left",
      combine: (v, a): OrderView => {
        const base = v as { order: Order; customerCompany: string; employeeName: string };
        const agg = a as { lineCount: number; total: number } | null;
        return { ...base, lineCount: agg?.lineCount ?? 0, total: agg?.total ?? 0 };
      },
    });
    return values<OrderView>(withTotals);
  }),

  categoryCounts: deriveStore<ReadonlyArray<CategoryCount>>([], (view) => {
    const counts = Derive.map(
      Derive.groupBy(view.observe(allProducts), (p) => (p as Product).categoryId),
      (group) => {
        const g = group as { key: string; rows: ReadonlyArray<unknown> };
        return { categoryId: g.key, count: g.rows.length };
      }
    );
    const joined = Derive.join(view.observe(allCategories), counts, {
      leftKey: (c) => (c as Category).id,
      rightKey: (a) => (a as { categoryId: string }).categoryId,
      kind: "left",
      combine: (c, a): CategoryCount => ({
        category: c as Category,
        count: a ? (a as { count: number }).count : 0,
      }),
    });
    return values<CategoryCount>(joined);
  }),

  customerCounts: deriveStore<ReadonlyArray<CustomerCount>>([], (view) => {
    const counts = Derive.map(
      Derive.groupBy(view.observe(allOrders), (o) => (o as Order).customerId),
      (group) => {
        const g = group as { key: string; rows: ReadonlyArray<unknown> };
        return { customerId: g.key, orders: g.rows.length };
      }
    );
    const joined = Derive.join(view.observe(allCustomers), counts, {
      leftKey: (c) => (c as Customer).id,
      rightKey: (a) => (a as { customerId: string }).customerId,
      kind: "left",
      combine: (c, a): CustomerCount => ({
        customer: c as Customer,
        orders: a ? (a as { orders: number }).orders : 0,
      }),
    });
    return values<CustomerCount>(joined);
  }),
});

const DATA_KEY = Symbol("svelte-northwind/data");

export const setData = (data: Data): void => {
  setContext(DATA_KEY, data);
};

export const getData = (): Data => {
  const data = getContext<Data | undefined>(DATA_KEY);
  if (data === undefined) throw new Error("setData(data) must be called higher in the tree");
  return data;
};

// ─── Pure derivations that stay component-side ────────────────────────────────
//
// Products' search/category filter is live UI state, so its product ⋈ category
// ⋈ supplier view stays a `$derived` over the base stores; the per-order line
// lookup is a small, on-open join. The join/group *screens* (orders, category
// counts, customer counts) moved to the incremental `Derive` pipelines above.

/** Product views, filtered by search text + category. */
export const toProductViews = (
  filter: ProductFilter,
  products: ReadonlyArray<Product>,
  categories: ReadonlyArray<Category>,
  suppliers: ReadonlyArray<Supplier>
): ReadonlyArray<ProductView> => {
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const supName = new Map(suppliers.map((s) => [s.id, s.company]));
  const needle = filter.search.trim().toLowerCase();
  return products
    .filter((p) => (filter.categoryId === null ? true : p.categoryId === filter.categoryId))
    .filter((p) => (needle === "" ? true : p.name.toLowerCase().includes(needle)))
    .map((product) => ({
      product,
      categoryName: catName.get(product.categoryId) ?? "—",
      supplierCompany: supName.get(product.supplierId) ?? "—",
    }));
};

/** Line items for one order, with product names. */
export const toOrderLines = (
  orderId: string,
  details: ReadonlyArray<OrderDetail>,
  products: ReadonlyArray<Product>
): ReadonlyArray<OrderLine> => {
  const prodName = new Map(products.map((p) => [p.id, p.name]));
  return details
    .filter((d) => d.orderId === orderId)
    .map((detail) => ({ detail, productName: prodName.get(detail.productId) ?? detail.productId }));
};
