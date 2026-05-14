/* eslint-disable react-refresh/only-export-components */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createLazyFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/shared/components/ui/combobox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/components/ui/tabs";
import { formatDate } from "@/shared/lib/format";
import { http } from "@/shared/lib/http";

export const Route = createLazyFileRoute("/_app/admin/policies")({
  component: PoliciesPage,
});

interface RelationTuple {
  id: string;
  namespace: string;
  objectId: string;
  relation: string;
  subjectNamespace: string;
  subjectId: string;
  subjectRelation: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface TuplesResponse {
  success: boolean;
  data: RelationTuple[];
  meta: { total: number; page: number; limit: number };
}

interface CheckResponse {
  success: boolean;
  data: { allowed: boolean; resolvedThrough: string[] };
}

interface EntityOption {
  readonly id: string;
  readonly name: string;
}

interface EntitiesResponse {
  success: boolean;
  data: Record<string, EntityOption[]>;
}

const NAMESPACES = ["group", "resource_group"] as const;
const RELATIONS: Record<string, string[]> = {
  group: ["member"],
  resource_group: ["viewer", "editor", "manager", "admin"],
};
const SUBJECT_NAMESPACES = ["user", "group"] as const;

function handleSelect(setter: (v: string) => void) {
  return (value: string | null) => {
    if (value !== null)
      setter(value);
  };
}

function useEntities() {
  return useQuery({
    queryKey: ["policy-entities"],
    queryFn: () => http<EntitiesResponse>("/policy/entities"),
    staleTime: 60_000,
  });
}

function useEntityNameMap(entities: EntitiesResponse | undefined) {
  return useMemo(() => {
    const map = new Map<string, string>();
    if (!entities?.data)
      return map;
    for (const [, items] of Object.entries(entities.data)) {
      for (const item of items) {
        map.set(item.id, item.name);
      }
    }
    return map;
  }, [entities]);
}

function PoliciesPage() {
  const { t } = useTranslation("policies");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("page.title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("page.description")}</p>
      </div>

      <Tabs defaultValue="tuples">
        <TabsList>
          <TabsTrigger value="tuples">{t("relationTuples")}</TabsTrigger>
          <TabsTrigger value="resource-groups">{t("resourceGroups")}</TabsTrigger>
          <TabsTrigger value="check">{t("permissionCheck")}</TabsTrigger>
        </TabsList>

        <TabsContent value="tuples" className="mt-4">
          <TupleManager />
        </TabsContent>

        <TabsContent value="resource-groups" className="mt-4">
          <ResourceGroupManager />
        </TabsContent>

        <TabsContent value="check" className="mt-4">
          <PermissionChecker />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TupleManager() {
  const { t } = useTranslation("policies");
  const [filterNs, setFilterNs] = useState<string>("__all__");
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();
  const { data: entities } = useEntities();
  const nameMap = useEntityNameMap(entities);

  const params = new URLSearchParams();
  if (filterNs !== "__all__")
    params.set("namespace", filterNs);
  params.set("page", String(page));
  params.set("limit", "20");

  const { data, isLoading } = useQuery({
    queryKey: ["tuples", filterNs, page],
    queryFn: () => http<TuplesResponse>(`/tuples?${params.toString()}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => http(`/tuples/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tuples"] }),
  });

  const tuples = data?.data ?? [];
  const total = data?.meta?.total ?? 0;
  const totalPages = Math.ceil(total / 20);

  function resolveEntityName(id: string): string {
    const name = nameMap.get(id);
    return name ? `${name} (${id})` : id;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Select
            value={filterNs}
            onValueChange={(v) => {
              if (v === null)
                return;
              setFilterNs(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue>{(v: string) => v === "__all__" ? t("allNamespaces") : t(`ns.${v}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t("allNamespaces")}</SelectItem>
              {NAMESPACES.map(ns => <SelectItem key={ns} value={ns}>{t(`ns.${ns}`)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <CreateTupleDialog entities={entities} />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col.namespace")}</TableHead>
              <TableHead>{t("col.object")}</TableHead>
              <TableHead>{t("col.relation")}</TableHead>
              <TableHead>{t("col.subject")}</TableHead>
              <TableHead>{t("col.created")}</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">{t("loading")}</TableCell>
                  </TableRow>
                )
              : tuples.length === 0
                ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">{t("noTuples")}</TableCell>
                    </TableRow>
                  )
                : tuples.map(tuple => (
                    <TableRow key={tuple.id}>
                      <TableCell><Badge variant="outline">{t(`ns.${tuple.namespace}`)}</Badge></TableCell>
                      <TableCell className="text-sm">{resolveEntityName(tuple.objectId)}</TableCell>
                      <TableCell><Badge variant="secondary">{t(`rel.${tuple.relation}`)}</Badge></TableCell>
                      <TableCell className="text-sm">
                        <Badge variant="outline" className="mr-1">{t(`ns.${tuple.subjectNamespace}`)}</Badge>
                        {resolveEntityName(tuple.subjectId)}
                        {tuple.subjectRelation
                          ? (
                              <Badge variant="secondary" className="ml-1">
                                #
                                {t(`rel.${tuple.subjectRelation}`)}
                              </Badge>
                            )
                          : ""}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatDate(tuple.createdAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <EditTupleDialog tuple={tuple} />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => deleteMutation.mutate(tuple.id)}
                            disabled={deleteMutation.isPending}
                          >
                            {t("common.delete")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{t("totalTuples", { count: total })}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              {t("common.prev")}
            </Button>
            <span className="flex items-center text-sm px-2">
              {page}
              {" "}
              /
              {" "}
              {totalPages}
            </span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
              {t("common.next")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateTupleDialog({ entities }: { readonly entities: EntitiesResponse | undefined }) {
  const { t } = useTranslation("policies");
  const [open, setOpen] = useState(false);
  const [ns, setNs] = useState<string>(NAMESPACES[0]);
  const [objectId, setObjectId] = useState("");
  const [relation, setRelation] = useState("");
  const [subjectNs, setSubjectNs] = useState("user");
  const [subjectId, setSubjectId] = useState("");
  const [subjectRelation, setSubjectRelation] = useState("");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => http("/policy/tuples", {
      method: "POST",
      body: JSON.stringify({
        namespace: ns,
        objectId,
        relation,
        subjectNamespace: subjectNs,
        subjectId,
        subjectRelation: subjectRelation || null,
      }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tuples"] });
      setOpen(false);
      resetForm();
    },
  });

  function resetForm() {
    setObjectId("");
    setRelation("");
    setSubjectId("");
    setSubjectRelation("");
  }

  const availableRelations = RELATIONS[ns] ?? [];
  const objectOptions = entities?.data?.[ns] ?? [];
  const subjectOptions = entities?.data?.[subjectNs] ?? [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button>{t("createTuple")}</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDescription")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t("namespace")}</Label>
              <Select
                value={ns}
                onValueChange={handleSelect((v) => {
                  setNs(v);
                  setRelation("");
                  setObjectId("");
                })}
              >
                <SelectTrigger><SelectValue>{(v: string) => t(`ns.${v}`)}</SelectValue></SelectTrigger>
                <SelectContent>
                  {NAMESPACES.map(n => <SelectItem key={n} value={n}>{t(`ns.${n}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("object")}</Label>
              <Combobox value={objectId ? { value: objectId, label: objectOptions.find(o => o.id === objectId)?.name ?? objectId } : null} onValueChange={v => setObjectId(v?.value ?? "")} isItemEqualToValue={(a, b) => a.value === b.value}>
                <ComboboxInput placeholder={t("selectObject")} showClear />
                <ComboboxContent>
                  <ComboboxList>
                    {objectOptions.map(o => (
                      <ComboboxItem key={o.id} value={{ value: o.id, label: o.name }}>
                        {o.name}
                        {" "}
                        (
                        {o.id}
                        )
                      </ComboboxItem>
                    ))}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("relation")}</Label>
            <Select value={relation} onValueChange={handleSelect(setRelation)}>
              <SelectTrigger><SelectValue>{(v: string) => v ? t(`rel.${v}`) : t("selectRelation")}</SelectValue></SelectTrigger>
              <SelectContent>
                {availableRelations.map(r => <SelectItem key={r} value={r}>{t(`rel.${r}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t("subjectNamespace")}</Label>
              <Select
                value={subjectNs}
                onValueChange={handleSelect((v) => {
                  setSubjectNs(v);
                  setSubjectId("");
                  setSubjectRelation(v === "group" ? "member" : "");
                })}
              >
                <SelectTrigger><SelectValue>{(v: string) => t(`ns.${v}`)}</SelectValue></SelectTrigger>
                <SelectContent>
                  {SUBJECT_NAMESPACES.map(n => <SelectItem key={n} value={n}>{t(`ns.${n}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("subject")}</Label>
              <Combobox value={subjectId ? { value: subjectId, label: subjectOptions.find(o => o.id === subjectId)?.name ?? subjectId } : null} onValueChange={v => setSubjectId(v?.value ?? "")} isItemEqualToValue={(a, b) => a.value === b.value}>
                <ComboboxInput placeholder={t("selectSubject")} showClear />
                <ComboboxContent>
                  <ComboboxList>
                    {subjectOptions.map(o => (
                      <ComboboxItem key={o.id} value={{ value: o.id, label: o.name }}>
                        {o.name}
                        {" "}
                        (
                        {o.id}
                        )
                      </ComboboxItem>
                    ))}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            </div>
          </div>

          {subjectNs === "group" && (
            <div className="space-y-2">
              <Label>{t("subjectRelation")}</Label>
              <Input value={subjectRelation} onChange={e => setSubjectRelation(e.target.value)} placeholder={t("subjectRelationPlaceholder")} />
            </div>
          )}
        </div>

        {mutation.error && (
          <p className="text-sm text-destructive">{(mutation.error as Error).message}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!objectId || !relation || !subjectId || mutation.isPending}
          >
            {mutation.isPending ? t("creating") : t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditTupleDialog({ tuple }: { readonly tuple: RelationTuple }) {
  const { t } = useTranslation("policies");
  const [open, setOpen] = useState(false);
  const [relation, setRelation] = useState(tuple.relation);
  const queryClient = useQueryClient();

  const availableRelations = RELATIONS[tuple.namespace] ?? [];

  const mutation = useMutation({
    mutationFn: () => http(`/tuples/${tuple.id}`, {
      method: "PATCH",
      body: JSON.stringify({ relation }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tuples"] });
      setOpen(false);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v)
          setRelation(tuple.relation);
      }}
    >
      <DialogTrigger render={<Button variant="ghost" size="sm">{t("common.edit")}</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editTupleTitle")}</DialogTitle>
          <DialogDescription>{t("editTupleDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>{t("relation")}</Label>
            <Select value={relation} onValueChange={handleSelect(setRelation)}>
              <SelectTrigger><SelectValue>{(v: string) => v ? t(`rel.${v}`) : t("selectRelation")}</SelectValue></SelectTrigger>
              <SelectContent>
                {availableRelations.map(r => <SelectItem key={r} value={r}>{t(`rel.${r}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        {mutation.error && (
          <p className="text-sm text-destructive">{(mutation.error as Error).message}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={relation === tuple.relation || mutation.isPending}
          >
            {mutation.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ResourceGroup {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

interface ResourceGroupsResponse {
  success: boolean;
  data: ResourceGroup[];
}

interface ResourceGroupMember {
  tupleId: string;
  namespace: string;
  objectId: string;
  objectName: string | null;
}

interface ResourceGroupMembersResponse {
  success: boolean;
  data: ResourceGroupMember[];
}

function ResourceGroupManager() {
  const { t } = useTranslation("policies");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: groupsData, isLoading } = useQuery({
    queryKey: ["resource-groups"],
    queryFn: () => http<ResourceGroupsResponse>("/policy/resource-groups"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => http(`/resource-groups/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["resource-groups"] });
      if (selectedId === id)
        setSelectedId(null);
    },
  });

  const groups = groupsData?.data ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t("resourceGroupList")}</CardTitle>
              <CardDescription>{t("resourceGroupListDescription")}</CardDescription>
            </div>
            <CreateResourceGroupDialog />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading
            ? <p className="text-sm text-muted-foreground">{t("loading")}</p>
            : groups.length === 0
              ? <p className="text-sm text-muted-foreground">{t("noResourceGroups")}</p>
              : (
                  <div className="space-y-2">
                    {groups.map(group => (
                      <div
                        key={group.id}
                        className={`flex items-center justify-between rounded-md border px-3 py-2 cursor-pointer transition-colors ${selectedId === group.id ? "bg-muted/50 border-primary/50" : "hover:bg-muted/30"}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedId(group.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ")
                            setSelectedId(group.id);
                        }}
                      >
                        <div>
                          <p className="text-sm font-medium">{group.name}</p>
                          {group.description && <p className="text-xs text-muted-foreground">{group.description}</p>}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteMutation.mutate(group.id);
                          }}
                          disabled={deleteMutation.isPending}
                        >
                          {t("common.delete")}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("resourceGroupMembers")}</CardTitle>
          <CardDescription>{t("resourceGroupMembersDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {selectedId
            ? <ResourceGroupMemberList groupId={selectedId} />
            : <p className="text-sm text-muted-foreground">{t("selectResourceGroup")}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function CreateResourceGroupDialog() {
  const { t } = useTranslation("policies");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => http("/policy/resource-groups", {
      method: "POST",
      body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["resource-groups"] });
      setOpen(false);
      setName("");
      setDescription("");
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm">{t("createResourceGroup")}</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createResourceGroupTitle")}</DialogTitle>
          <DialogDescription>{t("createResourceGroupDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>{t("resourceGroupName")}</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder={t("resourceGroupNamePlaceholder")} />
          </div>
          <div className="space-y-2">
            <Label>{t("resourceGroupDescription")}</Label>
            <Input value={description} onChange={e => setDescription(e.target.value)} placeholder={t("resourceGroupDescriptionPlaceholder")} />
          </div>
        </div>
        {mutation.error && (
          <p className="text-sm text-destructive">{(mutation.error as Error).message}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!name.trim() || mutation.isPending}
          >
            {mutation.isPending ? t("creating") : t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResourceGroupMemberList({ groupId }: { readonly groupId: string }) {
  const { t } = useTranslation("policies");
  const queryClient = useQueryClient();

  const { data: membersData, isLoading } = useQuery({
    queryKey: ["resource-group-members", groupId],
    queryFn: () => http<ResourceGroupMembersResponse>(`/resource-groups/${groupId}/members`),
  });

  const removeMutation = useMutation({
    mutationFn: (tupleId: string) => http(`/resource-groups/${groupId}/members/${tupleId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["resource-group-members", groupId] });
    },
  });

  const members = membersData?.data ?? [];

  return (
    <div className="space-y-4">
      {isLoading
        ? <p className="text-sm text-muted-foreground">{t("loading")}</p>
        : members.length === 0
          ? <p className="text-sm text-muted-foreground">{t("noMembers")}</p>
          : (
              <div className="space-y-2">
                {members.map(member => (
                  <div key={member.tupleId} className="flex items-center justify-between rounded-md border px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{t(`ns.${member.namespace}`)}</Badge>
                      <span className="text-sm">{member.objectName ?? member.objectId}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => removeMutation.mutate(member.tupleId)}
                      disabled={removeMutation.isPending}
                    >
                      {t("common.delete")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
    </div>
  );
}

function PermissionChecker() {
  const { t } = useTranslation("policies");
  const [ns, setNs] = useState<string>(NAMESPACES[0]);
  const [objectId, setObjectId] = useState("");
  const [relation, setRelation] = useState("");
  const [subjectNs, setSubjectNs] = useState("user");
  const [subjectId, setSubjectId] = useState("");
  const [result, setResult] = useState<CheckResponse["data"] | null>(null);
  const { data: entities } = useEntities();

  const mutation = useMutation({
    mutationFn: () => http<CheckResponse>("/policy/check", {
      method: "POST",
      body: JSON.stringify({
        namespace: ns,
        objectId,
        relation,
        subjectNamespace: subjectNs,
        subjectId,
      }),
    }),
    onSuccess: data => setResult(data.data),
  });

  const availableRelations = RELATIONS[ns] ?? [];
  const objectOptions = entities?.data?.[ns] ?? [];
  const subjectOptions = entities?.data?.[subjectNs] ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("permissionCheck")}</CardTitle>
        <CardDescription>
          {t("checkDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label>{t("namespace")}</Label>
            <Select
              value={ns}
              onValueChange={handleSelect((v) => {
                setNs(v);
                setRelation("");
                setObjectId("");
              })}
            >
              <SelectTrigger><SelectValue>{(v: string) => t(`ns.${v}`)}</SelectValue></SelectTrigger>
              <SelectContent>
                {NAMESPACES.map(n => <SelectItem key={n} value={n}>{t(`ns.${n}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t("object")}</Label>
            <Combobox value={objectId ? { value: objectId, label: objectOptions.find(o => o.id === objectId)?.name ?? objectId } : null} onValueChange={v => setObjectId(v?.value ?? "")} isItemEqualToValue={(a, b) => a.value === b.value}>
              <ComboboxInput placeholder={t("selectObject")} showClear />
              <ComboboxContent>
                <ComboboxList>
                  {objectOptions.map(o => (
                    <ComboboxItem key={o.id} value={{ value: o.id, label: o.name }}>
                      {o.name}
                      {" "}
                      (
                      {o.id}
                      )
                    </ComboboxItem>
                  ))}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>
          <div className="space-y-2">
            <Label>{t("relation")}</Label>
            <Select value={relation} onValueChange={handleSelect(setRelation)}>
              <SelectTrigger><SelectValue>{(v: string) => v ? t(`rel.${v}`) : t("select")}</SelectValue></SelectTrigger>
              <SelectContent>
                {availableRelations.map(r => <SelectItem key={r} value={r}>{t(`rel.${r}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t("subjectNamespace")}</Label>
            <Select
              value={subjectNs}
              onValueChange={handleSelect((v) => {
                setSubjectNs(v);
                setSubjectId("");
              })}
            >
              <SelectTrigger><SelectValue>{(v: string) => t(`ns.${v}`)}</SelectValue></SelectTrigger>
              <SelectContent>
                {SUBJECT_NAMESPACES.map(n => <SelectItem key={n} value={n}>{t(`ns.${n}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t("subject")}</Label>
            <Combobox value={subjectId ? { value: subjectId, label: subjectOptions.find(o => o.id === subjectId)?.name ?? subjectId } : null} onValueChange={v => setSubjectId(v?.value ?? "")} isItemEqualToValue={(a, b) => a.value === b.value}>
              <ComboboxInput placeholder={t("selectSubject")} showClear />
              <ComboboxContent>
                <ComboboxList>
                  {subjectOptions.map(o => (
                    <ComboboxItem key={o.id} value={{ value: o.id, label: o.name }}>
                      {o.name}
                      {" "}
                      (
                      {o.id}
                      )
                    </ComboboxItem>
                  ))}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>
        </div>

        <Button
          onClick={() => mutation.mutate()}
          disabled={!objectId || !relation || !subjectId || mutation.isPending}
        >
          {mutation.isPending ? t("checking") : t("checkPermission")}
        </Button>

        {mutation.error && (
          <p className="text-sm text-destructive">{(mutation.error as Error).message}</p>
        )}

        {result && (
          <div className={`rounded-lg border p-4 ${result.allowed ? "border-green-500/50 bg-green-500/5" : "border-red-500/50 bg-red-500/5"}`}>
            <div className="flex items-center gap-2 mb-2">
              <Badge variant={result.allowed ? "default" : "destructive"}>
                {result.allowed ? t("allowed") : t("denied")}
              </Badge>
              <span className="text-sm font-mono">
                {ns}
                :
                {objectId}
                #
                {relation}
                @
                {subjectNs}
                :
                {subjectId}
              </span>
            </div>
            {result.resolvedThrough.length > 0 && (
              <div className="mt-2 space-y-1">
                <p className="text-xs text-muted-foreground">{t("resolvedThrough")}</p>
                {result.resolvedThrough.map(path => (
                  <p key={path} className="text-xs font-mono pl-4">{path}</p>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
