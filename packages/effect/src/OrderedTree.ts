/**
 * OrderedTree
 *
 * A persistent (path-copying) weight-balanced binary search tree keyed by a
 * caller-supplied total order (bounded-balance / "BB[α]" trees, Adams 1992 —
 * the algorithm behind Haskell's `Data.Set`/`Data.Map`). Every mutation
 * returns a new tree sharing everything off the changed path, so an
 * insert/remove is *O(log n)* node allocations rather than an *O(n)* array
 * copy. Each node also carries its subtree size, so a value's 0-based rank
 * (and the reverse: the value at a given rank) resolve in *O(log n)*, and a
 * `count`-bounded slice starting at a rank costs *O(log n + count)* — this is
 * what lets `LiveView` reslice its window without rescanning the whole
 * maintained order (issue #112).
 *
 * Weight-balance (rather than a randomized treap) makes bulk construction
 * from an already-sorted array linear and deterministic: `fromSorted`
 * recursively roots each half at its middle element, which is already
 * within the balance bound, so no rotation is needed on the way up.
 *
 * Generic over the element type; the caller's `compare` must be a strict
 * total order (no ties) for `rankOf`/`remove` to behave — `LiveView` gets
 * this from `Subset.comparator`'s id tie-break.
 */

interface Node<T> {
  readonly value: T;
  readonly left: Node<T> | undefined;
  readonly right: Node<T> | undefined;
  readonly size: number;
}

/** An immutable ordered tree; `undefined` is the empty tree. */
export type Tree<T> = Node<T> | undefined;

/** Number of elements in the tree, O(1). */
export const size = <T>(tree: Tree<T>): number => tree?.size ?? 0;

const sizeOf = <T>(tree: Tree<T>): number => tree?.size ?? 0;

const node = <T>(left: Tree<T>, value: T, right: Tree<T>): Node<T> => ({
  value,
  left,
  right,
  size: sizeOf(left) + sizeOf(right) + 1,
});

// Bounded-balance factors (Adams 1992 / containers library defaults): a
// subtree may outweigh its sibling by at most `delta`; a rotation chooses
// single vs double based on whether the heavy child's own bias exceeds
// `ratio`.
const DELTA = 3;
const RATIO = 2;

const rotateSingleLeft = <T>(left: Tree<T>, value: T, right: Node<T>): Node<T> =>
  node(node(left, value, right.left), right.value, right.right);

const rotateDoubleLeft = <T>(left: Tree<T>, value: T, right: Node<T>): Node<T> => {
  const rl = right.left as Node<T>; // right is heavier than left, so right.left exists
  return node(node(left, value, rl.left), rl.value, node(rl.right, right.value, right.right));
};

const rotateSingleRight = <T>(left: Node<T>, value: T, right: Tree<T>): Node<T> =>
  node(left.left, left.value, node(left.right, value, right));

const rotateDoubleRight = <T>(left: Node<T>, value: T, right: Tree<T>): Node<T> => {
  const lr = left.right as Node<T>;
  return node(node(left.left, left.value, lr.left), lr.value, node(lr.right, value, right));
};

/** Re-balance a node whose children may be off by one insert/remove. */
const balance = <T>(left: Tree<T>, value: T, right: Tree<T>): Node<T> => {
  const ls = sizeOf(left);
  const rs = sizeOf(right);
  if (ls + rs <= 1) return node(left, value, right);
  if (rs > DELTA * ls) {
    const r = right as Node<T>;
    return sizeOf(r.left) < RATIO * sizeOf(r.right)
      ? rotateSingleLeft(left, value, r)
      : rotateDoubleLeft(left, value, r);
  }
  if (ls > DELTA * rs) {
    const l = left as Node<T>;
    return sizeOf(l.right) < RATIO * sizeOf(l.left)
      ? rotateSingleRight(l, value, right)
      : rotateDoubleRight(l, value, right);
  }
  return node(left, value, right);
};

/** Insert (or, if `compare` finds an exact match, replace) a value. O(log n). */
export const insert = <T>(tree: Tree<T>, value: T, compare: (a: T, b: T) => number): Tree<T> => {
  if (tree === undefined) return node(undefined, value, undefined);
  const ordered = compare(value, tree.value);
  if (ordered < 0) return balance(insert(tree.left, value, compare), tree.value, tree.right);
  if (ordered > 0) return balance(tree.left, tree.value, insert(tree.right, value, compare));
  return node(tree.left, value, tree.right);
};

/** The maximum value of a non-empty tree, paired with the tree minus it. */
const withoutMax = <T>(tree: Node<T>): { readonly rest: Tree<T>; readonly max: T } => {
  if (tree.right === undefined) return { rest: tree.left, max: tree.value };
  const { rest, max } = withoutMax(tree.right);
  return { rest: balance(tree.left, tree.value, rest), max };
};

/** The minimum value of a non-empty tree, paired with the tree minus it. */
const withoutMin = <T>(tree: Node<T>): { readonly rest: Tree<T>; readonly min: T } => {
  if (tree.left === undefined) return { rest: tree.right, min: tree.value };
  const { rest, min } = withoutMin(tree.left);
  return { rest: balance(rest, tree.value, tree.right), min };
};

