import { registerBackupContribution } from "@/modules/backup/registry";
import { registerAuthProvider } from "@/shared/middleware/auth-registry";
import { accountBackupContribution } from "./account.backup";
import { oauthSessionAuthProvider } from "./auth/auth.service";

export { accountRoutes } from "./account.routes";

registerBackupContribution(accountBackupContribution);
registerAuthProvider(oauthSessionAuthProvider);
