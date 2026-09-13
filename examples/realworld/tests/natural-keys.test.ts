/**
 * Conduit's natural keys end to end (#144).
 *
 * The domain declares `users`' identity as `username` and `articles`' as
 * `slug`, so this exercises the consequences an isolated unit test cannot: the
 * rows carry no duplicated `id`, the natural-key reads pass the server's
 * filterable-set check, and every edge joins against the identity each node
 * declares — `articles.author` → `users.username`, `comments.article` →
 * `articles.slug`, `favorites.article` → `articles.slug`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Stream } from "effect";
import {
  Authorization,
  Client,
  ClientStore,
  MemoryBackend,
  Server,
  Transport,
} from "@legation/effect";
import {
  CLIENT_GROUP_ID,
  CLIENT_ID,
  addComment,
  articleBySlug,
  articleComments,
  createArticle,
  favoriteArticle,
  favoriteId,
  favoriteRow,
  mutations,
  nodes,
  registerUser,
  registeredUser,
  shellReads,
  userProfile,
} from "../src/lib/domain";

const handlers = MemoryBackend.validatedHandlers([
  MemoryBackend.handler(registerUser, (a, w) => w.put("users", a.username, registeredUser(a))),
  MemoryBackend.handler(createArticle, (a, w) => w.put("articles", a.slug, a)),
  MemoryBackend.handler(addComment, (a, w) => w.put("comments", a.id, a)),
  MemoryBackend.handler(favoriteArticle, (a, w) =>
    w.put("favorites", favoriteId(a.userId, a.articleSlug), favoriteRow(a.userId, a.articleSlug))
  ),
]);

/** Reads are public, and the node graph bounds what may be filtered (#154). */
const authPolicy = Authorization.policy(
  {
    users: Authorization.allowAll,
    articles: Authorization.allowAll,
    comments: Authorization.allowAll,
    favorites: Authorization.allowAll,
    follows: Authorization.allowAll,
  },
  { collections: nodes.collections }
);

const makeClient = Effect.gen(function* () {
  const backend = yield* MemoryBackend.make(handlers);
  const server = yield* Server.make({
    backend,
    auth: { policy: authPolicy, identity: { resolve: () => Effect.succeed("emma") } },
  });
  const transport = yield* Transport.makeInMemory(server.handler, CLIENT_GROUP_ID);
  const store = yield* ClientStore.makeMemory;
  return yield* Client.make({
    nodes,
    mutations,
    clientId: CLIENT_ID,
    clientGroupId: CLIENT_GROUP_ID,
  }).pipe(
    Effect.provideService(ClientStore.ClientStore, store),
    Effect.provideService(Transport.ClientTransport, transport)
  );
});

/** One row of a read, once the observer has seen it. */
const firstRow = (client: Client.Client, read: Parameters<Client.Client["observe"]>[0]) =>
  Effect.gen(function* () {
    const latest = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]);
    yield* Effect.forkScoped(
      Stream.runForEach(client.observe(read), (rows) =>
        Ref.set(latest, rows as unknown as ReadonlyArray<Record<string, unknown>>)
      ).pipe(Effect.ignore)
    );
    for (let attempt = 0; attempt < 500; attempt++) {
      const rows = yield* Ref.get(latest);
      if (rows.length > 0) return rows[0]!;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    return yield* Effect.die(new Error(`no row for ${JSON.stringify(read)}`));
  });

const seed = (client: Client.Client) =>
  Effect.gen(function* () {
    yield* client.mutate("user/register", {
      username: "emma",
      email: "emma@conduit.dev",
      password: "demo",
    });
    yield* client.mutate("article/create", {
      slug: "hello-world",
      title: "Hello",
      description: "d",
      body: "b",
      tagList: ["intro"],
      authorId: "emma",
      createdAt: 1,
      updatedAt: 1,
    });
    yield* client.mutate("comment/add", {
      id: "c-1",
      articleSlug: "hello-world",
      authorId: "emma",
      body: "nice",
      createdAt: 2,
    });
    yield* client.mutate("favorite/add", { userId: "emma", articleSlug: "hello-world" });
  });

describe("Conduit over declared identity attributes", () => {
  it.effect("reads by slug and username, with every edge resolved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeClient;
        // The shell's pinned reads must all pass the filterable-set check.
        yield* Effect.forEach(shellReads, (read) => client.subscribe(read), { discard: true });
        yield* seed(client);

        const article = yield* firstRow(client, articleBySlug("hello-world"));
        const value = article["value"] as Record<string, unknown>;
        const related = article["related"] as Record<string, unknown>;
        // The slug IS the row id: no `id` attribute to keep equal to it.
        expect(value["slug"]).toBe("hello-world");
        expect("id" in value).toBe(false);
        expect(article["id"]).toBe("hello-world");
        // `articles.author` joins authorId → users.username.
        expect((related["author"] as Record<string, unknown>)["username"]).toBe("emma");
        // `articles.favorites` joins articles.slug → favorites.articleSlug.
        expect(related["favorites"]).toHaveLength(1);

        const profile = yield* firstRow(client, userProfile("emma"));
        const user = profile["value"] as Record<string, unknown>;
        expect(user["username"]).toBe("emma");
        expect("id" in user).toBe(false);
        expect(profile["id"]).toBe("emma");

        const comment = yield* firstRow(client, articleComments("hello-world"));
        const author = (comment["related"] as Record<string, unknown>)["author"];
        expect((author as Record<string, unknown>)["username"]).toBe("emma");
      })
    )
  );

  it("declares each node's identity, and derives the joins from it", () => {
    expect(nodes.nodes.get("users")!.id).toBe("username");
    expect(nodes.nodes.get("articles")!.id).toBe("slug");
    // A join collection's key is a pair, so it keeps a surrogate id.
    expect(nodes.nodes.get("favorites")!.id).toBe("id");

    expect(nodes.collections.get("articles")!.relationships).toContainEqual({
      name: "author",
      kind: "one",
      collection: "users",
      localField: "authorId",
      foreignField: "username",
    });
    expect(nodes.collections.get("users")!.relationships).toContainEqual({
      name: "articles",
      kind: "many",
      collection: "articles",
      localField: "username",
      foreignField: "authorId",
    });
    expect(nodes.collections.get("comments")!.relationships).toContainEqual({
      name: "article",
      kind: "one",
      collection: "articles",
      localField: "articleSlug",
      foreignField: "slug",
    });

    // The natural keys are filterable and sortable; the old literal is not.
    expect(nodes.nodes.get("articles")!.filterable["slug"]).toBeDefined();
    expect(nodes.nodes.get("articles")!.filterable["id"]).toBeUndefined();
    expect(nodes.nodes.get("articles")!.sortable).toEqual(["slug", "createdAt"]);
    expect(nodes.nodes.get("users")!.sortable).toEqual(["username"]);
  });
});
