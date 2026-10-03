<script lang="ts">
  import type { ClientEngine } from "@thomasfosterau/legation-effect/internal";
  import { setClientRuntime, type ClientRuntime } from "../../index.svelte.js";
  import { useMutation, useMutationWithAck } from "../../index.svelte.js";

  const {
    runtime,
    onOutcome,
  }: {
    runtime: ClientRuntime;
    onOutcome: (outcome: ClientEngine.MutationOutcome) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  setClientRuntime(runtime);
  const mutate = useMutation();
  const mutateWithAck = useMutationWithAck();
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
