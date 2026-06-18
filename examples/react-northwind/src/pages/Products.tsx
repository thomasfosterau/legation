/**
 * Products — searchable, category-filtered, paginated grid with inline edits.
 *
 * Each row's price / stock / discontinued is editable; saving issues the
 * read-merge `product/update` mutator (optimistic, then authoritative). "New
 * product" and "delete" show create/delete intents.
 */
import * as React from "react";
import { useActions } from "../actions";
import { useCategories, useProductViews } from "../data";
import type { ProductFilter, ProductView } from "../data";

const PAGE_SIZE = 8;

const ProductRow = (props: { readonly view: ProductView }): React.ReactElement => {
  const actions = useActions();
  const { product } = props.view;
  const [price, setPrice] = React.useState(String(product.unitPrice));
  const [stock, setStock] = React.useState(String(product.unitsInStock));
  const [editing, setEditing] = React.useState(false);

  React.useEffect(() => {
    setPrice(String(product.unitPrice));
    setStock(String(product.unitsInStock));
  }, [product.unitPrice, product.unitsInStock]);

  const save = () => {
    void actions.updateProduct({
      id: product.id,
      unitPrice: Number(price) || 0,
      unitsInStock: Number(stock) || 0,
      discontinued: product.discontinued,
    });
    setEditing(false);
  };

  return (
    <tr>
      <td>{product.name}</td>
      <td className="muted">{props.view.categoryName}</td>
      <td className="muted">{props.view.supplierCompany}</td>
      <td className="num">
        {editing ? (
          <input className="cell-input" value={price} onChange={(e) => setPrice(e.target.value)} />
        ) : (
          `$${product.unitPrice.toFixed(2)}`
        )}
      </td>
      <td className="num">
        {editing ? (
          <input className="cell-input" value={stock} onChange={(e) => setStock(e.target.value)} />
        ) : (
          product.unitsInStock
        )}
      </td>
      <td>
        <button
          className={`pill ${product.discontinued ? "pill-warn" : "pill-ok"}`}
          onClick={() =>
            void actions.updateProduct({
              id: product.id,
              unitPrice: product.unitPrice,
              unitsInStock: product.unitsInStock,
              discontinued: !product.discontinued,
            })
          }
          style={{ cursor: "pointer", background: "transparent" }}
        >
          {product.discontinued ? "discontinued" : "active"}
        </button>
      </td>
      <td className="right">
        {editing ? (
          <button className="btn btn-sm btn-primary" onClick={save}>
            Save
          </button>
        ) : (
          <button className="btn btn-sm" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}{" "}
        <button className="btn btn-sm btn-danger" onClick={() => void actions.deleteProduct(product.id)}>
          Delete
        </button>
      </td>
    </tr>
  );
};

const NewProduct = (): React.ReactElement => {
  const actions = useActions();
  const categories = useCategories();
  const [name, setName] = React.useState("");
  const [categoryId, setCategoryId] = React.useState("");
  const [price, setPrice] = React.useState("");

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return;
    actions
      .createProduct({
        id: `p-${Math.random().toString(36).slice(2, 8)}`,
        name: name.trim(),
        categoryId: categoryId || categories[0]?.id || "1",
        supplierId: "1",
        unitPrice: Number(price) || 0,
        unitsInStock: 0,
        discontinued: false,
      })
      .catch(() => undefined);
    setName("");
    setPrice("");
  };

  return (
    <form className="toolbar" onSubmit={add}>
      <input
        className="input grow"
        placeholder="New product name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <input
        className="input"
        style={{ width: 100 }}
        placeholder="Price"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
      />
      <button className="btn btn-primary" type="submit">
        Add product
      </button>
    </form>
  );
};

export const Products = (): React.ReactElement => {
  const categories = useCategories();
  const [search, setSearch] = React.useState("");
  const [categoryId, setCategoryId] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(0);

  const filter: ProductFilter = { search, categoryId };
  const views = useProductViews(filter);
  const pages = Math.ceil(views.length / PAGE_SIZE);
  const pageViews = views.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  React.useEffect(() => setPage(0), [search, categoryId]);

  return (
    <div>
      <div className="toolbar">
        <input
          className="input grow"
          placeholder="Search products…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="select"
          value={categoryId ?? ""}
          onChange={(e) => setCategoryId(e.target.value === "" ? null : e.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="muted">{views.length} products</span>
      </div>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Category</th>
            <th>Supplier</th>
            <th className="num">Price</th>
            <th className="num">In stock</th>
            <th>Status</th>
            <th className="right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {pageViews.map((view) => (
            <ProductRow key={view.product.id} view={view} />
          ))}
          {pageViews.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No products match.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {pages > 1 && (
        <div className="pagination">
          {Array.from({ length: pages }, (_, i) => (
            <button
              key={i}
              className={`page-btn ${i === page ? "active" : ""}`}
              onClick={() => setPage(i)}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <h3>Add a product</h3>
        <NewProduct />
      </div>
    </div>
  );
};
