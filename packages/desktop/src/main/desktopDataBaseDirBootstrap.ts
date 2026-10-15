import { initializeYCodeDatabaseMode, resolveYCodeStartupDataBaseDir } from "@zcode/shared/node";
import { setDataBaseDir } from "@zcode/services/node";

export async function applyEarlyDataBaseDirBootstrap(): Promise<string> {
  await initializeYCodeDatabaseMode();
  const dataBaseDir = await resolveYCodeStartupDataBaseDir();
  setDataBaseDir(dataBaseDir);
  return dataBaseDir;
}
