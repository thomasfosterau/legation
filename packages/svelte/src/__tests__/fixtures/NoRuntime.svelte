<script lang="ts">
  import { useQuery } from "../../Runes.svelte.js";

  // No setClientRuntime higher in the tree: this must throw on init.
  const rows = useQuery(() => ({ collection: "todos" }));
</script>

<p>{rows.current._tag}</p>
