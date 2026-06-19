/**
 * Customers + Suppliers — simple read-only directory tables (joins for counts).
 */
import * as React from "react";
import { useCustomerCounts, useSuppliers } from "../data";

export const Customers = (): React.ReactElement => {
  const rows = useCustomerCounts();
  return (
    <table>
      <thead>
        <tr>
          <th>Company</th>
          <th>Contact</th>
          <th>Country</th>
          <th className="num">Orders</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ customer, orders }) => (
          <tr key={customer.id}>
            <td>{customer.company}</td>
            <td className="muted">{customer.contact}</td>
            <td className="muted">{customer.country}</td>
            <td className="num">{orders}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export const Suppliers = (): React.ReactElement => {
  const suppliers = useSuppliers();
  return (
    <table>
      <thead>
        <tr>
          <th>Company</th>
          <th>Contact</th>
          <th>Country</th>
        </tr>
      </thead>
      <tbody>
        {suppliers.map((s) => (
          <tr key={s.id}>
            <td>{s.company}</td>
            <td className="muted">{s.contact}</td>
            <td className="muted">{s.country}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
