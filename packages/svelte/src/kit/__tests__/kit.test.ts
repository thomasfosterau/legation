/**
 * SvelteKit integration: the client-group cookie is minted once and then
 * stable; `loadSnapshot` renders a request-scoped snapshot under it; and
 * `clientRuntime` boots a Client whose store took the snapshot (empty-store
 * only), reading rows with no transport call and converging on the first pull
 * without a reset.
 */
import { describe, expect, it } from "@effect/vitest";
import type { Cookies } from "@sveltejs/kit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  Authorization,
  Backend,
  Client,
  ClientStore,
  Hydration,
  MemoryBackend,
  Mutation,
  MutationRejected,
  Node,
  type Query,
  Server,
  Transport,
} from "@thomasfosterau/legation-effect";
import {
  ClientEngine,
  Cvr,
  InvalidationBus,
  Subset,
  SyncServer,
} from "@thomasfosterau/legation-effect/internal";
import type { SubmitFunction } from "$app/forms";
import {
  FORM_CLIENT_FIELD,
  FORM_MUTATION_FIELD,
  RECEIPT_KEY,
  clientGroupId,
  clientRuntime,
  enhanceFormMutation,
  formMutationTarget,
  loadSnapshot,
  mintFormClient,
  receiptOf,
  runFormMutation,
} from "../index.js";

interface Todo {
  readonly id: string;
  readonly title: string;
}

const mutations = Mutation.registry([
  {
    mutator: Mutation.make("todo/set", Schema.Unknown),
    local: (args, writer) => writer.put("todos", (args as Todo).id, args),
  },
]);

const nodes = Node.registry([Node.make("todos", { attributes: { title: Schema.String } })]);

const handlers: Record<string, MemoryBackend.BackendHandler> = {
  "todo/set": (args, writer) => Effect.asVoid(writer.put("todos", (args as Todo).id, args)),
};

const makeServer: Effect.Effect<Transport.ServerHandler, never, Scope.Scope> = Effect.gen(
  function* () {
    const backend = yield* MemoryBackend.make(handlers);
    const cvrStore = yield* Cvr.makeMemoryStore;
    const bus = yield* InvalidationBus.makeInProcess;
    return yield* SyncServer.make.pipe(
      Effect.provideService(Backend.Backend, backend),
      Effect.provideService(
        Authorization.AuthPolicy,
        Authorization.policy({ todos: Authorization.allowAll })
      ),
      Effect.provideService(Cvr.CvrStore, cvrStore),
      Effect.provideService(InvalidationBus.InvalidationBus, bus)
    );
  }
);

/** A minimal fake of Kit's `Cookies` backed by a Map, recording sets. */
const fakeCookies = (): { cookies: Cookies; sets: Array<{ name: string; value: string }> } => {
  const jar = new Map<string, string>();
  const sets: Array<{ name: string; value: string }> = [];
  const cookies: Cookies = {
    get: (name: string) => jar.get(name),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => {
      jar.set(name, value);
      sets.push({ name, value });
    },
    delete: (name: string) => void jar.delete(name),
    serialize: () => "",
    // Nothing under test parses a `Set-Cookie` header.
    parse: () => {
      throw new Error("fakeCookies: parse is not faked");
    },
  };
  return { cookies, sets };
};

const allTodosSubset = Subset.make({ collection: "todos" });
const allTodos: Query.Read = { collection: "todos" };

describe("clientGroupId", () => {
  it("mints once and stays stable across requests", () => {
    const { cookies, sets } = fakeCookies();
    const first = clientGroupId(cookies);
    const second = clientGroupId(cookies);
    expect(first).toBe(second);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.name).toBe("legation-client-group");
  });

  it("honours a custom name and generator", () => {
    const { cookies } = fakeCookies();
    const id = clientGroupId(cookies, { name: "cg", generate: () => "fixed" });
    expect(id).toBe("fixed");
    expect(cookies.get("cg")).toBe("fixed");
  });
});

