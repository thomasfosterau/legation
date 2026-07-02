/**
 * Domain — Northwind Traders
 *
 * The classic Northwind relational dataset, modelled as independent engine
 * collections joined client-side over the mirror (CONTEXT.md). It is the
 * relational counterpart to the todo/Conduit examples, leaning on the engine's
 * multi-collection sync to drive an admin dashboard:
 *
 *   categories   — product categories
 *   suppliers    — who we buy from
 *   products     — what we sell (references category + supplier)
 *   customers    — who we sell to
 *   employees    — sales reps
 *   orders       — a customer order taken by an employee
 *   orderDetails — a line item (orderId:productId), references product
 *
 * Reads are public (this is an internal admin tool); writes are optimistic,
 * schema-validated mutators replayed on rebase and applied authoritatively on
 * the in-page backend.
 */

import { Schema } from "effect";
import { Collection, Mutator, Subset } from "@legation/effect";

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

// ─── Collections ─────────────────────────────────────────────────────────────

export const categoriesCollection = Collection.make({ name: "categories", schema: Category, id: (r) => r.id });
export const suppliersCollection = Collection.make({ name: "suppliers", schema: Supplier, id: (r) => r.id });
export const productsCollection = Collection.make({ name: "products", schema: Product, id: (r) => r.id });
export const customersCollection = Collection.make({ name: "customers", schema: Customer, id: (r) => r.id });
export const employeesCollection = Collection.make({ name: "employees", schema: Employee, id: (r) => r.id });
export const ordersCollection = Collection.make({ name: "orders", schema: Order, id: (r) => r.id });
export const orderDetailsCollection = Collection.make({ name: "orderDetails", schema: OrderDetail, id: (r) => r.id });

// ─── Mutator arg schemas + contracts ─────────────────────────────────────────

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

export const updateProduct = Mutator.make("product/update", ProductPatch);
export const createProduct = Mutator.make("product/create", ProductInput);
export const deleteProduct = Mutator.make("product/delete", IdArgs);
export const createCategory = Mutator.make("category/create", CategoryInput);
export const shipOrder = Mutator.make("order/ship", ShipOrderArgs);

// Create contracts for the remaining entities — used by the backend handlers
// and the seed (the UI doesn't author suppliers/customers/employees/orders, so
// these aren't in the client registry).
export const createSupplier = Mutator.make("supplier/create", Supplier);
export const createCustomer = Mutator.make("customer/create", Customer);
export const createEmployee = Mutator.make("employee/create", Employee);
export const createOrder = Mutator.make("order/create", Order);
export const createOrderDetail = Mutator.make("orderDetail/create", OrderDetail);

// ─── Subsets subscribed on boot ──────────────────────────────────────────────
//
// The seed dataset is small, so each tab subscribes to every collection and
// joins/filters/paginates locally.

export const allCategories = Subset.make({ collection: "categories", orderBy: [{ field: "name", direction: "asc" }] });
export const allSuppliers = Subset.make({ collection: "suppliers" });
export const allProducts = Subset.make({ collection: "products", orderBy: [{ field: "name", direction: "asc" }] });
export const allCustomers = Subset.make({ collection: "customers", orderBy: [{ field: "company", direction: "asc" }] });
export const allEmployees = Subset.make({ collection: "employees" });
export const allOrders = Subset.make({ collection: "orders", orderBy: [{ field: "orderedAt", direction: "desc" }] });
export const allOrderDetails = Subset.make({ collection: "orderDetails" });

export const allSubsets: ReadonlyArray<Subset.Subset> = [
  allCategories,
  allSuppliers,
  allProducts,
  allCustomers,
  allEmployees,
  allOrders,
  allOrderDetails,
];

/** Line-item id, minted identically on client and backend. */
export const orderDetailId = (orderId: string, productId: string): string => `${orderId}:${productId}`;

export const CLIENT_ID = "react-northwind-tab";
export const CLIENT_GROUP_ID = "react-northwind";
