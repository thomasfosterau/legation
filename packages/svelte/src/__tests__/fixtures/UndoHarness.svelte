<script lang="ts">
  import type { Undo } from "@thomasfosterau/legation-effect/internal";
  import { useUndo } from "../../index.svelte.js";

  const { manager }: { manager: Undo.UndoManager<unknown> } = $props();

  // The manager closes over the engine, so `useUndo` needs no runtime context.
  // svelte-ignore state_referenced_locally
  const controls = useUndo(manager);
</script>

<p>canUndo:{controls.canUndo}</p>
<p>canRedo:{controls.canRedo}</p>
<button onclick={() => void controls.undo()}>undo</button>
<button onclick={() => void controls.redo()}>redo</button>
