/**
 * Relationship-scoped read auth: an auth filter that consults a membership
 * source (another "collection") and returns an `id IN (allowed)` predicate over
 * a denormalized key, so two identities see disjoint rows of the same
 * collection. Identity reaches the filter via the IdentityResolver seam.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Authorization from "../Authorization.js";
import { Backend } from "../Backend.js";
import * as ClientEngineModule from "../ClientEngine.js";
import * as ClientStoreModule from "../ClientStore.js";
import { ClientStore } from "../ClientStore.js";
import * as Cvr from "../Cvr.js";
import * as InvalidationBus from "../InvalidationBus.js";
import * as MemoryBackend from "../MemoryBackend.js";
import * as Mutator from "../Mutator.js";
import * as Predicate from "../Predicate.js";
import * as Subset from "../Subset.js";
import * as SyncServer from "../SyncServer.js";
import { ClientTransport, makeInMemory, type ServerHandler } from "../Transport.js";

interface Issue {
  readonly id: string;
  readonly projectId: string;
}

const setIssue = Mutator.make("issue/set", Schema.Unknown);
const mutators = Mutator.registry([
  { mutator: setIssue, local: (args, writer) => writer.put("issues", (args as Issue).id, args) },
]);
const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "issue/set": (args, writer) => Effect.asVoid(writer.put("issues", (args as Issue).id, args)),
};

// Membership: which projects each user belongs to (the "relationship").
const memberships: Record<string, ReadonlyArray<string>> = {
  alice: ["p1"],
  bob: ["p2"],
};
// clientGroupId → user (a real carrier derives this from a verified token).
const users: Record<string, string> = { "group-alice": "alice", "group-bob": "bob" };

// Relationship-scoped auth: visible issues are those whose projectId is one the
// requesting user is a member of.
const issuesAuth: Authorization.AuthFilter = (context) => {
  const projects = memberships[context.identity as string] ?? [];
  return Effect.succeed(Predicate.isIn("projectId", projects));
};

const identityResolver: Authorization.IdentityResolver = {
  resolve: (clientGroupId) => Effect.succeed(users[clientGroupId]),
};

const handler = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(handlers);
  const cvrStore = yield* Cvr.makeMemoryStore;
  const bus = yield* InvalidationBus.makeInProcess;
  return yield* SyncServer.make.pipe(
    Effect.provideService(Backend, backend),
    Effect.provideService(Authorization.AuthPolicy, Authorization.policy({ issues: issuesAuth })),
    Effect.provideService(Authorization.IdentityResolver, identityResolver),
    Effect.provideService(Cvr.CvrStore, cvrStore),
    Effect.provideService(InvalidationBus.InvalidationBus, bus)
  );
});

const makeClient = (server: ServerHandler, user: string) =>
  Effect.gen(function* () {
    const store = yield* ClientStoreModule.makeMemory;
    const transport = yield* makeInMemory(server, `group-${user}`);
    return yield* ClientEngineModule.make({
      clientId: `client-${user}`,
      clientGroupId: `group-${user}`,
      mutators,
    }).pipe(
      Effect.provideService(ClientStore, store),
      Effect.provideService(ClientTransport, transport)
    );
  });

const allIssues = Subset.make({ collection: "issues" });
const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((r) => r.id).toSorted();

describe("relationship-scoped read auth", () => {
  it.effect("each identity sees only its projects' issues", () =>
    Effect.gen(function* () {
      const server = yield* handler;
      const alice = yield* makeClient(server, "alice");
      const bob = yield* makeClient(server, "bob");

      // Seed issues across two projects (any client can write; the server is
      // authoritative — auth here is read-side).
      yield* alice.mutate("issue/set", { id: "i1", projectId: "p1" });
      yield* alice.mutate("issue/set", { id: "i2", projectId: "p2" });
      yield* alice.mutate("issue/set", { id: "i3", projectId: "p1" });
      yield* alice.push;

      yield* alice.subscribe(allIssues);
      yield* bob.subscribe(allIssues);
      yield* alice.pull;
      yield* bob.pull;

      // Alice is a member of p1 → i1, i3; Bob of p2 → i2. The client predicate
      // is "all issues", but the auth filter narrowed each view server-side.
      expect(ids(yield* alice.query(allIssues))).toEqual(["i1", "i3"]);
      expect(ids(yield* bob.query(allIssues))).toEqual(["i2"]);
    }).pipe(Effect.scoped)
  );
});
