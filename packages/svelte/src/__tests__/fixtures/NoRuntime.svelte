<script lang="ts">
  import { Subset } from "@legation/effect/internal";
  import { query } from "../../Query.js";

  // No setEngineRuntime higher in the tree: this must throw on init.
  const rows = query(Subset.make({ collection: "todos" }));
</script>

<p>{$rows.length}</p>
