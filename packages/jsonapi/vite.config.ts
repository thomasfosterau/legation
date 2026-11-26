import { packageConfig } from "../../vite.package.ts";

export default packageConfig({
  entries: {
    index: "src/index.ts",
    schema: "src/schema.ts",
    CollectionLoader: "src/CollectionLoader.ts",
    Convention: "src/Convention.ts",
    Derive: "src/Derive.ts",
    DocumentWriter: "src/DocumentWriter.ts",
    JsonApiBackend: "src/JsonApiBackend.ts",
    JsonApiFacade: "src/JsonApiFacade.ts",
    FacadeWrites: "src/FacadeWrites.ts",
    JsonApiQuery: "src/JsonApiQuery.ts",
    JsonApiSync: "src/JsonApiSync.ts",
    MutationStatus: "src/MutationStatus.ts",
    Ledger: "src/Ledger.ts",
    NodeBridge: "src/NodeBridge.ts",
    Relationships: "src/Relationships.ts",
    ReplicaDocuments: "src/ReplicaDocuments.ts",
    RestHandlers: "src/RestHandlers.ts",
  },
});
