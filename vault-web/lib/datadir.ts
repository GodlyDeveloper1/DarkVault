// Where the server keeps auction records. VAULT_DATA_DIR points it somewhere
// else: a mounted volume when hosted, or a throwaway folder for tests.
import "server-only";
import path from "node:path";

export const DATA_DIR = process.env.VAULT_DATA_DIR
  ? path.resolve(process.env.VAULT_DATA_DIR)
  : path.join(process.cwd(), "data");
