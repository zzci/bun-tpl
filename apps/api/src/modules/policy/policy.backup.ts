import type { BackupContribution } from "@/modules/backup/registry";
import { relationTuples } from "@/modules/policy/schema";

export const policyBackupContribution: BackupContribution = {
  name: "policies",
  tables: [relationTuples],
  // Tuples reference user / group ids, so users must restore first.
  deps: ["users"],
};
