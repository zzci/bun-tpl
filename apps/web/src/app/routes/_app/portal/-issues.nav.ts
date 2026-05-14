import type { NavItem } from "@/shared/components/sidebar/types";
import { CheckSquare } from "lucide-react";

export const issuesNav: NavItem = {
  area: "portal",
  key: "myIssues",
  path: "/portal/issues",
  icon: CheckSquare,
  order: 20,
};
