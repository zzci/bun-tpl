import type { BackupContribution } from "@/modules/backup/registry";
import { issueDetails } from "@/modules/issue/schema";

export const issueBackupContribution: BackupContribution = {
  name: "issues",
  tables: [issueDetails],
  // issue_details FK → items.id; items / item_comments / item_attachments
  // and the policy tuples that carry assignee + share state come from the
  // base `items` and `policies` contributions. Listing them as deps keeps
  // the topological insert order correct on restore.
  deps: ["items", "policies"],
};
