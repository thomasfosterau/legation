import { assertDefined } from "@effect/vitest/utils";

/**
 * `value`, failing the test when it is `undefined`: the checked stand-in for
 * a `!` non-null assertion on a value the test expects to be present.
 */
export const defined = <A>(value: A): Exclude<A, undefined> => {
  assertDefined(value);
  return value;
};
