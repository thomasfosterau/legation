/**
 * Demo controls context + stores
 *
 * The engine's read/write API is `query` / `getMutate` (from the Svelte
 * bindings). The *demo* knobs — offline toggle, "remote edit", the durable
 * journal, connection status — live outside that API, so they ride a small
 * Svelte context plus two `Readable` stores built from {@link DemoControls}.
 */
import { readable, type Readable } from "svelte/store";
import { getContext, setContext } from "svelte";
import type { Connection, DemoControls, PendingEntry } from "./sync";

const DEMO_KEY = Symbol("svelte-todo/demo");

export const setDemo = (controls: DemoControls): void => {
  setContext(DEMO_KEY, controls);
};

export const getDemo = (): DemoControls => {
  const controls = getContext<DemoControls | undefined>(DEMO_KEY);
  if (controls === undefined) throw new Error("setDemo(controls) must be called higher in the tree");
  return controls;
};

/** Live transport connection status (emitted now and on every change). */
export const connectionStore = (controls: DemoControls): Readable<Connection> =>
  readable<Connection>("connecting", (set) => controls.subscribeConnection(set));

/** The durable journal, polled so the panel reflects push acks (which trim it). */
export const pendingStore = (controls: DemoControls): Readable<ReadonlyArray<PendingEntry>> =>
  readable<ReadonlyArray<PendingEntry>>([], (set) => {
    let live = true;
    const poll = () =>
      void controls.pendingNow().then((next) => {
        if (live) set(next);
      });
    poll();
    const timer = setInterval(poll, 750);
    return () => {
      live = false;
      clearInterval(timer);
    };
  });
