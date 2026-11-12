/**
 * Domain — Northwind Traders
 *
 * The classic Northwind dataset as a **node graph** (ADR-0022): typed
 * attributes plus `one`/`many` edges, with each foreign key declared exactly
 * once — on the child, as `Edge.one(..., { via })` — and the parent naming the
 * inverse. The engine's collection registry, the joins, the sync windows and
 * the fan-out topics all derive from these declarations.
 *
 *   categories   — product categories        (products)
 *   suppliers    — who we buy from           (products)
 *   products     — what we sell              (category, supplier, lines)
 *   customers    — who we sell to            (orders)
 *   employees    — sales reps                (orders)
 *   orders       — a customer order          (customer, employee, lines)
 *   orderDetails — a line item               (order, product)
 *
 * Because the edges are declared, a screen's join is part of its **read**:
 * `include: { customer: true, lines: true }` resolves onto each row's
 * `related`, so the dashboard needs no client-side join layer of its own.
 *
 * Reads are public (this is an internal admin tool); writes are optimistic,
 * schema-validated mutations replayed on rebase and applied authoritatively on
 * the in-page backend.
 */

import * as Schema from "effect/Schema";
import { Edge, Mutation, Node, type Query } from "@thomasfosterau/legation";

// ─── Row schemas ─────────────────────────────────────────────────────────────

export const Category = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
});
export type Category = typeof Category.Type;

export const Supplier = Schema.Struct({
  id: Schema.String,
  company: Schema.String,
  contact: Schema.String,
  country: Schema.String,
});
export type Supplier = typeof Supplier.Type;

export const Product = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  categoryId: Schema.String,
  supplierId: Schema.String,
  unitPrice: Schema.Number,
  unitsInStock: Schema.Number,
  discontinued: Schema.Boolean,
});
export type Product = typeof Product.Type;

export const Customer = Schema.Struct({
  id: Schema.String,
  company: Schema.String,
  contact: Schema.String,
  country: Schema.String,
});
export type Customer = typeof Customer.Type;

export const Employee = Schema.Struct({
  id: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  title: Schema.String,
});
export type Employee = typeof Employee.Type;

export const Order = Schema.Struct({
  id: Schema.String,
  customerId: Schema.String,
  employeeId: Schema.String,
  orderedAt: Schema.Number,
  /** Epoch ms once shipped, or null while open. */
  shippedAt: Schema.NullOr(Schema.Number),
  shipCountry: Schema.String,
});
export type Order = typeof Order.Type;

export const OrderDetail = Schema.Struct({
  /** Row id: `${orderId}:${productId}`. */
  id: Schema.String,
  orderId: Schema.String,
  productId: Schema.String,
  unitPrice: Schema.Number,
  quantity: Schema.Number,
  discount: Schema.Number,
});
export type OrderDetail = typeof OrderDetail.Type;

// ─── The node graph ──────────────────────────────────────────────────────────
//
// `Node.make` supplies the id and, for every `Edge.one`, the `via` foreign key
// — so the attributes are the schema minus those fields.

const { id: _categoryId, ...categoryAttributes } = Category.fields;
const { id: _supplierId, ...supplierAttributes } = Supplier.fields;
const {
  id: _productId,
  categoryId: _productCategoryId,
  supplierId: _productSupplierId,
  ...productAttributes
} = Product.fields;
const { id: _customerId, ...customerAttributes } = Customer.fields;
const { id: _employeeId, ...employeeAttributes } = Employee.fields;
const {
  id: _orderId,
  customerId: _orderCustomerId,
  employeeId: _orderEmployeeId,
  ...orderAttributes
} = Order.fields;
const {
  id: _detailId,
  orderId: _detailOrderId,
  productId: _detailProductId,
  ...detailAttributes
} = OrderDetail.fields;

export const categories = Node.make("categories", {
  attributes: categoryAttributes,
  edges: { products: Edge.many("products", { inverse: "category" }) },
  sortable: ["name"],
});

export const suppliers = Node.make("suppliers", {
  attributes: supplierAttributes,
  edges: { products: Edge.many("products", { inverse: "supplier" }) },
  sortable: ["company"],
});

export const products = Node.make("products", {
  attributes: productAttributes,
  edges: {
    category: Edge.one("categories", { via: "categoryId" }),
    supplier: Edge.one("suppliers", { via: "supplierId" }),
    lines: Edge.many("orderDetails", { inverse: "product" }),
  },
  sortable: ["name"],
});

export const customers = Node.make("customers", {
  attributes: customerAttributes,
  edges: { orders: Edge.many("orders", { inverse: "customer" }) },
  sortable: ["company"],
});

export const employees = Node.make("employees", {
  attributes: employeeAttributes,
  edges: { orders: Edge.many("orders", { inverse: "employee" }) },
});

