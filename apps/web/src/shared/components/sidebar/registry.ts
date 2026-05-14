import type { NavArea, NavItem } from "./types";
import { auditNav } from "@/app/routes/_app/admin/-audit.nav";
import { cronNav } from "@/app/routes/_app/admin/-cron.nav";
import { policiesNav } from "@/app/routes/_app/admin/-policies.nav";
import { settingsNav } from "@/app/routes/_app/admin/-settings.nav";
import { usersNav } from "@/app/routes/_app/admin/-users.nav";
import { documentsNav } from "@/app/routes/_app/portal/-documents.nav";
import { issuesNav } from "@/app/routes/_app/portal/-issues.nav";
import { portalNav } from "@/app/routes/_app/portal/-portal.nav";

const NAV_ITEMS: readonly NavItem[] = [
  portalNav,
  issuesNav,
  documentsNav,
  usersNav,
  policiesNav,
  auditNav,
  cronNav,
  settingsNav,
];

export function getNavItems(area: NavArea): NavItem[] {
  return NAV_ITEMS
    .filter(item => item.area === area)
    .toSorted((a, b) => a.order - b.order);
}
