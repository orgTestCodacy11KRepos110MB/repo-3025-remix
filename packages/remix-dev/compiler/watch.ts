import chokidar from "chokidar";
import debounce from "lodash.debounce";
import * as path from "path";

import type { RemixConfig } from "../config";
import { readConfig } from "../config";
import type { AssetsManifest } from "./assets";
import { logCompileFailure } from "./onCompileFailure";
import type { CompileOptions } from "./options";
import { compile, createRemixCompiler, dispose } from "./remixCompiler";
import { warnOnce } from "./warnings";

function isEntryPoint(config: RemixConfig, file: string): boolean {
  let appFile = path.relative(config.appDirectory, file);
  let entryPoints = [
    config.entryClientFile,
    config.entryServerFile,
    ...Object.values(config.routes).map((route) => route.file),
  ];
  return entryPoints.includes(appFile);
}

export type WatchOptions = Partial<CompileOptions> & {
  reloadConfig?(root: string): Promise<RemixConfig>;
  onRebuildStart?(): void;
  onRebuildFinish?(durationMs: number, assetsManifest?: AssetsManifest): void;
  onFileCreated?(file: string): void;
  onFileChanged?(file: string): void;
  onFileDeleted?(file: string): void;
  onInitialBuild?(durationMs: number): void;
};

export async function watch(
  config: RemixConfig,
  {
    mode = "development",
    liveReloadPort,
    target = "node14",
    sourcemap = true,
    reloadConfig = readConfig,
    onWarning = warnOnce,
    onCompileFailure = logCompileFailure,
    onRebuildStart,
    onRebuildFinish,
    onFileCreated,
    onFileChanged,
    onFileDeleted,
    onInitialBuild,
  }: WatchOptions = {}
): Promise<() => Promise<void>> {
  let options: CompileOptions = {
    mode,
    liveReloadPort,
    target,
    sourcemap,
    onCompileFailure,
    onWarning,
  };

  let start = Date.now();
  let compiler = createRemixCompiler(config, options);

  // initial build
  await compile(compiler);
  onInitialBuild?.(Date.now() - start);

  let restart = debounce(async () => {
    onRebuildStart?.();
    let start = Date.now();
    dispose(compiler);

    try {
      config = await reloadConfig(config.rootDirectory);
    } catch (error: unknown) {
      onCompileFailure(error as Error);
      return;
    }

    compiler = createRemixCompiler(config, options);
    let assetsManifest = await compile(compiler);
    onRebuildFinish?.(Date.now() - start, assetsManifest);
  }, 500);

  let rebuild = debounce(async () => {
    onRebuildStart?.();
    let start = Date.now();
    let assetsManifest = await compile(compiler, { onCompileFailure });
    onRebuildFinish?.(Date.now() - start, assetsManifest);
  }, 100);

  let toWatch = [config.appDirectory];
  if (config.serverEntryPoint) {
    toWatch.push(config.serverEntryPoint);
  }

  config.watchPaths?.forEach((watchPath) => {
    toWatch.push(watchPath);
  });

  let watcher = chokidar
    .watch(toWatch, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100,
      },
    })
    .on("error", (error) => console.error(error))
    .on("change", async (file) => {
      onFileChanged?.(file);
      await rebuild();
    })
    .on("add", async (file) => {
      onFileCreated?.(file);

      try {
        config = await reloadConfig(config.rootDirectory);
      } catch (error: unknown) {
        onCompileFailure(error as Error);
        return;
      }

      await (isEntryPoint(config, file) ? restart : rebuild)();
    })
    .on("unlink", async (file) => {
      onFileDeleted?.(file);
      await (isEntryPoint(config, file) ? restart : rebuild)();
    });

  return async () => {
    await watcher.close().catch(() => undefined);
    dispose(compiler);
  };
}
