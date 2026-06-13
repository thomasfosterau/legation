/*
 * Protocol.kt
 *
 * The sync protocol's schema-defined messages (Protocol.ts, ADR-0008). Mutator
 * intents flow up (push); server-computed state patches flow down (pull). The
 * protocol is carrier-agnostic — any transport that can move these
 * `@Serializable` values qualifies. `Pull(cookie) -> patch` is the canonical
 * correctness path.
 */

package au.thomasfoster.effectsync

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * One invocation of a mutator: name + args + per-client sequence number.
 * `mutationId` is sequential per client, giving the backend exactly-once,
 * in-order application and the client precise acknowledgement.
 */
@Serializable
data class Mutation(
    val clientId: String,
    val mutationId: Int,
    val mutator: String,
    val args: JsonElement,
    /** Client wall-clock at creation, in milliseconds; informational only. */
    val createdAt: Double,
)

/** Push request: pending mutations in journal order. */
@Serializable
data class PushRequest(
    val clientGroupId: String,
    val mutations: List<Mutation>,
)

/**
 * Push response: the highest mutation id the backend has applied, per client.
 * Effects arrive via the next pull's patch, which is when the optimistic overlay
 * drops.
 */
@Serializable
data class PushResponse(
    val lastMutationIds: Map<String, Int>,
)

/**
 * One patch operation. `Put` and `Del` address rows; `Clear` resets the client's
 * view (sent when the server does not recognize the cookie).
 */
@Serializable
sealed class PatchOp {
    @Serializable
    @SerialName("Put")
    data class Put(
        val collection: String,
        val id: String,
        val version: RowVersion,
        val value: JsonElement,
    ) : PatchOp()

    @Serializable
    @SerialName("Del")
    data class Del(val collection: String, val id: String) : PatchOp()

    @Serializable
    @SerialName("Clear")
    data object Clear : PatchOp()
}

/** Pull request: what the client has (cookie) and wants (subsets). */
@Serializable
data class PullRequest(
    val clientGroupId: String,
    /** Cookie from the previous pull; absent on first sync. */
    val cookie: String? = null,
    val subscriptions: List<Subset>,
)

/** Pull response: patch to the new cookie, plus mutation acknowledgements. */
@Serializable
data class PullResponse(
    val cookie: String,
    val patch: List<PatchOp>,
    val lastMutationIds: Map<String, Int>,
)

/** A contentless "pull soon" hint. */
@Serializable
data class Poke(val reason: String? = null)