describe("loadSnapshot + clientRuntime", () => {
  it.effect("SSR snapshot boots a Client that reads without transport and pulls no reset", () =>
    Effect.gen(function* () {
      const handler = yield* makeServer;

      // Authoritative rows exist server-side.
      const writerStore = yield* ClientStore.makeMemory;
      const writerTransport = yield* Transport.makeInMemory(handler, "group-writer");
      const writer = yield* ClientEngine.make({
        clientId: "writer",
        clientGroupId: "group-writer",
        mutators: mutations,
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, writerStore),
        Effect.provideService(Transport.ClientTransport, writerTransport)
      );
      yield* writer.subscribe(allTodosSubset);
      yield* writer.mutate("todo/set", { id: "1", title: "first" });
      yield* writer.push;

      // The load: mint the group cookie, snapshot the page's reads under it.
      const { cookies } = fakeCookies();
      const { snapshot, clientGroupId: group } = yield* loadSnapshot(cookies, {
        nodes,
        reads: [allTodos],
      }).pipe(Effect.provideService(Transport.ServerHandler, handler));
      expect(snapshot.rows.map((row) => row.id)).toEqual(["1"]);
      expect(cookies.get("legation-client-group")).toBe(group);

      // The client boot: snapshot-hydrated store, Client over it.
      const runtime = clientRuntime({
        nodes,
        mutations,
        clientId: "browser",
        clientGroupId: group,
        store: ClientStore.layerMemory,
        transport: Transport.layerInMemory(group).pipe(
          Layer.provide(Layer.succeed(Transport.ServerHandler)(handler))
        ),
        snapshot,
        subscribe: [allTodos],
      });

      const rows = yield* Effect.promise(() =>
        runtime.runPromise(Effect.flatMap(Client.Client, (client) => client.query(allTodos)))
      );
      expect(rows.map((row) => row.id)).toEqual(["1"]);

      // A new authoritative write arrives on the client's first pull. The
      // Client owns the sync loop, so this is the loop converging, not a
      // hand-driven pull.
      yield* writer.mutate("todo/set", { id: "2", title: "second" });
      yield* writer.push;
      const after = yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.flatMap(Client.Client, (client) =>
            Effect.andThen(
              Effect.retry(
                Effect.flatMap(client.query(allTodos), (current) =>
                  current.length === 2 ? Effect.void : Effect.fail("not yet" as const)
                ),
                { times: 100, schedule: Schedule.spaced("20 millis") }
              ),
              client.query(allTodos)
            )
          )
        )
      );
      expect(after.map((row) => row.id).toSorted()).toEqual(["1", "2"]);

      yield* Effect.promise(() => runtime.dispose());
    })
  );

  it.effect("renders against a separate backend over a supplied transport", () =>
    Effect.gen(function* () {
      // The backend is somewhere else entirely (another Worker): the `load`
      // holds a carrier to it, not the handler. Nothing is provided to this
      // effect — `ServerHandler` never enters the load's context.
      const handler = yield* makeServer;
      const writerStore = yield* ClientStore.makeMemory;
      const writerTransport = yield* Transport.makeInMemory(handler, "group-writer");
      const writer = yield* ClientEngine.make({
        clientId: "writer",
        clientGroupId: "group-writer",
        mutators: mutations,
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, writerStore),
        Effect.provideService(Transport.ClientTransport, writerTransport)
      );
      yield* writer.subscribe(allTodosSubset);
      yield* writer.mutate("todo/set", { id: "1", title: "remote" });
      yield* writer.push;

      const { cookies } = fakeCookies();
      const remote: Transport.ClientTransport = yield* Transport.makeInMemory(
        handler,
        "group-remote"
      );
      const loaded = yield* loadSnapshot(cookies, {
        nodes,
        reads: [allTodos],
        transport: remote,
        cookie: { generate: () => "group-remote" },
      });

      expect(loaded.clientGroupId).toBe("group-remote");
      expect(loaded.snapshot.rows.map((row) => row.id)).toEqual(["1"]);
      expect(loaded.snapshot.cookie).toBeDefined();

      // The cookie continues the conversation: the browser's first pull over
      // its own carrier gets a delta, not a `Clear` and a full re-send.
      const browserStore = yield* ClientStore.makeMemory;
      const browserTransport = yield* Transport.makeInMemory(handler, loaded.clientGroupId);
      const browser = yield* ClientEngine.make({
        clientId: "browser",
        clientGroupId: loaded.clientGroupId,
        mutators: mutations,
      }).pipe(
        Effect.provideService(ClientStore.ClientStore, browserStore),
        Effect.provideService(Transport.ClientTransport, browserTransport)
      );
      expect(yield* Hydration.hydrateIfEmpty(browserStore, loaded.snapshot)).toBe(true);
      yield* browser.subscribe(allTodosSubset);
      const patch = yield* browserTransport.pull({
        clientGroupId: loaded.clientGroupId,
        cookie: loaded.snapshot.cookie,
        subscriptions: [allTodosSubset],
      });
      expect(patch.patch.some((op) => op._tag === "Clear")).toBe(false);
      expect(patch.patch).toEqual([]);
    })
  );

  it.effect("hydrateIfEmpty leaves a populated durable store untouched", () =>
    Effect.gen(function* () {
      const store = yield* ClientStore.makeMemory;
      yield* store.putRow("todos", { id: "9", version: 9, value: { id: "9", title: "newer" } });
      yield* store.setCookie("newer-cookie");
      const stale: Hydration.Snapshot = {
        rows: [{ collection: "todos", id: "1", version: 1, value: { id: "1", title: "stale" } }],
        cookie: "stale-cookie",
        journal: [],
      };
      expect(yield* Hydration.hydrateIfEmpty(store, stale)).toBe(false);
      expect(yield* store.getCookie).toBe("newer-cookie");
      expect((yield* store.listRows("todos")).map((row) => row.id)).toEqual(["9"]);
    })
  );
});

