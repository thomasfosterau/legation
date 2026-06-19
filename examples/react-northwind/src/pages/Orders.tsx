/**
 * Orders — orders with customer/employee, computed totals, expandable line
 * items, and a "ship" action (the read-merge `order/ship` mutator).
 */
import * as React from "react";
import { useActions } from "../actions";
import { useOrderLines, useOrderViews } from "../data";
import { lineTotal } from "../data";

const money = (n: number): string => `$${n.toFixed(2)}`;
const date = (ms: number): string => new Date(ms).toLocaleDateString();

const Lines = (props: { readonly orderId: string }): React.ReactElement => {
  const lines = useOrderLines(props.orderId);
  return (
    <tr className="lines">
      <td colSpan={7}>
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th className="num">Unit price</th>
              <th className="num">Qty</th>
              <th className="num">Discount</th>
              <th className="num">Line total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(({ detail, productName }) => (
              <tr key={detail.id}>
                <td>{productName}</td>
                <td className="num">{money(detail.unitPrice)}</td>
                <td className="num">{detail.quantity}</td>
                <td className="num">{detail.discount > 0 ? `${detail.discount * 100}%` : "—"}</td>
                <td className="num">{money(lineTotal(detail))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </td>
    </tr>
  );
};

export const Orders = (): React.ReactElement => {
  const orders = useOrderViews();
  const actions = useActions();
  const [open, setOpen] = React.useState<string | null>(null);

  return (
    <table>
      <thead>
        <tr>
          <th>Order</th>
          <th>Customer</th>
          <th>Rep</th>
          <th>Ordered</th>
          <th>Status</th>
          <th className="num">Total</th>
          <th className="right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((view) => (
          <React.Fragment key={view.order.id}>
            <tr>
              <td>
                <button
                  className="linkish"
                  onClick={() => setOpen(open === view.order.id ? null : view.order.id)}
                >
                  #{view.order.id} ({view.lineCount})
                </button>
              </td>
              <td>{view.customerCompany}</td>
              <td className="muted">{view.employeeName}</td>
              <td className="muted">{date(view.order.orderedAt)}</td>
              <td>
                {view.order.shippedAt === null ? (
                  <span className="pill pill-warn">open</span>
                ) : (
                  <span className="pill pill-ok">shipped {date(view.order.shippedAt)}</span>
                )}
              </td>
              <td className="num">{money(view.total)}</td>
              <td className="right">
                {view.order.shippedAt === null && (
                  <button className="btn btn-sm btn-primary" onClick={() => void actions.shipOrder(view.order.id)}>
                    Ship
                  </button>
                )}
              </td>
            </tr>
            {open === view.order.id && <Lines orderId={view.order.id} />}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
};
