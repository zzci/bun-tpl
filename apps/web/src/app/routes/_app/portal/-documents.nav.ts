import type { NavItem } from "@/shared/components/sidebar/types";
import { Layers } from "lucide-react";

export const documentsNav: NavItem = {
  area: "portal",
  key: "documents",
  path: "/portal/documents",
  icon: Layers,
  order: 30,
};
