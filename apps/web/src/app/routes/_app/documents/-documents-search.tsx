// Search dialog opened from the sidebar's search icon. A modal with an
// input and a scrollable list of title matches; picking a result selects
// the doc (which auto-expands its ancestors in the sidebar tree) and
// closes the dialog.

import type { DocumentTreeNode } from "@/shared/lib/api/documents";
import { FileText, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { formatShortDate } from "./-documents-shared";

export function SearchDialog({
  open,
  onOpenChange,
  tree,
  onSelect,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tree: readonly DocumentTreeNode[];
  readonly onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("documents");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset query whenever the dialog reopens so the user starts fresh.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react/set-state-in-effect -- reset transient dialog state on open.
      setQuery("");
      // Defer focus until after the dialog mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q)
      return [];
    return tree
      .filter(n => n.title.toLowerCase().includes(q))
      .slice(0, 50);
  }, [query, tree]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>{t("searchPlaceholder")}</DialogTitle>
          <DialogDescription>{t("searchPlaceholder")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-9 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {query.trim().length === 0
            ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {t("searchPlaceholder")}
                </div>
              )
            : results.length === 0
              ? <div className="px-3 py-6 text-center text-xs text-muted-foreground">{t("noResults")}</div>
              : (
                  <ul>
                    {results.map(node => (
                      <li key={node.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(node.id)}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                        >
                          <FileText className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                          <span className="flex-1 truncate">{node.title || t("untitledPlaceholder")}</span>
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                            {formatShortDate(node.updatedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
