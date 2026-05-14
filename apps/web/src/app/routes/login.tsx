/* eslint-disable react-refresh/only-export-components */
import { createFileRoute } from "@tanstack/react-router";
import { LogIn } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Logo } from "@/shared/components/logo";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { APP_DISPLAY_NAME } from "@/shared/lib/branding";
import { BASE_PATH, http, HttpError } from "@/shared/lib/http";

interface LoginSearchParams {
  redirect: string | undefined;
}

interface AuthMode {
  mode: "single-user" | "oauth";
  oauthConfigured: boolean;
}

export const Route = createFileRoute("/login")({
  staticData: { titleKey: "login:title" },
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>): LoginSearchParams => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
});

function isSafeRedirect(url: string | undefined): string {
  if (!url)
    return `${BASE_PATH}/portal`;
  if (!url.startsWith("/") || url.startsWith("//"))
    return `${BASE_PATH}/portal`;
  return url;
}

function LoginPage() {
  const { t } = useTranslation(["common", "login"]);
  const { redirect } = Route.useSearch();
  const target = isSafeRedirect(redirect);

  const [mode, setMode] = useState<AuthMode | null>(null);

  useEffect(() => {
    void http<{ success: boolean; data: AuthMode }>("/account/auth/mode")
      .then(res => setMode(res.data))
      .catch(() => setMode({ mode: "oauth", oauthConfigured: false }));
  }, []);

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-4">
      <div className="mx-auto w-full max-w-xs text-center">
        <Logo className="mx-auto size-10 mb-3" />
        <h1 className="text-2xl font-bold tracking-tight">
          {APP_DISPLAY_NAME}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("login:description")}
        </p>

        {mode === null
          ? null
          : mode.mode === "single-user"
            ? <SingleUserForm redirectTarget={target} />
            : <OAuthButton redirectTarget={target} />}
      </div>
    </div>
  );
}

function OAuthButton({ redirectTarget }: { redirectTarget: string }) {
  const { t } = useTranslation(["common", "login"]);
  const loginUrl = `${BASE_PATH}/api/account/auth/login?redirect=${encodeURIComponent(redirectTarget)}`;
  return (
    <a href={loginUrl} className="mt-6 block">
      <Button className="w-full">
        <LogIn className="mr-2 size-4" />
        {t("login:button")}
      </Button>
    </a>
  );
}

function SingleUserForm({ redirectTarget }: { redirectTarget: string }) {
  const { t } = useTranslation(["common", "login"]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting)
      return;
    setSubmitting(true);
    setError(null);
    try {
      await http("/account/auth/login-local", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      window.location.href = redirectTarget;
    }
    catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        setError(t("login:rateLimited"));
      }
      else {
        setError(t("login:invalidCredentials"));
      }
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-3 text-left">
      <div className="space-y-1.5">
        <Label htmlFor="login-username">{t("login:username")}</Label>
        <Input
          id="login-username"
          name="username"
          autoComplete="username"
          autoFocus
          required
          value={username}
          onChange={e => setUsername(e.currentTarget.value)}
          disabled={submitting}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="login-password">{t("login:password")}</Label>
        <Input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={e => setPassword(e.currentTarget.value)}
          disabled={submitting}
        />
      </div>
      {error
        ? <p className="text-sm text-destructive">{error}</p>
        : null}
      <Button type="submit" className="w-full" disabled={submitting}>
        <LogIn className="mr-2 size-4" />
        {t("login:button")}
      </Button>
    </form>
  );
}
