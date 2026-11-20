/** A number field's value, or `was` while it is empty or not a number (being typed over). */
export function numIn(e: Event, was: number): number {
  const v = (e.target as HTMLInputElement).value.trim();
  const n = Number(v);
  return v !== '' && Number.isFinite(n) ? n : was;
}
