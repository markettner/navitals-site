<script lang="ts">
  // One stop's search field (plan Phase 7i's rules): Photon as you type, 250 ms after the last key;
  // Enter waits for Photon until 3 s after it was asked, then asks Nominatim if Photon found nothing.
  // Rows already shown keep their place when a slower source adds to them.
  import type { Coordinate } from '../core/geodesy';
  import { merging, type Place, type PlaceSearch } from '../core/search';

  interface Props {
    place: Place | null;
    placeholder: string;
    search: PlaceSearch;
    bias: () => Coordinate;
    onchoose: (place: Place) => void;
    onclear: () => void;
  }
  let { place, placeholder, search, bias, onchoose, onclear }: Props = $props();

  let query = $state('');
  let editing = $state(false);
  let results = $state.raw<Place[]>([]);
  let highlighted = $state(-1);
  let message = $state('');
  let photonAsked = 0;
  let photonPending: Promise<Place[]> | null = null;
  let typing: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | null = null;
  const listID = `stop-results-${Math.random().toString(36).slice(2)}`;

  const shown = $derived(editing ? query : (place?.name ?? ''));
  const open = $derived(editing && (results.length > 0 || message !== ''));

  function focus(event: FocusEvent) {
    editing = true;
    query = place?.name ?? '';
    (event.currentTarget as HTMLInputElement).select();
  }

  function input(event: Event) {
    query = (event.currentTarget as HTMLInputElement).value;
    highlighted = -1;
    message = '';
    clearTimeout(typing);
    request?.abort();
    photonPending = null;
    if (!query.trim()) {
      results = [];
      return;
    }
    typing = setTimeout(() => suggest(query), 250);
  }

  function suggest(text: string) {
    request = new AbortController();
    const signal = request.signal;
    photonAsked = Date.now();
    photonPending = search.suggest(text, bias(), signal);
    photonPending.then(
      (places) => { if (!signal.aborted && text === query) results = merging([], places); },
      () => { /* Enter turns to Nominatim; nothing to say while typing */ },
    );
  }

  async function explicitSearch() {
    const text = query;
    if (!text.trim()) return;
    if (!photonPending) {
      clearTimeout(typing);
      suggest(text);
    }
    const signal = request!.signal;
    const grace = Math.max(0, 3000 - (Date.now() - photonAsked));
    const photon = await Promise.race([
      photonPending!.catch(() => [] as Place[]),
      new Promise<Place[]>((resolve) => setTimeout(() => resolve([]), grace)),
    ]);
    if (signal.aborted || text !== query) return;
    if (photon.length) {
      results = merging(results, photon);
      highlighted = 0;
      return;
    }
    message = 'Searching OpenStreetMap…';
    try {
      const found = await search.search(text, bias(), signal);
      if (signal.aborted || text !== query) return;
      results = merging(results, found);
      highlighted = results.length ? 0 : -1;
      message = results.length ? '' : `Nothing found for “${text}”.`;
    } catch {
      if (signal.aborted || text !== query) return;
      message = results.length ? '' : 'Search is unavailable right now.';
    }
  }

  function choose(chosen: Place) {
    onchoose(chosen);
    close();
    (document.activeElement as HTMLElement | null)?.blur();
  }

  function close() {
    clearTimeout(typing);
    request?.abort();
    editing = false;
    results = [];
    message = '';
    highlighted = -1;
    photonPending = null;
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' && results.length) {
      highlighted = (highlighted + 1) % results.length;
      event.preventDefault();
    } else if (event.key === 'ArrowUp' && results.length) {
      highlighted = (highlighted - 1 + results.length) % results.length;
      event.preventDefault();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (highlighted >= 0 && results[highlighted]) choose(results[highlighted]);
      else explicitSearch();
    } else if (event.key === 'Escape') {
      close();
      (event.currentTarget as HTMLInputElement).blur();
    }
  }

  function blur() {
    // A field emptied and left clears the stop; one left half-typed keeps the stop it had.
    if (!query.trim() && place) onclear();
    close();
  }
</script>

<div class="stop-field">
  <input
    type="search"
    value={shown}
    {placeholder}
    aria-label={placeholder}
    role="combobox"
    aria-expanded={open}
    aria-controls={listID}
    aria-autocomplete="list"
    aria-activedescendant={highlighted >= 0 ? `${listID}-${highlighted}` : undefined}
    autocomplete="off"
    spellcheck="false"
    onfocus={focus}
    oninput={input}
    onkeydown={keydown}
    onblur={blur}
  />
  {#if open}
    <div class="results">
      {#if results.length}
        <ul id={listID} role="listbox" aria-label="Places">
          {#each results as result, index (result.id)}
            <li
              id={`${listID}-${index}`}
              role="option"
              aria-selected={index === highlighted}
              class:highlighted={index === highlighted}
              onpointerdown={(event) => { event.preventDefault(); choose(result); }}
              onpointermove={() => (highlighted = index)}
            >
              <span class="result-name">{result.name}</span>
              {#if result.subtitle}<span class="result-subtitle">{result.subtitle}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if message}<p class="results-message" role="status">{message}</p>{/if}
    </div>
  {/if}
</div>
