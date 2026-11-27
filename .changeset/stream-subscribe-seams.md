---
"@thomasfosterau/legation": minor
"@thomasfosterau/legation-browser": minor
"@thomasfosterau/legation-alchemy-cloudflare": minor
---

The carrier seams' subscriptions are now streams instead of pull-style `{ take }` handles. `MirrorChannel.subscribe`, `BusBroker.subscribe`, `InvalidationBus.subscribe` and `FanoutBroker.pokes` return `Effect<Stream<A>, never, Scope>`: the subscription is still open once the effect completes, so nothing published afterwards is missed however late the stream runs, and it still closes with the scope. The stream is single-use, keeps arrival order, and ends when the scope closes. Buffering is unchanged: the in-process bus, the memory broker and the in-process fan-out broker stay bounded and dropping; the listener-backed carriers stay unbounded. `MirrorChannel.MirrorInbox`, `InvalidationBus.HintSubscription` and `FanoutBroker.TopicPokes` are removed.

**Migration.**

- A consumer that looped on `take` runs the stream: replace `const sub = yield* bus.subscribe; yield* Effect.forkScoped(Effect.forever(sub.take.pipe(Effect.flatMap(handle))))` with `const hints = yield* bus.subscribe; yield* Effect.forkScoped(Stream.runForEach(hints, handle))`. The same goes for `channel.subscribe` and `broker.pokes(roomId)`.
- A custom `BusBroker` or `MirrorChannel` over an event source no longer feeds a queue by hand: build the stream with `Stream.fromEventListener` (or `Stream.callback`) and open it with `MirrorChannel.subscribeNow`, as in `subscribe: MirrorChannel.subscribeNow(Stream.fromEventListener(socket, "message").pipe(Stream.map((event) => event.data)))`. A broker over a `PubSub` returns `Effect.map(PubSub.subscribe(hub), Stream.fromSubscription)`. A custom `FanoutBroker.pokes` returns a stream the same way.
