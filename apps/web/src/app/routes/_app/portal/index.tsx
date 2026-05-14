import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/portal/")({
  staticData: { titleKey: "portal:page.title" },
});
