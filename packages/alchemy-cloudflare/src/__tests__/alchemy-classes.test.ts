/**
 * The package's implementations bind to Alchemy's own Durable Object classes,
 * as an app binds them (README "Usage"). Compile-time mostly: `vp run check`
 * type-checks this file against the provider's declarations, so an
 * implementation that drifts from what `SomeClass.make(...)` accepts fails the
 * type gate. At run time the layers are only built, never run (that needs a
 * Worker).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Workers from "@alchemy.run/cloudflare/Workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Authorization, Node } from "@thomasfosterau/legation";
import * as FanoutShard from "../FanoutShard.js";
import * as Room from "../Room.js";

class LegationShard extends Workers.DurableObject<LegationShard, FanoutShard.ShardObject>()(
  "LegationShard"
) {}

class LegationRoom extends Workers.DurableObject<LegationRoom, Room.RoomObject>()("LegationRoom") {}

const nodes = Node.registry([Node.make("products", { attributes: { name: Schema.String } })]);

describe("Alchemy Durable Object classes", () => {
  it("take the shard and room implementations", () => {
    const shardLive = LegationShard.make(FanoutShard.make());
    const roomLive = LegationRoom.make(
      Room.make({
        nodes,
        // Never run: the layer is only built.
        backend: Effect.die("unused"),
        policy: Effect.succeed(Authorization.policy({ products: Authorization.allowAll })),
        shards: LegationShard,
      })
    );
    expect(Layer.isLayer(shardLive)).toBe(true);
    expect(Layer.isLayer(roomLive)).toBe(true);
  });
});