export const orders = Node.make("orders", {
  attributes: orderAttributes,
  edges: {
    customer: Edge.one("customers", { via: "customerId" }),
    employee: Edge.one("employees", { via: "employeeId" }),
    lines: Edge.many("orderDetails", { inverse: "order" }),
  },
  sortable: ["orderedAt"],
});

export const orderDetails = Node.make("orderDetails", {
  attributes: detailAttributes,
  edges: {
    order: Edge.one("orders", { via: "orderId" }),
    product: Edge.one("products", { via: "productId" }),
  },
});

/** The closed, validated graph: nodes + the derived engine registry. */
export const nodes = Node.registry([
  categories,
  suppliers,
  products,
  customers,
  employees,
  orders,
  orderDetails,
]);

/**
 * The graph registered for the rune hooks: `useQuery` and `useConnection` find
 * the Client in context, so this is how they type each read's rows.
 */
declare module "@thomasfosterau/legation" {
  interface Register {
    readonly nodes: typeof nodes;
  }
}

/** The engine's collection registry, derived edge-for-edge from the graph. */
export const registry = nodes.collections;

// ─── Reads ───────────────────────────────────────────────────────────────────
//
// The seed dataset is small, so each screen reads a whole collection and the
// tab filters/paginates locally. Each screen's join lives in its read: an
// `include`d edge resolves onto every row's `related`.
//
// Each read is a plain literal declared `as const satisfies Query.Read`: the
// shape is checked here, and the literal collection and `include` keys type
// the rows the hooks hand back (the graph is registered above).

/** Categories with their products — the screen counts what it is handed. */
export const allCategories = {
  collection: "categories",
  order: ["name"],
  include: { products: true },
} as const satisfies Query.Read;

/** Products with the category and supplier the grid displays. */
export const allProducts = {
  collection: "products",
  order: ["name"],
  include: { category: true, supplier: true },
} as const satisfies Query.Read;

/** Customers with their orders — the directory's live order count. */
export const allCustomers = {
  collection: "customers",
  order: ["company"],
  include: { orders: true },
} as const satisfies Query.Read;

/** Orders joined to customer, employee, and their line items, newest first. */
export const allOrders = {
  collection: "orders",
  order: ["-orderedAt"],
  include: { customer: true, employee: true, lines: true },
} as const satisfies Query.Read;

export const allSuppliers = {
  collection: "suppliers",
  order: ["company"],
} as const satisfies Query.Read;

/** One order's line items, each with the product it refers to. */
export const orderLines = (orderId: string) => ({
  collection: "orderDetails",
  where: { orderId },
  include: { product: true },
}) as const satisfies Query.Read;
export const allEmployees = { collection: "employees" } as const satisfies Query.Read;
export const allOrderDetails = { collection: "orderDetails" } as const satisfies Query.Read;

/**
 * What the shell pins for the lifetime of the tab, beyond whichever screen is
 * mounted: the line items and products a read's `include` resolves against
 * have to be synced for the join to see them.
 */
export const shellReads: ReadonlyArray<Query.Read> = [
  { collection: "categories" },
  { collection: "suppliers" },
  { collection: "products" },
  { collection: "customers" },
  { collection: "employees" },
  { collection: "orders" },
  { collection: "orderDetails" },
];

// ─── Mutations ───────────────────────────────────────────────────────────────

/** Edit the mutable product fields from the products grid. */
export const ProductPatch = Schema.Struct({
  id: Schema.String,
  unitPrice: Schema.Number,
  unitsInStock: Schema.Number,
  discontinued: Schema.Boolean,
});
export type ProductPatchType = typeof ProductPatch.Type;
export const ProductInput = Product;
export const IdArgs = Schema.Struct({ id: Schema.String });
export const CategoryInput = Category;
export const ShipOrderArgs = Schema.Struct({ id: Schema.String, shippedAt: Schema.Number });

export const updateProduct = Mutation.make("product/update", ProductPatch);
export const createProduct = Mutation.make("product/create", ProductInput);
export const deleteProduct = Mutation.make("product/delete", IdArgs);
export const createCategory = Mutation.make("category/create", CategoryInput);
export const shipOrder = Mutation.make("order/ship", ShipOrderArgs);

// Create contracts for the remaining entities — used by the backend handlers
// and the seed (the UI doesn't author suppliers/customers/employees/orders, so
// these aren't in the client registry).
export const createSupplier = Mutation.make("supplier/create", Supplier);
export const createCustomer = Mutation.make("customer/create", Customer);
export const createEmployee = Mutation.make("employee/create", Employee);
export const createOrder = Mutation.make("order/create", Order);
export const createOrderDetail = Mutation.make("orderDetail/create", OrderDetail);

/** Line-item id, minted identically on client and backend. */
export const orderDetailId = (orderId: string, productId: string): string => `${orderId}:${productId}`;

export const CLIENT_ID = "northwind-tab";
export const CLIENT_GROUP_ID = "northwind";
