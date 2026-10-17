<script lang="ts">
  // What a right-click on the map offers: the point as the start, a stop, or the destination.
  interface Props {
    x: number;
    y: number;
    /** A stop needs a start and a destination to go between. */
    canAddStop: boolean;
    onchoose: (role: 'start' | 'stop' | 'end') => void;
    onclose: () => void;
  }
  let { x, y, canAddStop, onchoose, onclose }: Props = $props();

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
</script>

<div class="context-menu glass" role="menu" bind:this={menu} style:left={`${x}px`} style:top={`${y}px`}>
  <button type="button" role="menuitem" onclick={() => onchoose('start')}>Start here</button>
  {#if canAddStop}
    <button type="button" role="menuitem" onclick={() => onchoose('stop')}>Add a stop here</button>
  {/if}
  <button type="button" role="menuitem" onclick={() => onchoose('end')}>End here</button>
</div>
