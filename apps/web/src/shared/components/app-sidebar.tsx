import { Link, useRouterState } from "@tanstack/react-router";
import { LogOut, Settings } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Logo } from "@/shared/components/logo";
import { SettingsDialog } from "@/shared/components/settings-dialog";
import { getNavItems } from "@/shared/components/sidebar/registry";
import { Avatar, AvatarFallback } from "@/shared/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/shared/components/ui/sidebar";
import { TooltipProvider } from "@/shared/components/ui/tooltip";
import { useAuthStore } from "@/shared/stores/auth";

// ---------- Helpers ----------

function isNavActive(
  item: { path: string; matchPrefix?: string },
  pathname: string,
): boolean {
  const prefix = item.matchPrefix ?? item.path;
  if (prefix === "/portal" || prefix === "/") {
    return pathname === prefix || pathname === `${prefix}/`;
  }
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map(n => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

// ============================================================
// Main exported component
// ============================================================

export function AppSidebar() {
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const [settingsOpen, setSettingsOpen] = useState(false);

  const portalNav = getNavItems("portal");
  const adminNav = getNavItems("admin");

  return (
    <TooltipProvider delay={120}>
      <Sidebar collapsible="icon">
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

        {/* Logo */}
        <SidebarHeader className="items-center">
          <Link
            to="/portal"
            className="flex items-center justify-center size-9 rounded-xl hover:opacity-90 transition-opacity"
            aria-label={t("nav.home")}
          >
            <Logo className="size-7" />
          </Link>
        </SidebarHeader>

        <SidebarSeparator />

        {/* Nav */}
        <SidebarContent>
          {/* Portal nav */}
          <SidebarGroup>
            <SidebarMenu>
              {portalNav.map(item => (
                <SidebarMenuItem key={item.key}>
                  <SidebarMenuButton
                    isActive={isNavActive(item, currentPath)}
                    render={<Link to={item.path} />}
                    tooltip={t(`nav.${item.key}`)}
                  >
                    <item.icon />
                    <span>{t(`nav.${item.key}`)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>

          {/* Admin nav */}
          {user?.role === "admin" && (
            <>
              <SidebarSeparator />
              <SidebarGroup>
                <SidebarMenu>
                  {adminNav.map(item => (
                    <SidebarMenuItem key={item.key}>
                      <SidebarMenuButton
                        isActive={isNavActive(item, currentPath)}
                        render={<Link to={item.path} />}
                        tooltip={t(`nav.${item.key}`)}
                      >
                        <item.icon />
                        <span>{t(`nav.${item.key}`)}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            </>
          )}
        </SidebarContent>

        {/* Footer: user avatar + dropdown */}
        <SidebarSeparator />
        <SidebarFooter>
          {user && (
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<SidebarMenuButton size="lg" />}
                  >
                    <Avatar className="size-7">
                      <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                        {getInitials(user.name)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate text-sm">{user.name}</span>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="end" sideOffset={10} className="w-44">
                    <DropdownMenuItem disabled>
                      <span className="text-xs text-muted-foreground truncate">
                        {user.name}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
                      <Settings className="mr-2 size-4" />
                      {t("nav.settings")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => void logout()}
                    >
                      <LogOut className="mr-2 size-4" />
                      {t("auth.logout")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          )}
        </SidebarFooter>
      </Sidebar>
    </TooltipProvider>
  );
}
