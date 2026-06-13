/*
 * Transport.kt
 *
 * The customisable carrier seam for protocol messages (Transport.ts,
 * CONTEXT.md: "sync transport"). The engine consumes a `ClientTransport`;
 * concrete carriers (HTTP + SSE, WebSocket, an in-memory loopback for tests)
 * implement it. The Effect version exposes `pokes`/`statusChanges` as `Stream`s;
 * the Kotlin twin uses `Flow`.
 */

package au.thomasfoster.effectsync

import kotlinx.coroutines.flow.Flow

/** Connectivity of a client transport. */
enum class ConnectionStatus { CONNECTING, CONNECTED, DISCONNECTED }

/** The client side of a sync connection. */
interface ClientTransport {
    suspend fun push(request: PushRequest): PushResponse
    suspend fun pull(request: PullRequest): PullResponse

    /** Pokes from the server; may be empty for pull-only carriers. */
    fun pokes(): Flow<Poke>
    suspend fun status(): ConnectionStatus

    /** Emits the current status first, then changes. */
    fun statusChanges(): Flow<ConnectionStatus>
}
