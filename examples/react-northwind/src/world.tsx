/**
 * World context — the demo side-channel (offline toggle, connection status).
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

export const useConnection = (): Transport.ConnectionStatus => {
  const world = useWorld();
  const [status, setStatus] = React.useState<Transport.ConnectionStatus>("connecting");
  React.useEffect(() => world.subscribeConnection(setStatus), [world]);
  return status;
};
