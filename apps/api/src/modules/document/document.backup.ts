import type { BackupContribution } from "@/modules/backup/registry";
import { documentDetails } from "@/modules/document/schema";

export const documentBackupContribution: BackupContribution = {
  name: "documents",
  tables: [documentDetails],
  // document_details FK → items.id; items / item_comments / item_attachments
  // and the policy tuples that carry share + parent_item edges come from
  // the base `items` and `policies` contributions. Listing them as deps
  // keeps the topological insert order correct on restore.
  deps: ["items", "policies"],
};
