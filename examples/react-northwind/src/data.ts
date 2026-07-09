/**
 * Data layer — relational reads as client-side joins
 *
 * Northwind's joins (a product with its category and supplier, an order with
 * its customer, employee and line-item total) are assembled here reactively:
 * each hook is a `useMemo` over the live `useQuery` collection results, so it
 * re-derives on every optimistic edit, push ack, and pull/rebase.
 */
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useQuery } from "@legation/react";
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

const map = <T,>(rows: ReadonlyArray<{ readonly value: unknown }>): ReadonlyArray<T> =>
  rows.map((row) => row.value as T);

// ─── Raw collection reads ────────────────────────────────────────────────────

export const useCategories = (): ReadonlyArray<Category> => {
  const rows = AsyncResult.getOrElse(useQuery(allCategories), () => []);
  return React.useMemo(() => map<Category>(rows), [rows]);
};
export const useSuppliers = (): ReadonlyArray<Supplier> => {
  const rows = AsyncResult.getOrElse(useQuery(allSuppliers), () => []);
  return React.useMemo(() => map<Supplier>(rows), [rows]);
};
export const useProducts = (): ReadonlyArray<Product> => {
  const rows = AsyncResult.getOrElse(useQuery(allProducts), () => []);
  return React.useMemo(() => map<Product>(rows), [rows]);
};
export const useCustomers = (): ReadonlyArray<Customer> => {
  const rows = AsyncResult.getOrElse(useQuery(allCustomers), () => []);
  return React.useMemo(() => map<Customer>(rows), [rows]);
};
export const useEmployees = (): ReadonlyArray<Employee> => {
  const rows = AsyncResult.getOrElse(useQuery(allEmployees), () => []);
  return React.useMemo(() => map<Employee>(rows), [rows]);
};
export const useOrders = (): ReadonlyArray<Order> => {
  const rows = AsyncResult.getOrElse(useQuery(allOrders), () => []);
  return React.useMemo(() => map<Order>(rows), [rows]);
};
export const useOrderDetails = (): ReadonlyArray<OrderDetail> => {
  const rows = AsyncResult.getOrElse(useQuery(allOrderDetails), () => []);
  return React.useMemo(() => map<OrderDetail>(rows), [rows]);
};

const lineTotal = (d: OrderDetail): number => d.unitPrice * d.quantity * (1 - d.discount);

// ─── Derived reads ───────────────────────────────────────────────────────────

export interface ProductFilter {
  readonly search: string;
  readonly categoryId: string | null;
}

/** Product views, filtered by search text + category. */
export const useProductViews = (filter: ProductFilter): ReadonlyArray<ProductView> => {
  const products = useProducts();
  const categories = useCategories();
  const suppliers = useSuppliers();
  return React.useMemo(() => {
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
  }, [products, categories, suppliers, filter.search, filter.categoryId]);
};

/** Categories with their product counts. */
export const useCategoryCounts = (): ReadonlyArray<{ category: Category; count: number }> => {
  const categories = useCategories();
  const products = useProducts();
  return React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products) counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1);
    return categories.map((category) => ({ category, count: counts.get(category.id) ?? 0 }));
  }, [categories, products]);
};

/** Order views with customer/employee names and computed totals. */
export const useOrderViews = (): ReadonlyArray<OrderView> => {
  const orders = useOrders();
  const customers = useCustomers();
  const employees = useEmployees();
  const details = useOrderDetails();
  return React.useMemo(() => {
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
  }, [orders, customers, employees, details]);
};

/** Line items for one order, with product names. */
export const useOrderLines = (orderId: string): ReadonlyArray<OrderLine> => {
  const details = useOrderDetails();
  const products = useProducts();
  return React.useMemo(() => {
    const prodName = new Map(products.map((p) => [p.id, p.name]));
    return details
      .filter((d) => d.orderId === orderId)
      .map((detail) => ({ detail, productName: prodName.get(detail.productId) ?? detail.productId }));
  }, [details, products, orderId]);
};

/** Customers with their order counts. */
export const useCustomerCounts = (): ReadonlyArray<{ customer: Customer; orders: number }> => {
  const customers = useCustomers();
  const orders = useOrders();
  return React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of orders) counts.set(o.customerId, (counts.get(o.customerId) ?? 0) + 1);
    return customers.map((customer) => ({ customer, orders: counts.get(customer.id) ?? 0 }));
  }, [customers, orders]);
};

export { lineTotal };
