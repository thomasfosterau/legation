//
//  Protocol.swift
//  EffectSync
//
//  The sync protocol's schema-defined messages (Protocol.ts, ADR-0008). Mutator
//  intents flow up (push); server-computed state patches flow down (pull). The
//  protocol is carrier-agnostic — any transport that can move these `Codable`
//  values qualifies. `Pull(cookie) -> patch` is the canonical correctness path.
//

import Foundation

// MARK: - Mutations (upstream)

/// One invocation of a mutator: name + args + per-client sequence number.
/// `mutationId` is sequential per client, giving the backend exactly-once,
/// in-order application and the client precise acknowledgement.
public struct Mutation: Sendable, Hashable, Codable {
    public let clientId: String
    public let mutationId: Int
    public let mutator: String
    public let args: JSONValue
    /// Client wall-clock at creation, in milliseconds; informational only.
    public let createdAt: Double

    public init(
        clientId: String,
        mutationId: Int,
        mutator: String,
        args: JSONValue,
        createdAt: Double
    ) {
        self.clientId = clientId
        self.mutationId = mutationId
        self.mutator = mutator
        self.args = args
        self.createdAt = createdAt
    }
}

/// Push request: pending mutations in journal order.
public struct PushRequest: Sendable, Hashable, Codable {
    public let clientGroupId: String
    public let mutations: [Mutation]

    public init(clientGroupId: String, mutations: [Mutation]) {
        self.clientGroupId = clientGroupId
        self.mutations = mutations
    }
}

/// Push response: the highest mutation id the backend has applied, per client.
/// Effects arrive via the next pull's patch, which is when the optimistic
/// overlay drops.
public struct PushResponse: Sendable, Hashable, Codable {
    public let lastMutationIds: [String: Int]

    public init(lastMutationIds: [String: Int]) {
        self.lastMutationIds = lastMutationIds
    }
}

// MARK: - Patches (downstream)

/// One patch operation. `put` and `del` address rows; `clear` resets the
/// client's view (sent when the server does not recognize the cookie).
public enum PatchOp: Sendable, Hashable {
    case put(collection: String, id: String, version: RowVersion, value: JSONValue)
    case del(collection: String, id: String)
    case clear
}

extension PatchOp: Codable {
    private enum CodingKeys: String, CodingKey {
        case tag = "_tag"
        case collection, id, version, value
    }

    private enum Tag: String, Codable {
        case put = "Put"
        case del = "Del"
        case clear = "Clear"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Tag.self, forKey: .tag) {
        case .put:
            self = .put(
                collection: try container.decode(String.self, forKey: .collection),
                id: try container.decode(String.self, forKey: .id),
                version: try container.decode(RowVersion.self, forKey: .version),
                value: try container.decode(JSONValue.self, forKey: .value)
            )
        case .del:
            self = .del(
                collection: try container.decode(String.self, forKey: .collection),
                id: try container.decode(String.self, forKey: .id)
            )
        case .clear:
            self = .clear
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .put(collection, id, version, value):
            try container.encode(Tag.put, forKey: .tag)
            try container.encode(collection, forKey: .collection)
            try container.encode(id, forKey: .id)
            try container.encode(version, forKey: .version)
            try container.encode(value, forKey: .value)
        case let .del(collection, id):
            try container.encode(Tag.del, forKey: .tag)
            try container.encode(collection, forKey: .collection)
            try container.encode(id, forKey: .id)
        case .clear:
            try container.encode(Tag.clear, forKey: .tag)
        }
    }
}

/// Pull request: what the client has (cookie) and wants (subsets).
public struct PullRequest: Sendable, Hashable, Codable {
    public let clientGroupId: String
    /// Cookie from the previous pull; absent on first sync.
    public let cookie: String?
    public let subscriptions: [Subset]

    public init(clientGroupId: String, cookie: String?, subscriptions: [Subset]) {
        self.clientGroupId = clientGroupId
        self.cookie = cookie
        self.subscriptions = subscriptions
    }
}

/// Pull response: patch to the new cookie, plus mutation acknowledgements.
public struct PullResponse: Sendable, Hashable, Codable {
    public let cookie: String
    public let patch: [PatchOp]
    public let lastMutationIds: [String: Int]

    public init(cookie: String, patch: [PatchOp], lastMutationIds: [String: Int]) {
        self.cookie = cookie
        self.patch = patch
        self.lastMutationIds = lastMutationIds
    }
}

/// A contentless "pull soon" hint.
public struct Poke: Sendable, Hashable, Codable {
    public let reason: String?

    public init(reason: String? = nil) {
        self.reason = reason
    }
}
