import type { NavItem } from "@/shared/components/sidebar/types";
import { LayoutGrid } from "lucide-react";

export const portalNav: NavItem = {
  area: "portal",
  key: "portal",
  path: "/portal",
  icon: LayoutGrid,
  order: 10,
};
