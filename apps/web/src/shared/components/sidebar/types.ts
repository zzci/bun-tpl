import type { LucideIcon } from "lucide-react";

export type NavArea = "portal" | "admin";

export interface NavItem {
  readonly area: NavArea;
  readonly key: string;
  readonly path: string;
  readonly icon: LucideIcon;
  readonly matchPrefix?: string;
  readonly order: number;
}
