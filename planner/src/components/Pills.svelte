<script lang="ts" generics="T extends string">
  // One row of pills, one of them chosen: the app's segmented pickers.
  interface Props {
    label: string;
    options: { id: T; title: string }[];
    value: T;
    onchoose: (id: T) => void;
  }
  let { label, options, value, onchoose }: Props = $props();
</script>

<div class="segmented" role="radiogroup" aria-label={label}>
  {#each options as option (option.id)}
    <button type="button" role="radio" aria-checked={value === option.id} onclick={() => onchoose(option.id)}>
      {option.title}
    </button>
  {/each}
</div>
