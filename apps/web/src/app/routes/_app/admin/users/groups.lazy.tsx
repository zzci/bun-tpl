/* eslint-disable react-refresh/only-export-components */
import { createLazyFileRoute } from "@tanstack/react-router";
import { ChevronRight, Pencil, Plus, Trash2, UserPlus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { Textarea } from "@/shared/components/ui/textarea";
import { http } from "@/shared/lib/http";
import { cn } from "@/shared/lib/utils";

export const Route = createLazyFileRoute("/_app/admin/users/groups")({
  component: GroupsTab,
});

interface Group {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly memberCount: number;
  readonly createdAt: string;
}

interface GroupMember {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly joinedAt: string;
}

interface GroupListResponse {
  success: boolean;
  data: Group[];
}

interface MemberListResponse {
  success: boolean;
  data: GroupMember[];
}

interface UserSearchItem {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly email: string;
}

interface UserSearchResponse {
  success: boolean;
  data: UserSearchItem[];
  meta: { total: number };
}

function GroupsTab() {
  const { t } = useTranslation("groups");
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editGroup, setEditGroup] = useState<Group | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Group | null>(null);
  const [memberGroup, setMemberGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [searchResults, setSearchResults] = useState<UserSearchItem[]>([]);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await http<GroupListResponse>("/account/groups");
      setGroups(res.data);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.loadFailed"));
    }
    finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchGroups();
  }, [fetchGroups]);

  const fetchMembers = useCallback(async (groupId: string) => {
    setMembersLoading(true);
    try {
      const res = await http<MemberListResponse>(`/account/groups/${groupId}/members`);
      setMembers(res.data);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.loadFailed"));
    }
    finally {
      setMembersLoading(false);
    }
  }, [t]);

  const openMembers = (group: Group) => {
    setMemberGroup(group);
    void fetchMembers(group.id);
  };

  const handleUserSearchChange = (q: string) => {
    setUserSearch(q);
    clearTimeout(searchTimerRef.current);
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    searchTimerRef.current = setTimeout(async () => {
      try {
        const res = await http<UserSearchResponse>(`/account/users?q=${encodeURIComponent(q)}&limit=10`);
        setSearchResults(res.data);
      }
      catch {
        setSearchResults([]);
      }
    }, 300);
  };

  const addMember = async (userId: string) => {
    if (!memberGroup)
      return;
    try {
      await http(`/account/groups/${memberGroup.id}/members`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      setAddMemberOpen(false);
      setUserSearch("");
      setSearchResults([]);
      void fetchMembers(memberGroup.id);
      void fetchGroups();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
  };

  const removeMember = async (userId: string) => {
    if (!memberGroup)
      return;
    try {
      await http(`/account/groups/${memberGroup.id}/members/${userId}`, { method: "DELETE" });
      void fetchMembers(memberGroup.id);
      void fetchGroups();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
  };

  const confirmDeleteGroup = async () => {
    if (!deleteConfirm)
      return;
    try {
      await http(`/account/groups/${deleteConfirm.id}`, { method: "DELETE" });
      if (memberGroup?.id === deleteConfirm.id)
        setMemberGroup(null);
      setDeleteConfirm(null);
      void fetchGroups();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.deleteFailed"));
      setDeleteConfirm(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div />
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger render={(
            <Button>
              <Plus className="mr-1 size-4" />
              {t("create")}
            </Button>
          )}
          />
          <DialogContent>
            <GroupFormDialog
              onSubmit={async (name, description) => {
                await http("/account/groups", {
                  method: "POST",
                  body: JSON.stringify({ name, description: description || undefined }),
                });
                setCreateOpen(false);
                void fetchGroups();
              }}
              title={t("createTitle")}
              description={t("createDescription")}
              submitLabel={t("create")}
            />
          </DialogContent>
        </Dialog>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteConfirm !== null}
        onOpenChange={(open) => {
          if (!open)
            setDeleteConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteConfirm", { name: deleteConfirm?.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
            <Button variant="destructive" onClick={() => void confirmDeleteGroup()}>
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className={cn("grid gap-4", memberGroup && "lg:grid-cols-2")}>
        {/* Group list */}
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("col.name")}</TableHead>
                <TableHead className="w-20 text-center">{t("col.members")}</TableHead>
                <TableHead className="w-32">{t("col.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody aria-busy={loading}>
              {loading
                ? (
                    <TableRow>
                      <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                        {t("common.loading")}
                      </TableCell>
                    </TableRow>
                  )
                : groups.length === 0
                  ? (
                      <TableRow>
                        <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                          {t("noResults")}
                        </TableCell>
                      </TableRow>
                    )
                  : groups.map(group => (
                      <TableRow
                        key={group.id}
                        className={cn(
                          "cursor-pointer transition-colors",
                          memberGroup?.id === group.id
                            ? "bg-primary/5 hover:bg-primary/10"
                            : "hover:bg-muted/50",
                        )}
                        onClick={() => openMembers(group)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="font-medium">{group.name}</div>
                              {group.description && (
                                <div className="text-xs text-muted-foreground truncate">{group.description}</div>
                              )}
                            </div>
                            <ChevronRight className={cn(
                              "size-4 shrink-0 text-muted-foreground/50 transition-transform",
                              memberGroup?.id === group.id && "rotate-90 text-primary",
                            )}
                            />
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant="secondary">{group.memberCount}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                            <Dialog
                              open={editGroup?.id === group.id}
                              onOpenChange={(open) => {
                                if (!open)
                                  setEditGroup(null);
                              }}
                            >
                              <DialogTrigger
                                render={(
                                  <Button variant="ghost" size="sm" onClick={() => setEditGroup(group)}>
                                    <Pencil className="mr-1 size-3.5" />
                                    {t("common.edit")}
                                  </Button>
                                )}
                              />
                              <DialogContent>
                                <GroupFormDialog
                                  initialName={group.name}
                                  initialDescription={group.description ?? ""}
                                  onSubmit={async (name, description) => {
                                    await http(`/account/groups/${group.id}`, {
                                      method: "PATCH",
                                      body: JSON.stringify({ name, description: description || undefined }),
                                    });
                                    setEditGroup(null);
                                    void fetchGroups();
                                  }}
                                  title={t("editTitle")}
                                  description={t("editDescription")}
                                  submitLabel={t("common.save")}
                                />
                              </DialogContent>
                            </Dialog>

                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDeleteConfirm(group)}
                              className="text-destructive hover:text-destructive"
                            >
                              <Trash2 className="mr-1 size-3.5" />
                              {t("common.delete")}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
            </TableBody>
          </Table>
        </div>

        {/* Member panel */}
        {memberGroup && (
          <div className="rounded-md border">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="min-w-0">
                <h3 className="font-semibold truncate">{memberGroup.name}</h3>
                <p className="text-xs text-muted-foreground">{t("membersOf", { name: memberGroup.name })}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Dialog
                  open={addMemberOpen}
                  onOpenChange={(open) => {
                    setAddMemberOpen(open);
                    if (!open) {
                      setUserSearch("");
                      setSearchResults([]);
                    }
                  }}
                >
                  <DialogTrigger render={(
                    <Button size="sm">
                      <UserPlus className="mr-1 size-4" />
                      {t("addMember")}
                    </Button>
                  )}
                  />
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>{t("addMemberTitle")}</DialogTitle>
                      <DialogDescription>{t("addMemberDescription")}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                      <Input
                        placeholder={t("searchUserPlaceholder")}
                        value={userSearch}
                        onChange={e => handleUserSearchChange(e.target.value)}
                      />
                      {searchResults.length > 0 && (
                        <div className="max-h-48 overflow-y-auto rounded-md border">
                          {searchResults.map(u => (
                            <button
                              key={u.id}
                              type="button"
                              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted transition-colors"
                              onClick={() => void addMember(u.id)}
                            >
                              <div>
                                <div className="font-medium">{u.name}</div>
                                <div className="text-xs text-muted-foreground">{u.email}</div>
                              </div>
                              <Plus className="size-4 text-muted-foreground" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </DialogContent>
                </Dialog>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setMemberGroup(null)}
                  aria-label="Close"
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("col.memberName")}</TableHead>
                  <TableHead>{t("col.memberEmail")}</TableHead>
                  <TableHead className="w-24">{t("col.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody aria-busy={membersLoading}>
                {membersLoading
                  ? (
                      <TableRow>
                        <TableCell colSpan={3} className="h-16 text-center text-muted-foreground">
                          {t("common.loading")}
                        </TableCell>
                      </TableRow>
                    )
                  : members.length === 0
                    ? (
                        <TableRow>
                          <TableCell colSpan={3} className="h-16 text-center text-muted-foreground">
                            {t("noMembers")}
                          </TableCell>
                        </TableRow>
                      )
                    : members.map(member => (
                        <TableRow key={member.id}>
                          <TableCell>
                            <div className="font-medium">{member.name}</div>
                            <div className="text-xs text-muted-foreground">{member.username}</div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{member.email}</TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void removeMember(member.id)}
                              className="text-destructive hover:text-destructive"
                            >
                              <Trash2 className="mr-1 size-3.5" />
                              {t("removeMember")}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

function GroupFormDialog({
  initialName = "",
  initialDescription = "",
  onSubmit,
  title,
  description,
  submitLabel,
}: {
  readonly initialName?: string;
  readonly initialDescription?: string;
  readonly onSubmit: (name: string, description: string) => Promise<void>;
  readonly title: string;
  readonly description: string;
  readonly submitLabel: string;
}) {
  const [name, setName] = useState(initialName);
  const [desc, setDesc] = useState(initialDescription);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { t } = useTranslation("groups");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim())
      return;
    setSubmitting(true);
    setFormError(null);
    try {
      await onSubmit(name.trim(), desc.trim());
    }
    catch (err) {
      setFormError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
    finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={e => void handleSubmit(e)}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-4">
        {formError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {formError}
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="group-name">{t("field.name")}</Label>
          <Input
            id="group-name"
            value={name}
            onChange={e => setName(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="group-desc">{t("field.description")}</Label>
          <Textarea
            id="group-desc"
            value={desc}
            onChange={e => setDesc(e.target.value)}
            rows={3}
          />
        </div>
      </div>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
        <Button type="submit" disabled={submitting || !name.trim()}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
