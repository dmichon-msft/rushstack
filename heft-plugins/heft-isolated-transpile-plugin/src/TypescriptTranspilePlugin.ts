import fs from 'fs';
import { resolve } from 'path';
import { performance } from 'perf_hooks';

import * as ts from 'typescript';

import { Async } from '@rushstack/node-core-library/lib/Async';
import { FileSystem } from '@rushstack/node-core-library/lib/FileSystem';
import type { IHeftPlugin, HeftSession, HeftConfiguration } from '@rushstack/heft';

import type { ICommonTranspileOptions, IProjectOptions } from './types';
import { loadTsconfig, TExtendedTypeScript } from './readTsConfig';
import { PathTree } from './PathTree';
import { Queue } from './Queue';

const pluginName: 'TypescriptTranspilePlugin' = 'TypescriptTranspilePlugin';

const plugin: IHeftPlugin<ICommonTranspileOptions> = {
  pluginName,

  apply(session: HeftSession, configuration: HeftConfiguration, options: ICommonTranspileOptions = {}): void {
    // Nothing
  }
};

interface ITypescriptTranspileOption {
  name: string;
  transpileOptionValue: string;
}

interface IEmitKind {
  moduleKind: ts.ModuleKind;
  scriptTarget: ts.ScriptTarget;
}

declare module 'typescript' {
  export const transpileOptionValueCompilerOptions: ReadonlyArray<ITypescriptTranspileOption>;
  export const notImplementedResolver: unknown;
  export function getNewLineCharacter(options: ts.CompilerOptions): string;
}

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
  const { fileNames: fileNamesFromTsConfig, options: compilerOptions } = tsconfig;

  for (const [option, value] of Object.entries(ts.getDefaultCompilerOptions())) {
    if (compilerOptions[option] === undefined) {
      compilerOptions[option] = value;
    }
  }

  const {
    outDir = resolve(buildFolder, 'lib').replace(/\\/g, '/'),
    module,
    target: rawTarget
  } = compilerOptions;

  for (const option of ts.transpileOptionValueCompilerOptions) {
    compilerOptions[option.name] = option.transpileOptionValue;
  }

  compilerOptions.suppressOutputPathCheck = true;
  compilerOptions.skipDefaultLibCheck = true;
  compilerOptions.preserveValueImports = true;

  const sourceFilePaths: string[] = fileNamesFromTsConfig.filter(
    (fileName: string) => !fileName.endsWith('.d.ts')
  );

  console.log(`Read Config`, process.uptime());

  const srcDir: string = resolve(buildFolder, 'src').replace(/\\/g, '/');

  const outputs: PathTree<boolean> = new PathTree();

  const rootPrefixLength: number = `${srcDir}/`.length;

  const moduleKindsToEmit: [string, IEmitKind][] = [
    [outDir.slice(buildFolder.length), { moduleKind: module!, scriptTarget: rawTarget! }],
    [`/lib-esnext`, { moduleKind: ts.ModuleKind.ESNext, scriptTarget: rawTarget! }],
    [`/lib-commonjs`, { moduleKind: ts.ModuleKind.CommonJS, scriptTarget: rawTarget! }],
    [`/lib-amd`, { moduleKind: ts.ModuleKind.AMD, scriptTarget: rawTarget! }]
  ];

  for (const srcFilePath of sourceFilePaths) {
    const relativeSrcFilePath: string = srcFilePath.slice(rootPrefixLength);
    const extensionIndex: number = relativeSrcFilePath.lastIndexOf('.');

    const relativeJsFilePath: string = `${relativeSrcFilePath.slice(0, extensionIndex)}.js`;
    for (const [outputPrefix, emitKind] of moduleKindsToEmit) {
      const jsFilePath: string = `${outputPrefix}/${relativeJsFilePath}`;

      outputs.setItem(jsFilePath, true);
    }
  }

  console.log(`Cleaning Outputs`, process.uptime());

  await Async.forEachAsync(moduleKindsToEmit, async ([outPrefix]: [string, IEmitKind]): Promise<void> => {
    const dirToClean: string = `${buildFolder}${outPrefix}`;
    console.log(`Cleaning '${dirToClean}'`);
    await (fs as any).promises.rm(dirToClean, { force: true, recursive: true });
  });

  console.log(`Starting Parse`, process.uptime());

  const sourceFileByPath: Map<string, ts.SourceFile> = new Map();
  const parseTimes: [string, number][] = [];

  const createDirsPromise: Promise<void> = Async.forEachAsync(
    outputs.iterateParentNodes(),
    async (dirname: string): Promise<void> => {
      await fs.promises.mkdir(`${buildFolder}${dirname}`, { recursive: true });
    },
    {
      concurrency: 20
    }
  );

  const parsePromise: Promise<void> = Async.forEachAsync(
    sourceFilePaths,
    async (fileName: string) => {
      const sourceText: string = await FileSystem.readFileAsync(fileName);
      const start: number = performance.now();
      const sourceFile: ts.SourceFile = ts.createSourceFile(fileName, sourceText, rawTarget!);
      sourceFile.hasNoDefaultLib = true;
      sourceFileByPath.set(fileName, sourceFile);
      const end: number = performance.now();
      parseTimes.push([fileName, end - start]);
    },
    {
      concurrency: 4
    }
  );

  await Promise.all([parsePromise, createDirsPromise]);

  console.log(`Starting Transpile`, process.uptime());

  const writeQueue: Queue<[string, string]> = new Queue();

  const newLine: string = ts.getNewLineCharacter(compilerOptions);

  const compilerHost: ts.CompilerHost = {
    getSourceFile: (fileName: string) => sourceFileByPath.get(fileName),
    writeFile: (fileName: string, text: string) => {
      writeQueue.push([fileName, text]);
    },
    getDefaultLibFileName: () => 'lib.d.ts',
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (fileName: string) => fileName,
    getCurrentDirectory: () => '',
    getNewLine: () => newLine,
    fileExists: (fileName: string) => sourceFileByPath.has(fileName),
    readFile: () => '',
    directoryExists: () => true,
    getDirectories: () => []
  };

  const program: ts.Program = ts.createProgram(sourceFilePaths, compilerOptions, compilerHost);

  const result: ts.EmitResult = program.emit(undefined, undefined, undefined, undefined, undefined);
  writeQueue.finish();

  console.log(`Writing Outputs`, process.uptime());
  await Async.forEachAsync(
    writeQueue,
    async ([fileName, text]: [string, string]): Promise<void> => {
      await fs.promises.writeFile(fileName, text, { encoding: 'utf8' });
    },
    {
      concurrency: 20
    }
  );

  if (result.diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, compilerHost));
  }
}

export default plugin;
