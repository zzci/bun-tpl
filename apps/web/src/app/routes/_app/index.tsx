/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/")({
  component: IndexRedirect,
});

// `/` is just an entry point — the real landing page is `/overview`.
// Auth is already enforced by the `_app` layout, so an unauthenticated
// visitor is redirected to `/login` before this ever renders.
function IndexRedirect() {
  return <Navigate to="/overview" />;
}
