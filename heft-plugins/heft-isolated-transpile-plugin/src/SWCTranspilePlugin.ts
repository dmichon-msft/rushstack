import { resolve } from 'path';

import { Config, JscTarget, ModuleConfig, Output, transformFile, Options } from '@swc/core';
import * as ts from 'typescript';

import { Async } from '@rushstack/node-core-library/lib/Async';
import { FileSystem } from '@rushstack/node-core-library/lib/FileSystem';

import type { IHeftPlugin, HeftSession, HeftConfiguration } from '@rushstack/heft';
import type { ICommonTranspileOptions, IProjectOptions } from './types';
import { loadTsconfig, TExtendedTypeScript } from './readTsConfig';

const pluginName: 'SWCTranspilePlugin' = 'SWCTranspilePlugin';

const plugin: IHeftPlugin<ICommonTranspileOptions> = {
  pluginName,

  apply(session: HeftSession, configuration: HeftConfiguration, options: ICommonTranspileOptions = {}): void {
    // Nothing
  }
};

const moduleMap: Record<ts.ModuleKind, ModuleConfig['type'] | undefined> = {
  [ts.ModuleKind.CommonJS]: 'commonjs',
  [ts.ModuleKind.ES2015]: 'es6',
  [ts.ModuleKind.ES2020]: 'es6',
  [ts.ModuleKind.ES2022]: 'es6',
  [ts.ModuleKind.ESNext]: 'es6',
  [ts.ModuleKind.Node12]: 'nodenext',
  [ts.ModuleKind.NodeNext]: 'nodenext',

  [ts.ModuleKind.AMD]: 'amd',
  [ts.ModuleKind.None]: undefined,
  [ts.ModuleKind.UMD]: 'umd',
  [ts.ModuleKind.System]: undefined
};

const targetMap: Record<ts.ScriptTarget, JscTarget | undefined> = {
  [ts.ScriptTarget.ES2015]: 'es2015',
  [ts.ScriptTarget.ES2016]: 'es2016',
  [ts.ScriptTarget.ES2017]: 'es2017',
  [ts.ScriptTarget.ES2018]: 'es2018',
  [ts.ScriptTarget.ES2019]: 'es2019',
  [ts.ScriptTarget.ES2020]: 'es2020',
  [ts.ScriptTarget.ES2021]: 'es2021',
  [ts.ScriptTarget.ES2022]: 'es2022',
  [ts.ScriptTarget.ESNext]: 'es2022',

  [ts.ScriptTarget.ES5]: 'es5',
  [ts.ScriptTarget.ES3]: 'es3',
  [ts.ScriptTarget.JSON]: undefined,
  [ts.ScriptTarget.Latest]: 'es2022'
};

export async function transpileProjectAsync(
  projectOptions: IProjectOptions,
  pluginOptions: ICommonTranspileOptions
): Promise<void> {
  const { buildFolder } = projectOptions;

  console.log(`Initialized`, process.uptime());

  const tsconfig: ts.ParsedCommandLine = loadTsconfig(
    ts as TExtendedTypeScript,
    projectOptions,
    pluginOptions
  );
  const {
    fileNames,
    options: {
      module,
      outDir,
      sourceMap,
      sourceRoot,
      experimentalDecorators,
      target: rawTarget,
      inlineSourceMap,
      inlineSources,
      useDefineForClassFields
    }
  } = tsconfig;

  tsconfig.options.declaration = false;
  tsconfig.options.emitDeclarationOnly = false;

  console.log(`Read Config`, process.uptime());

  const outdir: string = outDir ?? resolve(buildFolder, 'lib');

  FileSystem.ensureEmptyFolder(outdir);

  const format: ModuleConfig['type'] | undefined = module !== undefined ? moduleMap[module] : module;
  if (format === undefined) {
    throw new Error(`Unsupported Module Kind: ${module && ts.ModuleKind[module]} for swc`);
  }

  const target: JscTarget | undefined = rawTarget !== undefined ? targetMap[rawTarget] : rawTarget;
  if (target === undefined) {
    throw new Error(`Unsupported Target: ${target && ts.ScriptTarget[target]} for swc`);
  }

  const root: string = resolve(buildFolder, 'src');

  const sourceMaps: Config['sourceMaps'] = inlineSourceMap ? 'inline' : sourceMap;

  const moduleConfig: ModuleConfig = {
    type: format
  };

  console.log(`Starting Transpile`, process.uptime());

  const errors: [string, Error][] = [];

  await Async.forEachAsync(
    fileNames,
    async (fileName: string) => {
      if (fileName.endsWith('.d.ts')) {
        return;
      }

      const outputFileNames: readonly string[] = ts.getOutputFileNames(tsconfig, fileName, false);

      let jsFileName: string | undefined;
      let mapName: string | undefined;
      for (const outputName of outputFileNames) {
        if (outputName.endsWith('js')) {
          jsFileName = outputName;
        } else if (outputName.endsWith('js.map')) {
          mapName = outputName;
        }
      }

      if (!jsFileName) {
        throw new Error(`Could not determine output JS file name for '${fileName}'`);
      }
      if (sourceMap && !mapName) {
        throw new Error(`Could not determine output map file name for '${fileName}'`);
      }

      const options: Options = {
        cwd: buildFolder,
        filename: fileName,
        root,
        rootMode: 'root',
        configFile: false,
        swcrc: false,
        minify: false,

        inputSourceMap: false,
        sourceRoot,
        isModule: true,

        sourceMaps,
        inlineSourcesContent: inlineSources,

        module: moduleConfig,
        jsc: {
          target,
          externalHelpers: true,
          parser: {
            syntax: 'typescript',
            decorators: experimentalDecorators,
            dynamicImport: true,
            tsx: fileName.endsWith('x')
          },
          transform: {
            react: {},
            useDefineForClassFields
          }
        }
      };

      let result: Output | undefined;

      try {
        result = await transformFile(fileName, options);
      } catch (error) {
        errors.push([fileName, error as Error]);
        return;
      }

      if (result) {
        const promises: Promise<void>[] = [];
        promises.push(
          FileSystem.writeFileAsync(jsFileName, result.code, {
            ensureFolderExists: true
          })
        );
        if (mapName && result.map) {
          promises.push(
            FileSystem.writeFileAsync(mapName, result.map, {
              ensureFolderExists: true
            })
          );
        }

        await Promise.all(promises);
      }
    },
    {
      concurrency: 8
    }
  );

  const sortedErrors: [string, Error][] = errors.sort((x, y): number => {
    const xPath: string = x[0];
    const yPath: string = y[0];
    return xPath > yPath ? 1 : xPath < yPath ? -1 : 0;
  });
  for (const [, error] of sortedErrors) {
    process.stderr.write(error.toString());
  }
}

export default plugin;
