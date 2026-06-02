/* eslint-disable react-refresh/only-export-components */
import type { LucideIcon } from "lucide-react";
import { createLazyFileRoute, Link } from "@tanstack/react-router";
import { CheckSquare, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardDescription, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { useAuthStore } from "@/shared/stores/auth";

export const Route = createLazyFileRoute("/_app/overview")({
  component: PortalPage,
});

// Single source of truth for portal landing tiles. Add a new tile here and
// it will appear on the portal home automatically; descriptions resolve to
// `portal.tile.<key>Description` and titles to `nav.<key>` in i18n.
interface PortalTile {
  readonly key: string;
  readonly path: string;
  readonly icon: LucideIcon;
}

const PORTAL_TILES: readonly PortalTile[] = [
  { key: "myIssues", path: "/issues", icon: CheckSquare },
  { key: "documents", path: "/documents", icon: FileText },
];

function PortalPage() {
  const { t } = useTranslation(["common", "portal"]);
  const user = useAuthStore(s => s.user);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">
          {t("portal:welcome", { name: user?.name ?? user?.username ?? "" })}
        </h1>
        <p className="mt-1 text-muted-foreground">{t("portal:page.description")}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PORTAL_TILES.map(tile => (
          <Link key={tile.key} to={tile.path}>
            <Card size="sm" className="h-full cursor-pointer transition-colors hover:bg-muted/50">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <tile.icon className="size-5" />
                  </div>
                  <div>
                    <CardTitle className="text-sm">{t(`nav.${tile.key}`)}</CardTitle>
                    <CardDescription className="text-xs">
                      {t(`portal:tile.${tile.key}Description`)}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
