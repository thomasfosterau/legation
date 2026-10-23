/**
 * The forgetting bound for a backend's rejection memory (#355, #366, #468): the
 * per-client rule that drops a remembered rejection once the client's next push
 * has moved past it. MemoryBackend and JsonApiBackend bound their memory with
 * `forgetBelow`; SqlBackend shares only `floorsOf` and keeps its own forgetting
 * loop over its ledger rows.
 */

import * as Arr from "effect/Array";

/**
 * The lowest mutation id a push carries, per client: the push's floors (#355).
 * A client resends only ids it has not had acknowledged, so a push whose lowest
 * id for a client is `f` proves the client has seen the outcome of every id below `f`.
 */
export const floorsOf = (
  mutations: ReadonlyArray<{ readonly clientId: string; readonly mutationId: number }>
): Map<string, number> => {
  const floors = new Map<string, number>();
  Arr.forEach(mutations, ({ clientId, mutationId }) => {
    floors.set(clientId, Math.min(floors.get(clientId) ?? Infinity, mutationId));
  });
  return floors;
};

/**
 * Forget the rejections a client's push has moved past (#355): drop each client's
 * remembered rejections whose mutation id is below its floor, and keep the rest.
 * `clients` maps each client in one client group to its remembered rejections
 * (mutation id → reason); `floors` maps each client in a push to the lowest
 * mutation id that push carries (see {@link floorsOf}). A client with no
 * rejections left is removed from the result, and a pull never forgets, so only
 * a push calls this. Returns `clients` itself when nothing is forgotten, so a
 * caller can detect the no-op by reference.
 */
export const forgetBelow = (
  clients: ReadonlyMap<string, ReadonlyMap<number, string>>,
  floors: ReadonlyMap<string, number>
): ReadonlyMap<string, ReadonlyMap<number, string>> => {
  let kept: Map<string, ReadonlyMap<number, string>> | undefined;
  Arr.forEach(floors, ([clientId, floor]) => {
    const ids = clients.get(clientId);
    if (ids === undefined) return;
    const remaining = new Map([...ids].filter(([mutationId]) => mutationId >= floor));
    if (remaining.size === ids.size) return;
    kept ??= new Map(clients);
    if (remaining.size === 0) kept.delete(clientId);
    else kept.set(clientId, remaining);
  });
  return kept ?? clients;
};
