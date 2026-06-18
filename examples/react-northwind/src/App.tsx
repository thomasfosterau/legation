/**
 * App shell — a tabbed admin dashboard over the Northwind collections, with a
 * sync status banner whose offline toggle makes writes queue in the journal.
 */
import * as React from "react";
import { useConnection, useWorld } from "./world";
import { Products } from "./pages/Products";
import { Categories } from "./pages/Categories";
import { Orders } from "./pages/Orders";
import { Customers, Suppliers } from "./pages/Directory";

type Tab = "products" | "categories" | "orders" | "customers" | "suppliers";
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "products", label: "Products" },
  { id: "categories", label: "Categories" },
  { id: "orders", label: "Orders" },
  { id: "customers", label: "Customers" },
  { id: "suppliers", label: "Suppliers" },
];

const Banner = (): React.ReactElement => {
  const world = useWorld();
  const connection = useConnection();
  const offline = connection === "disconnected";
  return (
    <div className={`banner ${offline ? "offline" : ""}`}>
      <span className="muted">
        effect-sync · Northwind · in-page SyncServer + MemoryBackend ·{" "}
        {offline ? "offline — edits queue in the journal" : "online — optimistic + rebase"}
      </span>
      <button onClick={() => void world.setOnline(offline)}>
        {offline ? "Go online" : "Go offline"}
      </button>
    </div>
  );
};

export const App = (): React.ReactElement => {
  const [tab, setTab] = React.useState<Tab>("products");
  return (
    <>
      <Banner />
      <div className="shell">
        <h1 className="title">Northwind Traders</h1>
        <p className="subtitle">
          A relational admin dashboard — seven collections joined live over the mirror, optimistic
          edits, push/pull/rebase.
        </p>
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "products" && <Products />}
        {tab === "categories" && <Categories />}
        {tab === "orders" && <Orders />}
        {tab === "customers" && <Customers />}
        {tab === "suppliers" && <Suppliers />}
      </div>
    </>
  );
};
