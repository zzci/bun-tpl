/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/issues")({
  staticData: { titleKey: "issues:page.title" },
  component: IssuesLayout,
});

function IssuesLayout() {
  return <Outlet />;
}
