/**
 * Demo controls context
 *
 * The engine's read/write API is `useQuery` / `useMutation` (from the React
 * bindings). The *demo* knobs — offline toggle, "remote edit", the durable
 * journal, connection status — live outside that API, so they ride a small
 * React context populated from {@link World.controls}.
 */
import * as React from "react";
import type { Connection, DemoControls, PendingEntry } from "./sync";

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

/**
 * The durable journal, driven by `EngineIntrospection` (#45): the panel
 * re-renders on every engine lifecycle event (journal, push, pull, rebuild),
 * so push acks that trim the journal show up without polling.
 */
export const usePending = (): ReadonlyArray<PendingEntry> => {
  const controls = useDemo();
  const [pending, setPending] = React.useState<ReadonlyArray<PendingEntry>>([]);
  React.useEffect(() => controls.subscribeJournal(setPending), [controls]);
  return pending;
};
