import { resolve } from 'path';

import { BuildOptions, BuildResult, build } from 'esbuild';
import * as ts from 'typescript';

import { FileSystem } from '@rushstack/node-core-library/lib/FileSystem';

import type { IHeftPlugin, HeftSession, HeftConfiguration } from '@rushstack/heft';
import type { ICommonTranspileOptions, IProjectOptions } from './types';
import { loadTsconfig, TExtendedTypeScript } from './readTsConfig';

const pluginName: 'ESBuildTranspilePlugin' = 'ESBuildTranspilePlugin';

const plugin: IHeftPlugin<ICommonTranspileOptions> = {
  pluginName,

  apply(session: HeftSession, configuration: HeftConfiguration, options: ICommonTranspileOptions = {}): void {
    // Nothing
  }
};

const moduleMap: Record<ts.ModuleKind, BuildOptions['format']> = {
  [ts.ModuleKind.CommonJS]: 'cjs',
  [ts.ModuleKind.ES2015]: 'esm',
  [ts.ModuleKind.ES2020]: 'esm',
  [ts.ModuleKind.ES2022]: 'esm',
  [ts.ModuleKind.ESNext]: 'esm',
  [ts.ModuleKind.Node12]: 'esm',
  [ts.ModuleKind.NodeNext]: 'esm',

  [ts.ModuleKind.AMD]: undefined,
  [ts.ModuleKind.None]: undefined,
  [ts.ModuleKind.UMD]: undefined,
  [ts.ModuleKind.System]: undefined
};

const targetMap: Record<ts.ScriptTarget, BuildOptions['target']> = {
  [ts.ScriptTarget.ES2015]: 'es2015',
  [ts.ScriptTarget.ES2016]: 'es2016',
  [ts.ScriptTarget.ES2017]: 'es2017',
  [ts.ScriptTarget.ES2018]: 'es2018',
  [ts.ScriptTarget.ES2019]: 'es2019',
  [ts.ScriptTarget.ES2020]: 'es2020',
  [ts.ScriptTarget.ES2021]: 'es2021',
  [ts.ScriptTarget.ES2022]: 'es2022',
  [ts.ScriptTarget.ESNext]: 'esnext',

  [ts.ScriptTarget.ES5]: 'es5',
  [ts.ScriptTarget.ES3]: 'es3',
  [ts.ScriptTarget.JSON]: undefined,
  [ts.ScriptTarget.Latest]: 'esnext'
};

export async function transpileProjectAsync(
  projectOptions: IProjectOptions,
  pluginOptions: ICommonTranspileOptions
): Promise<void> {
  const { tsConfigPath = './tsconfig.json' } = pluginOptions;

  console.log(`Initialized`, process.uptime());

  const { buildFolder } = projectOptions;

  const resolvedTsConfigPath: string = resolve(buildFolder, tsConfigPath);

  const {
    fileNames,
    options: { module, outDir, sourceMap, target: rawTarget, inlineSourceMap }
  } = loadTsconfig(ts as TExtendedTypeScript, projectOptions, pluginOptions);

  console.log(`Read Config`, process.uptime());
  const outdir: string = outDir ?? resolve(buildFolder, 'lib');

  FileSystem.ensureEmptyFolder(outdir);

  const format: BuildOptions['format'] = module !== undefined ? moduleMap[module] : module;
  if (format === undefined) {
    throw new Error(`Unsupported Module Kind: ${module && ts.ModuleKind[module]} for esbuild`);
  }

  const target: BuildOptions['target'] = rawTarget !== undefined ? targetMap[rawTarget] : rawTarget;
  if (target === undefined) {
    throw new Error(`Unsupported Target: ${target && ts.ScriptTarget[target]} for esbuild`);
  }

  const options: BuildOptions = {
    absWorkingDir: buildFolder,
    bundle: false,
    format,
    entryPoints: fileNames,
    outdir,
    preserveSymlinks: false,
    sourcemap: inlineSourceMap ? (sourceMap ? 'both' : 'inline') : sourceMap ? 'external' : undefined,
    splitting: false,
    tsconfig: resolvedTsConfigPath
  };

  console.log(`Starting Transpile`, process.uptime());

  const result: BuildResult = await build(options);
  if (result.warnings.length) {
    for (const warning of result.warnings) {
      console.warn(warning);
    }
  }
  if (result.errors.length) {
    for (const error of result.errors) {
      console.error(error);
    }
  }
}

export default plugin;
