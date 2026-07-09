/**
 * Demo controls context
 *
 * The engine's read/write API is `useQuery` / `useMutation` / `useMutationState`
 * (from the React bindings). The *demo* knobs — offline toggle, "remote edit",
 * connection status — live outside that API, so they ride a small React
 * context populated from {@link World.controls}.
 */
import * as React from "react";
import type { Connection, DemoControls } from "./sync";

const DemoContext = React.createContext<DemoControls | null>(null);

export const DemoProvider = (props: {
  readonly controls: DemoControls;
  readonly children: React.ReactNode;
}): React.ReactElement =>
  React.createElement(DemoContext.Provider, { value: props.controls }, props.children);

export const useDemo = (): DemoControls => {
  const controls = React.useContext(DemoContext);
  if (controls === null) throw new Error("useDemo must be used within <DemoProvider>");
  return controls;
};

/** Live transport connection status (emitted now and on every change). */
export const useConnection = (): Connection => {
  const controls = useDemo();
  const [status, setStatus] = React.useState<Connection>("connecting");
  React.useEffect(() => controls.subscribeConnection(setStatus), [controls]);
  return status;
};
