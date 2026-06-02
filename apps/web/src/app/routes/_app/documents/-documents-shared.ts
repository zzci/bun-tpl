// Shared types and date helpers for the documents page.

export interface DraftState {
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
}

export const EMPTY_DRAFT: DraftState = { title: "", content: "", tags: [] };

export function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    return "";
  // Compact "M月D日" form to fit the narrow sidebar column.
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatLongDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    return "";
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
