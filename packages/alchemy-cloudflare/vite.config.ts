import { packageConfig } from "../../vite.package.ts";

export default packageConfig({
  entries: {
    index: "src/index.ts",
    BindingTransport: "src/BindingTransport.ts",
    D1Executor: "src/D1Executor.ts",
    DurableCvrStore: "src/DurableCvrStore.ts",
    DurableFanoutBroker: "src/DurableFanoutBroker.ts",
    EdgeInvalidation: "src/EdgeInvalidation.ts",
    FanoutShard: "src/FanoutShard.ts",
    Room: "src/Room.ts",
    RoomProtocol: "src/RoomProtocol.ts",
    RoomTransport: "src/RoomTransport.ts",
    Worker: "src/Worker.ts",
  },
});
