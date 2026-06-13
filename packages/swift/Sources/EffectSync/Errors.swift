//
//  Errors.swift
//  EffectSync
//
//  The sync engine's error vocabulary. The Effect implementation uses
//  `Data.TaggedError` subclasses dispatched on `_tag` (Errors.ts); the
//  idiomatic Swift equivalent is a single typed `Error` enum whose cases are
//  matched in `catch` and `switch`. Each case keeps a human-readable message;
//  the originating cause is preserved through the message so `SyncError` stays
//  `Equatable` (useful in tests and `XCTAssertEqual`).
//

import Foundation

/// Tagged errors shared across the sync engine, mirroring `Errors.ts`.
public enum SyncError: Error, Sendable, Equatable {
    /// A client or server storage operation failed (`StoreError`).
    case store(String)
    /// A protocol message could not be carried (`TransportError`).
    case transport(String)
    /// A received frame was not a valid protocol message (`ProtocolError`).
    case protocolMessage(String)
    /// The backend failed to apply mutations or evaluate a subscription (`BackendError`).
    case backend(String)
    /// A subscription or push was refused by auth filters (`AuthorizationError`).
    case authorization(String, collection: String?)
    /// The journal could not append, read, or acknowledge mutations (`JournalError`).
    case journal(String)
    /// A mutator was missing, its args failed validation, or it failed locally
    /// (`MutatorError`).
    case mutator(String, mutator: String?)

    /// The stable discriminator, matching the Effect error `_tag`.
    public var tag: String {
        switch self {
        case .store: return "StoreError"
        case .transport: return "TransportError"
        case .protocolMessage: return "ProtocolError"
        case .backend: return "BackendError"
        case .authorization: return "AuthorizationError"
        case .journal: return "JournalError"
        case .mutator: return "MutatorError"
        }
    }

    /// The human-readable message carried by the error.
    public var message: String {
        switch self {
        case let .store(message),
            let .transport(message),
            let .protocolMessage(message),
            let .backend(message),
            let .journal(message):
            return message
        case let .authorization(message, _):
            return message
        case let .mutator(message, _):
            return message
        }
    }
}

extension SyncError: LocalizedError {
    public var errorDescription: String? { "\(tag): \(message)" }
}
