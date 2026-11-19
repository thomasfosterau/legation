/**
 * View shaping
 *
 * The dashboard's joins live in its **reads** (`domain.ts`): an `include`d edge
 * resolves onto every row's `related`, so what used to be a client-side join
 * layer — `Derive.join`/`groupBy` pipelines, or hand-rolled `Map` lookups — is
 * now nothing but reading the edge the read already asked for.
 *
 * The reads are declared `as const satisfies Query.Read`, so each one's rows
 * are typed from the node graph: `row.value` is the node's row, and
 * `row.related` carries exactly the edges the read includes — a `one` edge's
 * row or `null`, a `many` edge's rows. Nothing here casts.
 *
 * What is left here is pure and synchronous: turn resolved rows into the shape
 * a screen renders. No stores, no context, no subscriptions — each screen calls
 * `useQuery` for what it needs and maps the result through these.
 */
import type { Client, Query } from "@thomasfosterau/legation";
import type {
  Category,
  Customer,
  Order,
  OrderDetail,
  Product,
  allCategories,
  allCustomers,
  allOrders,
  allProducts,
  orderLines,
} from "./domain";

/** The rows a read resolves to, typed from the read and the registered graph. */
export type Rows<R extends Query.Read> = ReadonlyArray<Client.ResolvedRow<R>>;

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

/** Products (with their `category` / `supplier` edges), filtered for the grid. */
export const toProductViews = (
  filter: ProductFilter,
  rows: Rows<typeof allProducts>
): ReadonlyArray<ProductView> => {
  const needle = filter.search.trim().toLowerCase();
  return rows
    .map((row) => ({
      product: row.value,
      categoryName: row.related.category?.name ?? "—",
      supplierCompany: row.related.supplier?.company ?? "—",
    }))
    .filter(
      ({ product }) =>
        (filter.categoryId === null || product.categoryId === filter.categoryId) &&
        (needle === "" || product.name.toLowerCase().includes(needle))
    );
};

/** Orders with their `customer` / `employee` / `lines` edges rolled up. */
export const toOrderViews = (rows: Rows<typeof allOrders>): ReadonlyArray<OrderView> =>
  rows.map(({ value: order, related: { customer, employee, lines } }) => ({
    order,
    customerCompany: customer?.company ?? order.customerId,
    employeeName: employee === null ? "—" : `${employee.firstName} ${employee.lastName}`,
    lineCount: lines.length,
    total: lines.reduce((sum, detail) => sum + lineTotal(detail), 0),
  }));

/** One order's line items, each with its `product` edge resolved. */
export const toOrderLines = (rows: Rows<ReturnType<typeof orderLines>>): ReadonlyArray<OrderLine> =>
  rows.map(({ value: detail, related: { product } }) => ({
    detail,
    productName: product?.name ?? detail.productId,
  }));

/** Categories with a live product count — the count IS the `products` edge. */
export const toCategoryCounts = (rows: Rows<typeof allCategories>): ReadonlyArray<CategoryCount> =>
  rows.map((row) => ({ category: row.value, count: row.related.products.length }));

/** Customers with a live order count — the count IS the `orders` edge. */
export const toCustomerCounts = (rows: Rows<typeof allCustomers>): ReadonlyArray<CustomerCount> =>
  rows.map((row) => ({ customer: row.value, orders: row.related.orders.length }));

/** Plain row values of one collection, for the screens that read a single node. */
export const values = <R extends Query.Read>(
  rows: Rows<R>
): ReadonlyArray<Client.ResolvedRow<R>["value"]> => rows.map((row) => row.value);
