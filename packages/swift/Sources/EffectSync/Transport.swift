//
//  Transport.swift
//  EffectSync
//
//  The customisable carrier seam for protocol messages (Transport.ts,
//  CONTEXT.md: "sync transport"). The engine consumes a `ClientTransport`;
//  concrete carriers (HTTP + SSE, WebSocket, an in-memory loopback for tests)
//  implement it. The Effect version exposes `pokes`/`statusChanges` as
//  `Stream`s; the Swift twin uses `AsyncStream`.
//

import Foundation

/// Connectivity of a client transport.
public enum ConnectionStatus: Sendable, Hashable {
    case connecting
    case connected
    case disconnected
}

/// The client side of a sync connection.
public protocol ClientTransport: Sendable {
    func push(_ request: PushRequest) async throws -> PushResponse
    func pull(_ request: PullRequest) async throws -> PullResponse
    /// Pokes from the server; may be empty for pull-only carriers.
    func pokes() -> AsyncStream<Poke>
    func status() async -> ConnectionStatus
    /// Emits the current status first, then changes.
    func statusChanges() -> AsyncStream<ConnectionStatus>
}
