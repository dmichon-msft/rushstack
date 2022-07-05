import { resolve } from 'path';

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
    options: { outDir, sourceMap }
  } = tsconfig;

  tsconfig.options.declaration = false;
  tsconfig.options.emitDeclarationOnly = false;
  tsconfig.options.importHelpers = true;
  tsconfig.options.isolatedModules = true;
  tsconfig.options.importsNotUsedAsValues = ts.ImportsNotUsedAsValues.Error;

  console.log(`Read Config`, process.uptime());

  const outdir: string = outDir ?? resolve(buildFolder, 'lib');

  FileSystem.ensureEmptyFolder(outdir);

  console.log(`Starting Transpile`, process.uptime());

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

      const input: string = await FileSystem.readFileAsync(fileName);

      const options: ts.TranspileOptions = {
        compilerOptions: tsconfig.options,
        fileName,
        reportDiagnostics: false
      };

      const result: ts.TranspileOutput = await ts.transpileModule(input, options);

      const promises: Promise<void>[] = [];
      promises.push(
        FileSystem.writeFileAsync(jsFileName, result.outputText, {
          ensureFolderExists: true
        })
      );
      if (mapName && result.sourceMapText) {
        promises.push(
          FileSystem.writeFileAsync(mapName, result.sourceMapText, {
            ensureFolderExists: true
          })
        );
      }

      await Promise.all(promises);
    },
    {
      concurrency: 8
    }
  );
}

export default plugin;
