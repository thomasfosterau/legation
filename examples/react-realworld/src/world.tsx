/**
 * World context
 *
 * The demo side-channel the engine's `useQuery` / `useMutation` API doesn't
 * cover: telling the *server* which user this client is (`setIdentity`), the
 * offline toggle, and connection status.
 */
import * as React from "react";
import type { Transport } from "@thomasfosterau/effect-sync-core";
import type { World } from "./sync";

const WorldContext = React.createContext<World | null>(null);

export const WorldProvider = (props: {
  readonly world: World;
  readonly children: React.ReactNode;
}): React.ReactElement =>
  React.createElement(WorldContext.Provider, { value: props.world }, props.children);

export const useWorld = (): World => {
  const world = React.useContext(WorldContext);
  if (world === null) throw new Error("useWorld must be used within <WorldProvider>");
  return world;
};

/** Live transport connection status (emitted now and on every change). */
export const useConnection = (): Transport.ConnectionStatus => {
  const world = useWorld();
  const [status, setStatus] = React.useState<Transport.ConnectionStatus>("connecting");
  React.useEffect(() => world.subscribeConnection(setStatus), [world]);
  return status;
};
