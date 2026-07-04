<script lang="ts">
  import type { ClientEngine } from "@legation/effect/internal";
  import { getMutate, getMutateWithAck } from "../../Mutation.js";
  import { setEngineRuntime, type EffectSyncRuntime } from "../../Runtime.js";

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

<!-- Fire-and-forget clicks: swallow rejections (the runtime may dispose
     mid-flight when a test tears down before an ack lands). -->
<button onclick={() => void mutate("todo/set", { id: "2", title: "added" }).catch(() => undefined)}>
  add
</button>
<button
  onclick={() =>
    void mutateWithAck("todo/set", { id: "3", title: "awaited" })
      .then(onOutcome)
      .catch(() => undefined)}
>
  ack
</button>
<button
  onclick={() =>
    void mutateWithAck("todo/reject", { id: "9", title: "doomed" })
      .then(onOutcome)
      .catch(() => undefined)}
>
  reject
</button>
