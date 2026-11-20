<script lang="ts">
  import type { Query } from "@thomasfosterau/legation";
  import * as Schema from "effect/Schema";
  import { AsyncResult } from "effect/reactivity";
  import { setClientRuntime, type ClientRuntime } from "../../index.svelte.js";
  import { useQuery } from "../../index.svelte.js";

  const {
    runtime,
    read,
  }: {
    runtime: ClientRuntime;
    read: Query.Read;
  } = $props();

  const decodeNamed = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }));
  const decodeTitled = Schema.decodeUnknownSync(Schema.Struct({ title: Schema.String }));

  // svelte-ignore state_referenced_locally
  setClientRuntime(runtime);

  // svelte-ignore state_referenced_locally
  const rows = useQuery(() => read);

  const joined = $derived(
    AsyncResult.getOrElse(rows.current, () => []).map((row) => {
      const author = row.related["author"];
      const name =
        author === null || author === undefined ? "nobody" : decodeNamed(author).name;
      return `${decodeTitled(row.value).title}:${name}`;
    })
  );
</script>

<ul>
  {#each joined as entry (entry)}
    <li>{entry}</li>
  {/each}
</ul>