/** Join two trees known to be entirely left-of / right-of each other. */
const glue = <T>(left: Tree<T>, right: Tree<T>): Tree<T> => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (sizeOf(left) > sizeOf(right)) {
    const { rest, max } = withoutMax(left);
    return balance(rest, max, right);
  }
  const { rest, min } = withoutMin(right);
  return balance(left, min, rest);
};

/** Remove the value matching `compare`, if present. O(log n); a no-op returns the same reference. */
export const remove = <T>(tree: Tree<T>, value: T, compare: (a: T, b: T) => number): Tree<T> => {
  if (tree === undefined) return tree;
  const ordered = compare(value, tree.value);
  if (ordered < 0) {
    const left = remove(tree.left, value, compare);
    return left === tree.left ? tree : balance(left, tree.value, tree.right);
  }
  if (ordered > 0) {
    const right = remove(tree.right, value, compare);
    return right === tree.right ? tree : balance(tree.left, tree.value, right);
  }
  return glue(tree.left, tree.right);
};

/**
 * The value whose key matches `key` per `compare` (negative when `key`
 * belongs left of a node's value, positive when right, zero on a match), or
 * `undefined` if absent. O(log n) — a plain BST point lookup, independent of
 * rank, so a second tree can index the same elements by an unrelated key
 * (`LiveView`'s `byId` alongside its value-ordered `order`) just as cheaply
 * as a `Map`, but without a `Map`'s O(n) `new Map(bigMap)` copy on "update
 * one entry, keep the rest" (path-copying only touches O(log n) nodes).
 */
export const findBy = <T, K>(
  tree: Tree<T>,
  key: K,
  compare: (key: K, value: T) => number
): T | undefined => {
  let cursor = tree;
  while (cursor !== undefined) {
    const ordered = compare(key, cursor.value);
    if (ordered < 0) cursor = cursor.left;
    else if (ordered > 0) cursor = cursor.right;
    else return cursor.value;
  }
  return undefined;
};

/**
 * The 0-based rank of the value matching `compare`, or `-1` if absent.
 * O(log n).
 */
export const rankOf = <T>(tree: Tree<T>, value: T, compare: (a: T, b: T) => number): number => {
  let cursor = tree;
  let rank = 0;
  while (cursor !== undefined) {
    const ordered = compare(value, cursor.value);
    if (ordered < 0) {
      cursor = cursor.left;
    } else if (ordered > 0) {
      rank += sizeOf(cursor.left) + 1;
      cursor = cursor.right;
    } else {
      return rank + sizeOf(cursor.left);
    }
  }
  return -1;
};

/** The value at 0-based rank `index`, or `undefined` if out of bounds. O(log n). */
export const at = <T>(tree: Tree<T>, index: number): T | undefined => {
  let cursor = tree;
  let remaining = index;
  while (cursor !== undefined) {
    const leftSize = sizeOf(cursor.left);
    if (remaining < leftSize) cursor = cursor.left;
    else if (remaining === leftSize) return cursor.value;
    else {
      remaining -= leftSize + 1;
      cursor = cursor.right;
    }
  }
  return undefined;
};

/**
 * In-order values starting at 0-based rank `from`, one at a time — descending
 * to the start rank costs O(log n), and each subsequent value is amortized
 * O(1), so consuming `count` of them (via `slice`) is O(log n + count).
 */
function* inorderFrom<T>(tree: Tree<T>, from: number): IterableIterator<T> {
  const stack: Array<Node<T>> = [];
  let cursor = tree;
  let remaining = from;
  while (cursor !== undefined) {
    const leftSize = sizeOf(cursor.left);
    if (remaining < leftSize) {
      stack.push(cursor);
      cursor = cursor.left;
    } else if (remaining === leftSize) {
      stack.push(cursor);
      break;
    } else {
      remaining -= leftSize + 1;
      cursor = cursor.right;
    }
  }
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    yield top.value;
    stack.pop();
    let right = top.right;
    while (right !== undefined) {
      stack.push(right);
      right = right.left;
    }
  }
}

/** Up to `count` in-order values starting at 0-based rank `from`. O(log n + count). */
export const slice = <T>(tree: Tree<T>, from: number, count: number): ReadonlyArray<T> => {
  if (count <= 0 || from >= sizeOf(tree)) return [];
  const out: Array<T> = [];
  for (const value of inorderFrom(tree, Math.max(from, 0))) {
    if (out.length >= count) break;
    out.push(value);
  }
  return out;
};

/** Every value, in order. O(n) — the reference/full-materialization path. */
export const toArray = <T>(tree: Tree<T>): ReadonlyArray<T> => slice(tree, 0, sizeOf(tree));

/**
 * Build a tree from an array already sorted per `compare`. O(n): each half
 * roots at its middle element, which is already within the balance bound
 * (`|leftSize - rightSize| <= 1`), so `fromSorted` never rotates.
 */
export const fromSorted = <T>(sorted: ReadonlyArray<T>): Tree<T> => {
  const build = (lo: number, hi: number): Tree<T> => {
    if (lo >= hi) return undefined;
    const mid = (lo + hi) >>> 1;
    return node(build(lo, mid), sorted[mid]!, build(mid + 1, hi));
  };
  return build(0, sorted.length);
};
