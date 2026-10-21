// How a plan's points are listed (NavitalsKit's StopListRows), the same in the app and here.
//
// An imported plan can hold dozens of shaping points, and a row for each buried the stops it was
// planned through. So two or more in a row fold into one row ("5 shaping points") — but not in a
// short list, where a fold would only hide what fits.

/** A list of at most this many points is never folded. */
export const flatUpTo = 8;
/** The fewest shaping points in a row that fold. */
export const foldFrom = 2;

/** A stop or shaping point by its index in the plan, or a run of shaping points folded into one
 *  row from `index`; when open, their own rows follow it. */
export type StopRow =
  | { type: 'point'; index: number }
  | { type: 'fold'; index: number; count: number; open: boolean };

/** The rows for points of these kinds (`true` for a shaping point), with the runs `isOpen` says
 *  are open — asked by the index of their first shaping point. */
export function stopRows(isShaping: boolean[], isOpen: (index: number) => boolean = () => false): StopRow[] {
  if (isShaping.length <= flatUpTo) return isShaping.map((_, index) => ({ type: 'point', index }));
  const rows: StopRow[] = [];
  for (let index = 0; index < isShaping.length; index++) {
    if (!isShaping[index]) {
      rows.push({ type: 'point', index });
      continue;
    }
    let end = index;
    while (end + 1 < isShaping.length && isShaping[end + 1]) end++;
    const count = end - index + 1;
    if (count >= foldFrom) {
      const open = isOpen(index);
      rows.push({ type: 'fold', index, count, open });
      if (open) for (let i = index; i <= end; i++) rows.push({ type: 'point', index: i });
    } else {
      for (let i = index; i <= end; i++) rows.push({ type: 'point', index: i });
    }
    index = end;
  }
  return rows;
}
