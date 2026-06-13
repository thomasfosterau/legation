/*
 * Errors.kt
 *
 * The sync engine's error vocabulary. The Effect implementation uses
 * `Data.TaggedError` subclasses dispatched on `_tag` (Errors.ts); the idiomatic
 * Kotlin equivalent is a sealed exception hierarchy matched in `catch` /
 * `when`. Each carries a human-readable message; `tag` exposes the same
 * discriminator the Effect errors carry.
 */

package au.thomasfoster.effectsync

/** Tagged errors shared across the sync engine, mirroring `Errors.ts`. */
sealed class SyncException(message: String) : Exception(message) {
    /** A client or server storage operation failed (`StoreError`). */
    class StoreError(message: String) : SyncException(message)

    /** A protocol message could not be carried (`TransportError`). */
    class TransportError(message: String) : SyncException(message)

    /** A received frame was not a valid protocol message (`ProtocolError`). */
    class ProtocolError(message: String) : SyncException(message)

    /** The backend failed to apply mutations or evaluate a subscription. */
    class BackendError(message: String) : SyncException(message)

    /** A subscription or push was refused by auth filters. */
    class AuthorizationError(message: String, val collection: String? = null) :
        SyncException(message)

    /** The journal could not append, read, or acknowledge mutations. */
    class JournalError(message: String) : SyncException(message)

    /** A mutator was missing, its args failed validation, or it failed locally. */
    class MutatorError(message: String, val mutator: String? = null) : SyncException(message)

    /** The stable discriminator, matching the Effect error `_tag`. */
    val tag: String
        get() = when (this) {
            is StoreError -> "StoreError"
            is TransportError -> "TransportError"
            is ProtocolError -> "ProtocolError"
            is BackendError -> "BackendError"
            is AuthorizationError -> "AuthorizationError"
            is JournalError -> "JournalError"
            is MutatorError -> "MutatorError"
        }
}
