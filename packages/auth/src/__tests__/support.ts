/** Small helpers the tests share. */
import { assert } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Principal } from "@thomasfosterau/legation-auth";

/** A deliberate crash, for the tests that make a store, a compile or a header lookup die. */
export class Crash extends Schema.TaggedError<Crash, { readonly brand: unique symbol }>()("Crash", {
  message: Schema.String,
}) {}

/** The success of a result, or a failed assertion naming the failure. */
export const orFail = <A, E>(result: Result.Result<A, E>): A =>
  Result.getOrElse(result, (error) => assert.fail(`expected a success, got ${String(error)}`));

/** The failure of a result, or `undefined` for a success. */
export const failureOf = <A, E>(result: Result.Result<A, E>): E | undefined =>
  Result.match(result, { onSuccess: () => undefined, onFailure: (error) => error });

/** A resolved identity as the principal it is: anything else reads as anonymous. */
export const asPrincipal = (identity: unknown): Principal.Principal =>
  Principal.fromContext({ clientGroupId: "test", identity });

/** Whether `needle` occurs in any string anywhere inside `value` (records and arrays, deeply). */
export const mentions = (value: unknown, needle: string): boolean =>
  P.isString(value)
    ? value.includes(needle)
    : Array.isArray(value)
      ? Arr.some(value, (inner) => mentions(inner, needle))
      : P.isObject(value)
        ? Arr.some(R.values(value), (inner) => mentions(inner, needle))
        : false;
