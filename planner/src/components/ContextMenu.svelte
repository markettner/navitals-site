<script lang="ts">
  // A right-click menu over the map: for a point (Start here, …) or for a stop or bend (Remove, …).
  interface Props {
    x: number;
    y: number;
    items: { label: string; destructive?: boolean; action: () => void }[];
    onclose: () => void;
  }
  let { x, y, items, onclose }: Props = $props();

  let menu: HTMLElement;

  $effect(() => {
    menu.querySelector('button')?.focus();
    const away = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) onclose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onclose(); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key);
    };
  });

  // Kept inside the window: a click near the right or bottom edge opens the menu the other way.
  const left = $derived(Math.min(x, window.innerWidth - 200));
  const top = $derived(Math.min(y, window.innerHeight - 16 - items.length * 40));
</script>

<div class="context-menu glass" role="menu" bind:this={menu} style:left={`${left}px`} style:top={`${top}px`}>
  {#each items as item (item.label)}
    <button type="button" role="menuitem" class:destructive={item.destructive}
            onclick={() => { item.action(); onclose(); }}>{item.label}</button>
  {/each}
</div>
