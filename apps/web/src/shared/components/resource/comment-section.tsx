/* eslint-disable react-refresh/only-export-components */
// Generic comments UI for any resource exposing
// `/api/{resource}/{id}/comments`. Supports two opt-in features:
//
//   - `enableReply`: shows a reply button on each comment; replies are
//     flat (no nesting) and surfaced as a clickable badge that scrolls
//     to the referenced comment.
//   - `locked`: replaces the composer with a notice and rejects new
//     comments. Used by docs comment moderation.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CornerUpLeft, Lock, Send, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { MarkdownEditor } from "@/shared/components/editor";
import { Button } from "@/shared/components/ui/button";
import { ConfirmDeleteDialog } from "@/shared/components/ui/confirm-delete-dialog";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import { errorMessage } from "@/shared/lib/errors";
import { http } from "@/shared/lib/http";
import { displayName } from "@/shared/lib/users";
import { cn } from "@/shared/lib/utils";

export interface ResourceComment {
  readonly id: string;
  readonly authorId: string;
  readonly content: string;
  readonly replyToId?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResourceUser {
  readonly id: string;
  readonly name: string;
}

export function commentsQueryKey(resource: string, resourceId: string) {
  return [resource, resourceId, "comments"] as const;
}

function useFormatTimeAgo(i18nNs: string) {
  const { t } = useTranslation(i18nNs);
  return (dateStr: string): string => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1)
      return t("comments.justNow");
    if (minutes < 60)
      return t("comments.minutesAgo", { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
      return t("comments.hoursAgo", { count: hours });
    const days = Math.floor(hours / 24);
    return t("comments.daysAgo", { count: days });
  };
}

export interface ResourceCommentSectionProps {
  /** Path prefix, e.g. "documents" or "issues". */
  readonly resource: string;
  readonly resourceId: string;
  readonly userMap: Map<string, ResourceUser>;
  readonly canDelete: (c: ResourceComment) => boolean;
  readonly i18nNs: string;
  /** Show a "locked" notice instead of the composer. */
  readonly locked?: boolean;
  /** Show a reply button + clickable replyTo badges. */
  readonly enableReply?: boolean;
}

export function ResourceCommentSection({
  resource,
  resourceId,
  userMap,
  canDelete,
  i18nNs,
  locked = false,
  enableReply = false,
}: ResourceCommentSectionProps) {
  const { t } = useTranslation(i18nNs);
  const qc = useQueryClient();
  const formatTimeAgo = useFormatTimeAgo(i18nNs);
  const [newComment, setNewComment] = useState("");
  const [editorKey, setEditorKey] = useState(0);
  const [replyTarget, setReplyTarget] = useState<ResourceComment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ResourceComment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const commentNodesRef = useRef(new Map<string, HTMLDivElement>());
  const [flashId, setFlashId] = useState<string | null>(null);

  const commentsQuery = useQuery({
    queryKey: commentsQueryKey(resource, resourceId),
    queryFn: () => http<{ data: ResourceComment[] }>(`/${resource}/${resourceId}/comments`).then(r => r.data),
  });
  const commentById = useMemo(
    () => new Map((commentsQuery.data ?? []).map(c => [c.id, c])),
    [commentsQuery.data],
  );

  const submit = useMutation({
    mutationFn: async (input: { content: string; replyToId: string | null }) => {
      await http(`/${resource}/${resourceId}/comments`, {
        method: "POST",
        body: JSON.stringify(enableReply ? input : { content: input.content }),
      });
    },
    onSuccess: () => {
      setNewComment("");
      setReplyTarget(null);
      setEditorKey(k => k + 1);
      void qc.invalidateQueries({ queryKey: commentsQueryKey(resource, resourceId) });
    },
    onError: err => setError(errorMessage(err, t("common.error.operationFailed"))),
  });

  const remove = useMutation({
    mutationFn: async (c: ResourceComment) => {
      await http(`/${resource}/${resourceId}/comments/${c.id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      setDeleteTarget(null);
      void qc.invalidateQueries({ queryKey: commentsQueryKey(resource, resourceId) });
    },
    onError: err => setError(errorMessage(err, t("common.error.deleteFailed"))),
  });

  const startReply = (target: ResourceComment) => {
    setReplyTarget(target);
    composerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const jumpToComment = (id: string) => {
    const el = commentNodesRef.current.get(id);
    if (!el)
      return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(id);
    window.setTimeout(() => setFlashId(prev => (prev === id ? null : prev)), 1500);
  };

  const canCompose = !locked;

  return (
    <div>
      <ErrorBanner message={error} className="mb-3" />

      {canCompose
        ? (
            <div ref={composerRef} className="mb-4 space-y-2">
              {enableReply && replyTarget && (
                <div className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <CornerUpLeft className="size-3 shrink-0" />
                    <span className="shrink-0">{t("comments.replyingTo")}</span>
                    <span className="truncate text-foreground/80">
                      {displayName(userMap, replyTarget.authorId)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="ml-2 inline-flex size-5 items-center justify-center rounded hover:bg-accent"
                    onClick={() => setReplyTarget(null)}
                    title={t("common.cancel")}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )}
              <MarkdownEditor
                key={editorKey}
                onChange={md => setNewComment(md)}
                compact
                placeholder={t("comments.placeholder")}
                minHeight={60}
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={submit.isPending || !newComment.trim()}
                  onClick={() => submit.mutate({ content: newComment.trim(), replyToId: replyTarget?.id ?? null })}
                >
                  <Send className="size-3.5 mr-1.5" />
                  {t("comments.send")}
                </Button>
              </div>
            </div>
          )
        : (
            <div className="mb-4 flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
              <Lock className="size-3.5 shrink-0" />
              <span>{t("comments.lockedNotice")}</span>
            </div>
          )}

      <div className="space-y-3">
        {commentsQuery.isLoading
          ? <div className="text-sm text-muted-foreground text-center py-4">{t("common.loading")}</div>
          : (commentsQuery.data ?? []).length === 0
              ? <div className="text-sm text-muted-foreground text-center py-4">{t("comments.noComments")}</div>
              : (commentsQuery.data ?? []).map((comment) => {
                  const parent = enableReply && comment.replyToId ? commentById.get(comment.replyToId) : null;
                  return (
                    <div
                      key={comment.id}
                      ref={(el) => {
                        if (el)
                          commentNodesRef.current.set(comment.id, el);
                        else
                          commentNodesRef.current.delete(comment.id);
                      }}
                      className={cn(
                        "group transition-colors",
                        flashId === comment.id && "bg-primary/5 -mx-2 px-2 py-2 rounded-md",
                      )}
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <div className="flex items-baseline gap-2">
                          <span className="text-sm font-medium">
                            {displayName(userMap, comment.authorId)}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {formatTimeAgo(comment.createdAt)}
                          </span>
                        </div>
                        <div className="inline-flex items-center gap-1">
                          {enableReply && canCompose && (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground/70 hover:bg-accent hover:text-foreground transition-colors"
                              onClick={() => startReply(comment)}
                            >
                              <CornerUpLeft className="size-3" />
                              {t("comments.reply")}
                            </button>
                          )}
                          {canDelete(comment) && (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive transition-colors"
                              onClick={() => setDeleteTarget(comment)}
                            >
                              <X className="size-3" />
                              {t("common.delete")}
                            </button>
                          )}
                        </div>
                      </div>
                      {enableReply && comment.replyToId && (
                        <button
                          type="button"
                          className="mb-1 inline-flex max-w-full items-center gap-1 rounded bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
                          onClick={() => jumpToComment(comment.replyToId!)}
                          title={parent ? parent.content : undefined}
                        >
                          <CornerUpLeft className="size-3 shrink-0" />
                          {parent
                            ? (
                                <span className="truncate">
                                  {displayName(userMap, parent.authorId)}
                                  <span className="mx-1 text-muted-foreground/50">·</span>
                                  {parent.content.replace(/\s+/g, " ").slice(0, 60)}
                                </span>
                              )
                            : <span>{t("comments.replyMissing")}</span>}
                        </button>
                      )}
                      <div className="rounded-md bg-muted/40 px-3 py-2">
                        <MarkdownEditor
                          defaultValue={comment.content}
                          readOnly
                          className="text-sm"
                        />
                      </div>
                    </div>
                  );
                })}
      </div>

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open)
            setDeleteTarget(null);
        }}
        title={t("comments.deleteTitle")}
        description={t("comments.deleteConfirm")}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
      />
    </div>
  );
}