// ─── Form-action Mutations (ADR-0030 #215) ──────────────────────────────────

const Tally = Schema.Struct({ id: Schema.String, n: Schema.Number });
const asTally = Schema.decodeUnknownOption(Tally);
const tallyArgs = Schema.Struct({ id: Schema.String });
// A non-idempotent tally: a double application shows as `n: 2`.
const tallyUp = Mutation.make("tally/up", tallyArgs);
const tallyLocked = Mutation.make("tally/locked", tallyArgs);
const nextTally = (id: string, current: Option.Option<typeof Tally.Type>) => ({
  id,
  n: Option.match(current, { onNone: () => 0, onSome: (tally) => tally.n }) + 1,
});
const tallyMutations = Mutation.registry([
  {
    mutator: tallyUp,
    local: (args, writer) =>
      Effect.flatMap(writer.get("tallies", args.id), (row) =>
        writer.put("tallies", args.id, nextTally(args.id, asTally(row)))
      ),
  },
  {
    mutator: tallyLocked,
    local: (args, writer) => writer.put("tallies", args.id, nextTally(args.id, Option.none())),
  },
]);
const tallyNodes = Node.registry([Node.make("tallies", { attributes: { n: Schema.Number } })]);
const allTallies: Query.Read = { collection: "tallies" };

const makeTallyServer = Effect.fn("makeTallyServer")(function* () {
  const backend = yield* MemoryBackend.make(
    MemoryBackend.validatedHandlers([
      MemoryBackend.handler(tallyUp, (args, writer) =>
        Effect.flatMap(writer.get("tallies", args.id), (row) =>
          writer.put("tallies", args.id, nextTally(args.id, asTally(row)))
        )
      ),
      MemoryBackend.handler(tallyLocked, () =>
        Effect.fail(new MutationRejected({ reason: "tally is locked" }))
      ),
    ])
  );
  const server = yield* Server.make({
    backend,
    auth: { policy: Authorization.policy({ tallies: Authorization.allowAll }) },
  });
  return { backend, server };
});

