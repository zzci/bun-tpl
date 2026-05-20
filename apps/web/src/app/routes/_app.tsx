/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppSidebar } from "@/shared/components/app-sidebar";
import { FullPageLoader } from "@/shared/components/full-page-loader";
import { Logo } from "@/shared/components/logo";
import { Button } from "@/shared/components/ui/button";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/shared/components/ui/sidebar";
import { useAuthStore } from "@/shared/stores/auth";
import { useSystemStore } from "@/shared/stores/system";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const systemStatus = useSystemStore(s => s.status);
  const { user, loading, fetchUser } = useAuthStore();
  // Track network failure separately so we can distinguish "couldn't reach
  // server" from a clean 401 unauthenticated response. `fetchUser` now
  // categorises the failure for us in a single request.
  const [networkError, setNetworkError] = useState(false);

  const loadUser = useCallback(async () => {
    setNetworkError(false);
    const result = await fetchUser();
    if (result.kind === "networkError")
      setNetworkError(true);
  }, [fetchUser]);

  useEffect(() => {
    if (systemStatus === "unlocked")
      void loadUser();
  }, [systemStatus, loadUser]);

  useEffect(() => {
    if (loading || systemStatus !== "unlocked" || user || networkError)
      return;
    const current = window.location.pathname + window.location.search;
    void navigate({ to: "/login", search: { redirect: current }, replace: true });
  }, [loading, systemStatus, user, networkError, navigate]);

  // System not unlocked — __root.tsx handles redirect to /unlock or /setup
  if (systemStatus !== "unlocked") {
    return <FullPageLoader />;
  }

  if (networkError) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background p-4">
        <div className="mx-auto max-w-md text-center space-y-4">
          <h1 className="text-xl font-bold">{t("common.networkError.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("common.networkError.description")}</p>
          <Button onClick={() => void loadUser()}>
            {t("common.retry")}
          </Button>
        </div>
      </div>
    );
  }

  if (loading) {
    return <FullPageLoader />;
  }

  if (!user) {
    return <FullPageLoader />;
  }

  return (
    <SidebarProvider
      defaultOpen={false}
      style={{ "--sidebar-width-icon": "3.75rem" } as React.CSSProperties}
    >
      {/* WCAG 2.4.1 Bypass Blocks — first focusable target on every page;
          becomes visible on keyboard focus and jumps past the sidebar. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
      >
        {t("common.skipToContent", "Skip to main content")}
      </a>
      <AppSidebar />
      <SidebarInset className="h-svh">
        {/* Mobile-only header — logo on the left, sidebar trigger on
            the right so the brand reads first and the menu sits where
            a thumb naturally lands. */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3 md:hidden">
          <Link
            to="/portal"
            className="flex items-center hover:opacity-90 transition-opacity"
            aria-label={t("nav.home")}
          >
            <Logo className="size-7" />
          </Link>
          <SidebarTrigger />
        </header>

        <main id="main-content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col overflow-auto px-4 py-3 md:px-6 md:py-4">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
