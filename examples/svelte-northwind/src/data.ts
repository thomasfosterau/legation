/**
 * Data layer — base collection stores + relational joins
 *
 * The engine's live queries are single-collection (`query(subset)`). Here we map
 * each subset's rows to a typed `Readable` of domain rows, built once in the
 * root (after `setEngineRuntime`) and shared via context. Northwind's joins (a
 * product with its category and supplier, an order with its customer, employee
 * and line-item total) are pure functions over those collections, so components
 * combine the live stores with `$derived` and re-derive on every optimistic
 * edit, push ack, and pull/rebase.
 */
import { derived, type Readable } from "svelte/store";
import { getContext, setContext } from "svelte";
import { query } from "@thomasfosterau/effect-sync-svelte";
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
export interface ProductFilter {
  readonly search: string;
  readonly categoryId: string | null;
}

export const lineTotal = (d: OrderDetail): number =>
  d.unitPrice * d.quantity * (1 - d.discount);

// ─── Base collection stores ──────────────────────────────────────────────────

export interface Data {
  readonly categories: Readable<ReadonlyArray<Category>>;
  readonly suppliers: Readable<ReadonlyArray<Supplier>>;
  readonly products: Readable<ReadonlyArray<Product>>;
  readonly customers: Readable<ReadonlyArray<Customer>>;
  readonly employees: Readable<ReadonlyArray<Employee>>;
  readonly orders: Readable<ReadonlyArray<Order>>;
  readonly orderDetails: Readable<ReadonlyArray<OrderDetail>>;
}

/** Build the base collection stores. Call during init, after setEngineRuntime. */
export const createData = (): Data => ({
  categories: derived(query(allCategories), (rows) => rows.map((r) => r.value as Category)),
  suppliers: derived(query(allSuppliers), (rows) => rows.map((r) => r.value as Supplier)),
  products: derived(query(allProducts), (rows) => rows.map((r) => r.value as Product)),
  customers: derived(query(allCustomers), (rows) => rows.map((r) => r.value as Customer)),
  employees: derived(query(allEmployees), (rows) => rows.map((r) => r.value as Employee)),
  orders: derived(query(allOrders), (rows) => rows.map((r) => r.value as Order)),
  orderDetails: derived(query(allOrderDetails), (rows) => rows.map((r) => r.value as OrderDetail)),
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

// ─── Pure derivations (combine the live stores with $derived) ─────────────────

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

/** Categories with their product counts. */
export const toCategoryCounts = (
  categories: ReadonlyArray<Category>,
  products: ReadonlyArray<Product>
): ReadonlyArray<{ category: Category; count: number }> => {
  const counts = new Map<string, number>();
  for (const p of products) counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1);
  return categories.map((category) => ({ category, count: counts.get(category.id) ?? 0 }));
};

/** Order views with customer/employee names and computed totals. */
export const toOrderViews = (
  orders: ReadonlyArray<Order>,
  customers: ReadonlyArray<Customer>,
  employees: ReadonlyArray<Employee>,
  details: ReadonlyArray<OrderDetail>
): ReadonlyArray<OrderView> => {
  const custName = new Map(customers.map((c) => [c.id, c.company]));
  const empName = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
  const byOrder = new Map<string, OrderDetail[]>();
  for (const d of details) {
    const list = byOrder.get(d.orderId) ?? [];
    list.push(d);
    byOrder.set(d.orderId, list);
  }
  return orders.map((order) => {
    const lines = byOrder.get(order.id) ?? [];
    return {
      order,
      customerCompany: custName.get(order.customerId) ?? order.customerId,
      employeeName: empName.get(order.employeeId) ?? "—",
      lineCount: lines.length,
      total: lines.reduce((sum, d) => sum + lineTotal(d), 0),
    };
  });
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

/** Customers with their order counts. */
export const toCustomerCounts = (
  customers: ReadonlyArray<Customer>,
  orders: ReadonlyArray<Order>
): ReadonlyArray<{ customer: Customer; orders: number }> => {
  const counts = new Map<string, number>();
  for (const o of orders) counts.set(o.customerId, (counts.get(o.customerId) ?? 0) + 1);
  return customers.map((customer) => ({ customer, orders: counts.get(customer.id) ?? 0 }));
};
