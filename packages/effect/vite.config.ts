import { packageConfig } from "../../vite.package.ts";

// `.` is the app surface, `./internal` the engine seams for adapter authors
// (ADR-0022), `./sql` the SQL reference backend (ADR-0033). Each module on
// `.` also has its own PascalCase subpath (`./Node`).
export default packageConfig({
  entries: {
    index: "src/index.ts",
    internal: "src/internal.ts",
    "sql/index": "src/sql/index.ts",
    Node: "src/Node.ts",
    Edge: "src/Edge.ts",
    Collection: "src/Collection.ts",
    Query: "src/Query.ts",
    Aggregate: "src/Aggregate.ts",
    Mutator: "src/Mutator.ts",
    CrudMutation: "src/CrudMutation.ts",
    Client: "src/Client.ts",
    ClientStore: "src/ClientStore.ts",
    Identity: "src/Identity.ts",
    Transport: "src/Transport.ts",
    Hydration: "src/Hydration.ts",
    Server: "src/Server.ts",
    Backend: "src/Backend.ts",
    MemoryBackend: "src/MemoryBackend.ts",
    Authorization: "src/Authorization.ts",
    FilterPolicy: "src/FilterPolicy.ts",
    Predicate: "src/Predicate.ts",
  },
});
