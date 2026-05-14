import { registerBackupContribution } from "@/modules/backup/registry";
import { documentBackupContribution } from "./document.backup";

// Side-effect import: registers the document resource with the policy
// framework. The `documentAccess` client is re-exported below so other
// modules can compose against the same vocabulary.
export { documentAccess } from "./document.permission";
export { documentRoutes } from "./document.routes";

registerBackupContribution(documentBackupContribution);
