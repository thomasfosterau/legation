<script lang="ts">
  import type { ClientEngine } from "@legation/effect";
  import {
    getMutate,
    getMutateWithAck,
    setEngineRuntime,
    type EffectSyncRuntime,
  } from "../../index.js";

  const {
    runtime,
    onOutcome,
  }: {
    runtime: EffectSyncRuntime;
    onOutcome: (outcome: ClientEngine.MutationOutcome) => void;
  } = $props();

  // The mutate helpers capture the context runtime at init by design.
  // svelte-ignore state_referenced_locally
  setEngineRuntime(runtime);
  const mutate = getMutate();
  const mutateWithAck = getMutateWithAck();
</script>

<button onclick={() => void mutate("todo/set", { id: "2", title: "added" })}>add</button>
<button
  onclick={() =>
    void mutateWithAck("todo/set", { id: "3", title: "awaited" }).then(onOutcome)}
>
  ack
</button>
<button
  onclick={() =>
    void mutateWithAck("todo/reject", { id: "9", title: "doomed" }).then(onOutcome)}
>
  reject
</button>
