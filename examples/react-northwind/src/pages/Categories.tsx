/**
 * Categories — categories with live product counts, and a create form.
 */
import * as React from "react";
import { useActions } from "../actions";
import { useCategoryCounts } from "../data";

export const Categories = (): React.ReactElement => {
  const rows = useCategoryCounts();
  const actions = useActions();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return;
    void actions.createCategory({
      id: `c-${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim(),
      description: description.trim(),
    });
    setName("");
    setDescription("");
  };

  return (
    <div>
      <table>
        <thead>
          <tr>
            <th>Category</th>
            <th>Description</th>
            <th className="num">Products</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ category, count }) => (
            <tr key={category.id}>
              <td>{category.name}</td>
              <td className="muted">{category.description}</td>
              <td className="num">{count}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="card" style={{ marginTop: 20 }}>
        <h3>Add a category</h3>
        <form className="toolbar" onSubmit={add}>
          <input
            className="input"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="input grow"
            placeholder="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button className="btn btn-primary" type="submit">
            Add category
          </button>
        </form>
      </div>
    </div>
  );
};
