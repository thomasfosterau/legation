import { packageConfig } from "../../vite.package.ts";

export default packageConfig({
  entries: {
    index: "src/index.ts",
    client: "src/client.ts",
    Principal: "src/Principal.ts",
    ReadScopes: "src/ReadScopes.ts",
    Resolver: "src/Resolver.ts",
  },
});
