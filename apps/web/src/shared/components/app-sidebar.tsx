import { Link, useRouterState } from "@tanstack/react-router";
import { Languages, LogOut, Monitor, Moon, Palette, Settings, Sun } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Logo } from "@/shared/components/logo";
import { SettingsDialog } from "@/shared/components/settings-dialog";
import { getNavItems } from "@/shared/components/sidebar/registry";
import { useTheme } from "@/shared/components/theme-provider";
import { Avatar, AvatarFallback } from "@/shared/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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

const LANGUAGES = [
  { code: "zh", label: "中文" },
  { code: "en", label: "English" },
] as const;

const THEMES = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
] as const;

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
  const { t, i18n } = useTranslation(["common", "settings"]);
  const { theme, setTheme } = useTheme();
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
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Languages className="mr-2 size-4" />
                        {t("settings:language")}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuRadioGroup
                          value={i18n.language}
                          onValueChange={lng => void i18n.changeLanguage(lng)}
                        >
                          {LANGUAGES.map(lang => (
                            <DropdownMenuRadioItem key={lang.code} value={lang.code}>
                              {lang.label}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Palette className="mr-2 size-4" />
                        {t("settings:theme")}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuRadioGroup
                          value={theme}
                          onValueChange={v => setTheme(v as typeof THEMES[number]["value"])}
                        >
                          {THEMES.map(({ value, icon: Icon }) => (
                            <DropdownMenuRadioItem key={value} value={value}>
                              <Icon className="mr-2 size-4" />
                              {t(`theme.${value}`)}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
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