// What a browser posts for a form rendered with `form`'s hidden fields.
const postedForm = (form: { clientId: string; mutationId: number }, id: string) => {
  const data = new FormData();
  data.set(FORM_CLIENT_FIELD, form.clientId);
  data.set(FORM_MUTATION_FIELD, String(form.mutationId));
  data.set("id", id);
  return data;
};

// The form layer's decode of the posted fields into the Mutation's args.
const tallyArgsOf = (data: FormData) => ({ id: String(data.get("id")) });

describe("form-action Mutations (ADR-0030 #215)", () => {
  it.effect("the no-JS path: a rendered form resubmitted is applied once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, server } = yield* makeTallyServer();
        const { cookies } = fakeCookies();
        const group = clientGroupId(cookies, { generate: () => "group-nojs" });

        // The page's `load` mints a form client and renders it in hidden fields.
        const form = mintFormClient(() => "rendered");
        expect(form).toEqual({ clientId: "form-rendered", mutationId: 1 });

        // The action, run once per POST of the same rendered form.
        const action = (data: FormData) =>
          Effect.gen(function* () {
            const target = formMutationTarget(cookies, data);
            expect(target).toEqual({ clientGroupId: group, ...form });
            if (target === undefined) return yield* Effect.die("unroutable");
            const receipt = yield* runFormMutation(server, target, tallyUp, tallyArgsOf(data));
            return { [RECEIPT_KEY]: receipt };
          });
        const first = yield* action(postedForm(form, "t1"));
        const second = yield* action(postedForm(form, "t1"));
        expect(first[RECEIPT_KEY]).toEqual({ ...form, phase: "acknowledged" });
        expect(second).toEqual(first);
        const rows = yield* backend.getRows({ clientGroupId: group }, "tallies", ["t1"]);
        expect(rows.map((row) => row.value)).toEqual([{ id: "t1", n: 1 }]);
      })
    )
  );

  it("an action that cannot name the group or the form is not routed", () => {
    const { cookies } = fakeCookies();
    expect(
      formMutationTarget(cookies, postedForm({ clientId: "form-x", mutationId: 1 }, "t"))
    ).toBe(undefined);
    clientGroupId(cookies);
    expect(formMutationTarget(cookies, new FormData())).toBe(undefined);
    const malformed = postedForm({ clientId: "form-x", mutationId: 0 }, "t");
    expect(formMutationTarget(cookies, malformed)).toBe(undefined);
  });

  it("reads a receipt off an action result, and nothing off one without it", () => {
    const receipt = { clientId: "form-a", mutationId: 1, phase: "rejected", reason: "no" };
    expect(receiptOf({ type: "failure", data: { [RECEIPT_KEY]: receipt } })).toEqual(receipt);
    expect(receiptOf({ type: "success", data: {} })).toBe(undefined);
    expect(receiptOf({ type: "redirect" })).toBe(undefined);
    expect(
      receiptOf({ type: "success", data: { [RECEIPT_KEY]: { ...receipt, phase: "pending" } } })
    ).toBe(undefined);
  });

  it.effect("the enhanced submit overlays, settles on the receipt and skips the load re-run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeTallyServer();
        const { cookies } = fakeCookies();
        const group = clientGroupId(cookies, { generate: () => "group-js" });
        const runtime = clientRuntime({
          nodes: tallyNodes,
          mutations: tallyMutations,
          clientId: "browser",
          clientGroupId: group,
          store: ClientStore.layerMemory,
          transport: Transport.layerInMemory(group).pipe(
            Layer.provide(Layer.succeed(Transport.ServerHandler)(server.handler))
          ),
          subscribe: [allTallies],
        });
        const query = Effect.tryPromise(() =>
          runtime.runPromise(
            Effect.flatMap(Client.Client, (client) => client.query(allTallies)).pipe(
              Effect.map((rows) => rows.map((row) => row.value))
            )
          )
        );

        const receipts: Array<Server.Receipt> = [];
        const enhanced = enhanceFormMutation(runtime, {
          mutation: tallyUp,
          args: tallyArgsOf,
          generate: () => "enhanced",
          onReceipt: (receipt) => void receipts.push(receipt),
        });
        const data = new FormData();
        data.set("id", "t2");
        // The returned function is a SvelteKit `SubmitFunction`, for `use:enhance`.
        const submit: SubmitFunction = enhanced;
        expect(submit).toBe(enhanced);
        const settle = enhanced({ formData: data });
        // The submit writes a fresh form client into the posted fields.
        expect(data.get(FORM_CLIENT_FIELD)).toBe("form-enhanced");
        expect(data.get(FORM_MUTATION_FIELD)).toBe("1");

        // The action runs on the server with what was posted.
        const target = formMutationTarget(cookies, data);
        if (target === undefined) return yield* Effect.die("unroutable");
        const receipt = yield* runFormMutation(server, target, tallyUp, tallyArgsOf(data));

        const updates: Array<unknown> = [];
        yield* Effect.tryPromise(() =>
          settle({
            result: { type: "success", data: { [RECEIPT_KEY]: receipt } },
            update: (options) => {
              updates.push(options);
              return Promise.resolve();
            },
          })
        );
        expect(receipts).toEqual([
          { clientId: "form-enhanced", mutationId: 1, phase: "acknowledged" },
        ]);
        expect(updates).toEqual([{ refreshAll: false }]);
        // Shown from the tail, then from the confirmed rows: applied once.
        expect(yield* query).toEqual([{ id: "t2", n: 1 }]);

        yield* Effect.tryPromise(() => runtime.dispose());
      })
    )
  );

  it.effect("a rejected receipt drops the effect and reaches the form layer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server } = yield* makeTallyServer();
        const { cookies } = fakeCookies();
        const group = clientGroupId(cookies, { generate: () => "group-rejected" });
        const runtime = clientRuntime({
          nodes: tallyNodes,
          mutations: tallyMutations,
          clientId: "browser",
          clientGroupId: group,
          store: ClientStore.layerMemory,
          transport: Transport.layerInMemory(group).pipe(
            Layer.provide(Layer.succeed(Transport.ServerHandler)(server.handler))
          ),
        });
        const receipts: Array<Server.Receipt> = [];
        const settle = enhanceFormMutation(runtime, {
          mutation: tallyLocked,
          args: tallyArgsOf,
          onReceipt: (receipt) => void receipts.push(receipt),
        })({ formData: postedForm({ clientId: "", mutationId: 1 }, "t3") });
        const query = Effect.tryPromise(() =>
          runtime.runPromise(Effect.flatMap(Client.Client, (client) => client.query(allTallies)))
        );
        const target = formMutationTarget(
          cookies,
          postedForm({ clientId: "form-z", mutationId: 1 }, "t3")
        );
        if (target === undefined) return yield* Effect.die("unroutable");
        const receipt = yield* runFormMutation(server, target, tallyLocked, { id: "t3" });
        yield* Effect.tryPromise(() =>
          settle({
            result: { type: "failure", data: { [RECEIPT_KEY]: receipt } },
            update: () => Promise.resolve(),
          })
        );
        expect(receipts.map((r) => (r.phase === "rejected" ? r.reason : r.phase))).toEqual([
          "tally is locked",
        ]);
        expect(yield* query).toEqual([]);
        yield* Effect.tryPromise(() => runtime.dispose());
      })
    )
  );
});
