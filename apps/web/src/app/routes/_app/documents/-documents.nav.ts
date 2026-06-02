import type { NavItem } from "@/shared/components/sidebar/types";
import { Layers } from "lucide-react";

export const documentsNav: NavItem = {
  area: "main",
  key: "documents",
  path: "/documents",
  icon: Layers,
  order: 30,
};
