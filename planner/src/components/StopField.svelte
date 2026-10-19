<script lang="ts">
  // One stop's search field (plan Phase 7i's rules): Photon as you type, 250 ms after the last key;
  // Enter waits for Photon until 3 s after it was asked, then asks Nominatim if Photon found nothing.
  // Rows already shown keep their place when a slower source adds to them.
  //
  // A field that can be "My Location" lists it first, as soon as it is focused and for as long as
  // what is typed could still mean it: the way back to the rider's own position after another start.
  import type { Coordinate } from '../core/geodesy';
  import { matchesMyLocation, merging, myLocationName, type Place, type PlaceSearch } from '../core/search';
  import Icon from './Icon.svelte';

  interface Props {
    place: Place | null;
    /** The stop is "My Location", found or still being found. */
    current?: boolean;
    placeholder: string;
    search: PlaceSearch;
    bias: () => Coordinate;
    /** Whether to offer "My Location", and whether the site may have it. */
    myLocation?: 'offer' | 'blocked' | null;
    onchoose: (place: Place) => void;
    onclear: () => void;
    onmylocation?: () => void;
  }
  let { place, current = false, placeholder, search, bias, myLocation = null, onchoose, onclear, onmylocation }: Props = $props();

  let query = $state('');
  let editing = $state(false);
  let results = $state.raw<Place[]>([]);
  let highlighted = $state(-1);
  let message = $state('');
  let photonAsked = 0;
  let photonPending: Promise<Place[]> | null = null;
  let typing: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | null = null;
  /** Something was typed since the field was focused: until then its own text asks for nothing. */
  let typed = $state(false);
  const listID = `stop-results-${Math.random().toString(36).slice(2)}`;

  const name = $derived(place?.name ?? (current ? myLocationName : ''));
  const shown = $derived(editing ? query : name);
  /** The "My Location" row, standing first in the list. Its id is its own, never a place's. */
  const mine: Place = { id: 'my-location', name: myLocationName, subtitle: '', latitude: 0, longitude: 0, kind: 'other' };
  const offersMine = $derived(editing && myLocation !== null && !current && (!typed || matchesMyLocation(query)));
  const rows = $derived(offersMine ? [mine, ...results] : results);
  const open = $derived(editing && (rows.length > 0 || message !== ''));

  function focus(event: FocusEvent) {
    editing = true;
    typed = false;
    query = name;
    (event.currentTarget as HTMLInputElement).select();
  }

  function input(event: Event) {
    query = (event.currentTarget as HTMLInputElement).value;
    typed = true;
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
      highlighted = offersMine ? 1 : 0;
      return;
    }
    message = 'Searching OpenStreetMap…';
    try {
      const found = await search.search(text, bias(), signal);
      if (signal.aborted || text !== query) return;
      results = merging(results, found);
      highlighted = results.length ? (offersMine ? 1 : 0) : -1;
      message = results.length ? '' : `Nothing found for “${text}”.`;
    } catch {
      if (signal.aborted || text !== query) return;
      message = results.length ? '' : 'Search is unavailable right now.';
    }
  }

  function choose(chosen: Place) {
    if (chosen === mine) {
      // Blocked: the row says so, and there is nothing to choose.
      if (myLocation !== 'offer') return;
      onmylocation?.();
    } else {
      onchoose(chosen);
    }
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
    if (event.key === 'ArrowDown' && rows.length) {
      highlighted = (highlighted + 1) % rows.length;
      event.preventDefault();
    } else if (event.key === 'ArrowUp' && rows.length) {
      highlighted = (highlighted - 1 + rows.length) % rows.length;
      event.preventDefault();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (highlighted >= 0 && rows[highlighted]) choose(rows[highlighted]);
      else explicitSearch();
    } else if (event.key === 'Escape') {
      close();
      (event.currentTarget as HTMLInputElement).blur();
    }
  }

  function blur() {
    // A field emptied and left clears the stop; one left half-typed keeps the stop it had.
    if (!query.trim() && (place || current)) onclear();
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
      {#if rows.length}
        <ul id={listID} role="listbox" aria-label="Places">
          {#each rows as result, index (result.id)}
            <li
              id={`${listID}-${index}`}
              role="option"
              aria-selected={index === highlighted}
              aria-disabled={result === mine && myLocation === 'blocked'}
              class:highlighted={index === highlighted}
              class:mine={result === mine}
              onpointerdown={(event) => { event.preventDefault(); choose(result); }}
              onpointermove={() => (highlighted = index)}
            >
              {#if result === mine}
                <span class="mine-icon"><Icon name="navigation" size={14} /></span>
                <span class="result-name">{myLocationName}</span>
                {#if myLocation === 'blocked'}<span class="result-subtitle">Location access is blocked for this site.</span>{/if}
              {:else}
                <span class="result-name">{result.name}</span>
                {#if result.subtitle}<span class="result-subtitle">{result.subtitle}</span>{/if}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if message}<p class="results-message" role="status">{message}</p>{/if}
    </div>
  {/if}
</div>
