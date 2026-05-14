import { registerBackupContribution } from "@/modules/backup/registry";
import { issueBackupContribution } from "./issue.backup";

export { issueRoutes } from "./issue.routes";

registerBackupContribution(issueBackupContribution);
