// Table-of-contents UI plus a hook that stamps stable `id` attributes onto
// the editor's rendered headings. The pure markdown parser lives in
// `./toc-scanner` so React Fast Refresh can swap this file independently.
//
// We deliberately scan the markdown source (not the rendered DOM) — the
// editor's DOM is contenteditable and reflects intermediate caret state,
// so a DOM-derived TOC would flicker on every keystroke. Markdown updates
// at debounce boundaries instead.

/* eslint-disable react-refresh/only-export-components */
import type { ReactNode } from "react";
import type { HeadingNode } from "./toc-scanner";
import { useEffect, useRef } from "react";

import { cn } from "@/shared/lib/utils";

import { scanMarkdownHeadings } from "./toc-scanner";

/**
 * Lexical's contenteditable surface renders headings as `<h1>`–`<h6>` but
 * never assigns a stable `id` attribute (Lexical only tracks NodeKey).
 * For in-page anchor links to work we walk the editor DOM after each
 * markdown update and stamp ids matching the same slugifier used by
 * {@link scanMarkdownHeadings}.
 *
 * The walk is O(n) over visible headings and runs once per save (the
 * markdown source only changes on debounce), so the cost is negligible.
 * A MutationObserver would be cheaper but reacts too eagerly to Lexical's
 * intermediate updates and produces flicker on long docs.
 */
export function useHeadingAnchors(
  containerRef: React.RefObject<HTMLElement | null>,
  markdown: string,
): void {
  const headingsRef = useRef<HeadingNode[]>([]);

  useEffect(() => {
    headingsRef.current = scanMarkdownHeadings(markdown);
    const container = containerRef.current;
    if (!container)
      return;

    // requestAnimationFrame so we run after Lexical's next paint — otherwise
    // we'd race the renderer and stamp ids onto a DOM that's about to be
    // replaced.
    const handle = window.requestAnimationFrame(() => {
      const elements = container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
      const list = headingsRef.current;
      elements.forEach((el, idx) => {
        const expected = list[idx];
        if (expected)
          el.id = expected.slug;
      });
    });
    return () => window.cancelAnimationFrame(handle);
  }, [containerRef, markdown]);
}

export function TableOfContents({
  headings,
  className,
  emptyMessage,
  label,
}: {
  readonly headings: readonly HeadingNode[];
  readonly className?: string;
  readonly emptyMessage: string;
  readonly label: string;
}): ReactNode {
  if (headings.length === 0) {
    return (
      <nav aria-label={label} className={cn("text-xs text-muted-foreground", className)}>
        <div className="font-semibold uppercase tracking-wide mb-2">{label}</div>
        <div className="italic">{emptyMessage}</div>
      </nav>
    );
  }
  // Anchor levels are flattened — indent by `(level - minLevel)` so a doc
  // that starts at H2 still aligns flush left.
  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 6);
  return (
    <nav aria-label={label} className={cn("text-xs", className)}>
      <div className="text-muted-foreground font-semibold uppercase tracking-wide mb-2">{label}</div>
      <ul className="space-y-1 border-l border-border/50">
        {headings.map(h => (
          <li
            key={`${h.level}-${h.slug}`}
            style={{ paddingLeft: `${(h.level - minLevel) * 0.75 + 0.75}rem` }}
          >
            <a
              href={`#${h.slug}`}
              className="block py-0.5 text-muted-foreground hover:text-foreground transition-colors line-clamp-1"
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
