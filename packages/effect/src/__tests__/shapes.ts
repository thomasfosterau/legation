/**
 * Checked readers for the untyped values tests get back from the engine: a
 * backend handler's args, a row value and a related row are `unknown` there.
 * Each read throws, failing the test, on a value of another shape.
 */
import * as Arr from "effect/Array";
import { flow } from "effect/Function";
import * as Schema from "effect/Schema";

const Identified = Schema.Struct({ id: Schema.String });
const Titled = Schema.Struct({ title: Schema.String });
const Counted = Schema.Struct({ n: Schema.Finite });

/** The string `id` of a row value or mutator args the engine hands back untyped. */
export const idOf = flow(Schema.decodeUnknownSync(Identified), (row) => row.id);

/** The `id` of each row in a list the engine hands back untyped. */
export const idsOf = flow(Schema.decodeUnknownSync(Schema.Array(Identified)), (rows) =>
  Arr.map(rows, (row) => row.id)
);

/** A reader for the string field `key` of a row value or mutator args the engine hands back untyped. */
export const stringField = <const K extends string>(key: K) =>
  flow(
    Schema.decodeUnknownSync(Schema.Record(Schema.Literal(key), Schema.String)),
    (row) => row[key]
  );

/** A reader for the boolean field `key` of a row value or mutator args the engine hands back untyped. */
export const booleanField = <const K extends string>(key: K) =>
  flow(
    Schema.decodeUnknownSync(Schema.Record(Schema.Literal(key), Schema.Boolean)),
    (row) => row[key]
  );

/** The string `title` of a row value or mutator args the engine hands back untyped. */
export const titleOf = flow(Schema.decodeUnknownSync(Titled), (row) => row.title);

/** The numeric `n` of a counter row value the engine hands back untyped. */
export const countOf = flow(Schema.decodeUnknownSync(Counted), (row) => row.n);

/** {@link countOf} for a counter row that may be absent (`undefined`). */
export const optionalCountOf = flow(
  Schema.decodeUnknownSync(Schema.UndefinedOr(Counted)),
  (row) => row?.n
);
