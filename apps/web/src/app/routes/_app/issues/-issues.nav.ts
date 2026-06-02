import type { NavItem } from "@/shared/components/sidebar/types";
import { CheckSquare } from "lucide-react";

export const issuesNav: NavItem = {
  area: "main",
  key: "myIssues",
  path: "/issues",
  icon: CheckSquare,
  order: 20,
};
