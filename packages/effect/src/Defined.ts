/**
 * Forward optional values into an option bag without writing `undefined`
 * members: a caller holding `undefined` omits the key
 * (`exactOptionalPropertyTypes`), so the result spreads into a
 * `readonly x?: T` bag with no cast.
 */

import * as R from "effect/Record";

/**
 * The shape {@link fields} returns: a member whose type admits `undefined` becomes an optional member of the remaining type, any other member is kept.
 */
export type Defined<T> = {
  readonly [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} & {
  readonly [K in keyof T as undefined extends T[K] ? never : K]: T[K];
};

/**
 * Copies the members of `input` whose value is not `undefined`, so the result spreads into an option bag whose members are `readonly x?: T`.
 *
 * @example
 * ```ts
 * const subset = { collection: "todos", ...fields({ limit, cursor }) };
 * ```
 */
export function fields<T extends object>(input: T): Defined<T>;
export function fields<T extends object>(input: T) {
  return R.filter(input, (value) => value !== undefined);
}
