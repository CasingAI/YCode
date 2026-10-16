/**
 * 数据根解析：始终扫描家目录下的 .zcode 与 .ycode；配置了自定义数据目录时，再扫描该目录下两者。
 * 路径来源由调用方注入（desktop host 传 homedir 与 getDataBaseDir），模块内不读环境变量。
 */
import { join, resolve } from "node:path";
import type { RootsResolverPort } from "../app/ports.js";
import type { StorageRootSpec } from "@zcode/shared";

export function resolveStorageRoots(params: {
  homeDir: string;
  dataBaseDir: string;
}): StorageRootSpec[] {
  const home = resolve(params.homeDir);
  const dataBase = resolve(params.dataBaseDir);
  const hasCustomDataBaseDir = dataBase !== home;
  const roots: StorageRootSpec[] = [
    {
      id: "home",
      path: join(home, ".zcode"),
      hasCustomDataBaseDir,
    },
    {
      id: "ycodeHome",
      path: join(home, ".ycode"),
      hasCustomDataBaseDir,
    },
  ];
  if (hasCustomDataBaseDir) {
    roots.push(
      {
        id: "dataBaseDir",
        path: join(dataBase, ".zcode"),
        hasCustomDataBaseDir,
      },
      {
        id: "ycodeDataBaseDir",
        path: join(dataBase, ".ycode"),
        hasCustomDataBaseDir,
      },
    );
  }
  return roots;
}

export function createStorageRootsResolver(params: {
  getHomeDir: () => string;
  getDataBaseDir: () => string;
}): RootsResolverPort {
  return {
    resolveRoots: async () =>
      resolveStorageRoots({ homeDir: params.getHomeDir(), dataBaseDir: params.getDataBaseDir() }),
  };
}
