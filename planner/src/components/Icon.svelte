<script lang="ts" module>
  // The planner's icons: Lucide's (lucide.dev, ISC licence: "Copyright (c) for portions of Lucide are
  // held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held
  // by Lucide Contributors 2022."), drawn a little heavier than Lucide's default to sit with Fredoka.
  // `pen` is Lucide's pen-line with a scribble for its line, as the app's pencil.and.scribble.
  export const icons = {
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    navigation: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
    // `share` and `import` are a pair, as SF Symbols' square.and.arrow.up and .down: one open box,
    // the arrow leaving it or coming in.
    share: '<path d="M8.5 9H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1.5"/><path d="M12 14V2.5"/><path d="m8.5 6 3.5-3.5L15.5 6"/>',
    import: '<path d="M8.5 9H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1.5"/><path d="M12 3v12"/><path d="m8.5 11.5 3.5 3.5 3.5-3.5"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>',
    pen: '<path d="M12.5 20.5c1.5-1.6 2.6 1.4 4.1 0s2.6 1.4 4.1 0"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    info: '<path d="M12 17v-6"/><path d="M12 7h.01"/>',
  } as const;

  export type IconName = keyof typeof icons;

  /** The same icon as markup, for the map's controls, which are plain DOM rather than Svelte. */
  export function iconMarkup(name: IconName, size = 20): string {
    return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
  }
</script>

<script lang="ts">
  let { name, size = 20 }: { name: IconName; size?: number } = $props();
</script>

{@html iconMarkup(name, size)}
