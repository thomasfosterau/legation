/**
 * View shaping
 *
 * The dashboard's joins live in its **reads** (`domain.ts`): an `include`d edge
 * resolves onto every row's `related`, so what used to be a client-side join
 * layer — `Derive.join`/`groupBy` pipelines, or hand-rolled `Map` lookups — is
 * now nothing but reading the edge the read already asked for.
 *
 * What is left here is pure and synchronous: turn resolved rows into the shape
 * a screen renders. No stores, no context, no subscriptions — each screen calls
 * `useQuery` for what it needs and maps the result through these.
 */
import type { Client } from "@thomasfosterau/legation-effect";
import type { Category, Customer, Employee, Order, OrderDetail, Product, Supplier } from "./domain";

/** Rows as a read resolves them: the node value plus its `include`d edges. */
export type Rows = ReadonlyArray<Client.ResolvedRow>;

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

export const lineTotal = (detail: OrderDetail): number =>
  detail.unitPrice * detail.quantity * (1 - detail.discount);

// A resolved edge is `unknown` — the node graph types the schema, but not what
// a read hands back — so each accessor casts once, here, rather than at every
// use site.
const one = <T>(row: Client.ResolvedRow, edge: string): T | null =>
  (row.related[edge] as T | null | undefined) ?? null;
const many = <T>(row: Client.ResolvedRow, edge: string): ReadonlyArray<T> =>
  (row.related[edge] as ReadonlyArray<T> | undefined) ?? [];

/** Products (with their `category` / `supplier` edges), filtered for the grid. */
export const toProductViews = (filter: ProductFilter, rows: Rows): ReadonlyArray<ProductView> => {
  const needle = filter.search.trim().toLowerCase();
  return rows
    .map((row) => ({
      product: row.value as Product,
      categoryName: one<Category>(row, "category")?.name ?? "—",
      supplierCompany: one<Supplier>(row, "supplier")?.company ?? "—",
    }))
    .filter(
      ({ product }) =>
        (filter.categoryId === null || product.categoryId === filter.categoryId) &&
        (needle === "" || product.name.toLowerCase().includes(needle))
    );
};

/** Orders with their `customer` / `employee` / `lines` edges rolled up. */
export const toOrderViews = (rows: Rows): ReadonlyArray<OrderView> =>
  rows.map((row) => {
    const order = row.value as Order;
    const employee = one<Employee>(row, "employee");
    const lines = many<OrderDetail>(row, "lines");
    return {
      order,
      customerCompany: one<Customer>(row, "customer")?.company ?? order.customerId,
      employeeName: employee === null ? "—" : `${employee.firstName} ${employee.lastName}`,
      lineCount: lines.length,
      total: lines.reduce((sum, detail) => sum + lineTotal(detail), 0),
    };
  });

/** One order's line items, each with its `product` edge resolved. */
export const toOrderLines = (rows: Rows): ReadonlyArray<OrderLine> =>
  rows.map((row) => {
    const detail = row.value as OrderDetail;
    return { detail, productName: one<Product>(row, "product")?.name ?? detail.productId };
  });

/** Categories with a live product count — the count IS the `products` edge. */
export const toCategoryCounts = (rows: Rows): ReadonlyArray<CategoryCount> =>
  rows.map((row) => ({
    category: row.value as Category,
    count: many<Product>(row, "products").length,
  }));

/** Customers with a live order count — the count IS the `orders` edge. */
export const toCustomerCounts = (rows: Rows): ReadonlyArray<CustomerCount> =>
  rows.map((row) => ({
    customer: row.value as Customer,
    orders: many<Order>(row, "orders").length,
  }));

/** Plain rows of one collection, for the screens that read a single node. */
export const values = <T>(rows: Rows): ReadonlyArray<T> => rows.map((row) => row.value as T);
