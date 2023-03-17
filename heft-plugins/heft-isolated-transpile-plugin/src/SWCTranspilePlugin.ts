import fs from 'fs';
import { basename, resolve } from 'path';
import { performance } from 'perf_hooks';

import { Config, JscTarget, ModuleConfig, Output, Options, ParserConfig } from '@swc/core';
import { parseFile, transform } from '@swc/core/binding';
import * as ts from 'typescript';

import { Async } from '@rushstack/node-core-library/lib/Async';

import type { IHeftPlugin, HeftSession, HeftConfiguration } from '@rushstack/heft';
import type { ICommonTranspileOptions, IProjectOptions } from './types';
import { loadTsconfig, TExtendedTypeScript } from './readTsConfig';
import { Queue } from './Queue';
import { PathTree } from './PathTree';

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
  [ts.ModuleKind.Node16]: 'nodenext',
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

interface ITransformItem {
  srcFilePath: string;
  relativeSrcFilePath: string;
  serializedOptionsBuffer: Buffer;
  jsFilePath: string;
  mapFilePath: string | undefined;
}

interface ISourceMap {
  version: 3;
  sources: string[];
  sourcesContent?: string[];
  sourceRoot?: string;
  names: string[];
  mappings: string;
}

interface IEmitKind {
  moduleKind: ts.ModuleKind;
  scriptTarget: ts.ScriptTarget;
}

export async function transpileProjectAsync(
  projectOptions: IProjectOptions,
  pluginOptions: ICommonTranspileOptions
): Promise<void> {
  const buildFolder: string = projectOptions.buildFolder.replace(/\\/g, '/');

  console.log(`Initialized`, process.uptime());

  const tsconfig: ts.ParsedCommandLine = loadTsconfig(
    ts as TExtendedTypeScript,
    projectOptions,
    pluginOptions
  );
  const {
    fileNames: filesFromTsConfig,
    options: {
      module,
      outDir = resolve(buildFolder, 'lib').replace(/\\/g, '/'),
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

  const sourceFilePaths: string[] = filesFromTsConfig.filter((filePath) => !filePath.endsWith('.d.ts'));

  console.log(`Read Config`, process.uptime());

  const srcDir: string = resolve(buildFolder, 'src').replace(/\\/g, '/');

  const outputs: PathTree<ITransformItem> = new PathTree();

  const sourceMaps: Config['sourceMaps'] = inlineSourceMap ? 'inline' : sourceMap;
  const externalSourceMaps: boolean = sourceMaps === true;

  function getOptionsBuffer({ moduleKind, scriptTarget }: IEmitKind): Buffer {
    const format: ModuleConfig['type'] | undefined =
      moduleKind !== undefined ? moduleMap[moduleKind] : moduleKind;
    if (format === undefined) {
      throw new Error(`Unsupported Module Kind: ${moduleKind && ts.ModuleKind[moduleKind]} for swc`);
    }

    const target: JscTarget | undefined = scriptTarget !== undefined ? targetMap[scriptTarget] : scriptTarget;
    if (target === undefined) {
      throw new Error(`Unsupported Target: ${target && ts.ScriptTarget[target]} for swc`);
    }

    const moduleConfig: ModuleConfig = {
      type: format,
      noInterop: tsconfig.options.esModuleInterop === false
    };

    const options: Options = {
      cwd: buildFolder,
      root: srcDir,
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
        parser: undefined,
        transform: {
          react: {},
          useDefineForClassFields
        }
      }
    };

    const optionsBuffer: Buffer = Buffer.from(JSON.stringify(options));

    return optionsBuffer;
  }

  const rootPrefixLength: number = `${srcDir}/`.length;

  const moduleKindsToEmit: [string, IEmitKind][] = [
    [outDir.slice(buildFolder.length), { moduleKind: module!, scriptTarget: rawTarget! }],
    [`/lib-commonjs`, { moduleKind: ts.ModuleKind.CommonJS, scriptTarget: rawTarget! }],
    [`/lib-amd`, { moduleKind: ts.ModuleKind.AMD, scriptTarget: ts.ScriptTarget.ES5 }]
  ];

  const outputOptions: Map<string, Buffer> = new Map(
    moduleKindsToEmit.map(([outPrefix, emitKind]) => {
      return [outPrefix, getOptionsBuffer(emitKind)];
    })
  );

  const transformTimes: [string, number][] = [];

  const writeQueue: Queue<[string, Buffer]> = new Queue();

  for (const srcFilePath of sourceFilePaths) {
    const relativeSrcFilePath: string = srcFilePath.slice(rootPrefixLength);
    const extensionIndex: number = relativeSrcFilePath.lastIndexOf('.');

    const relativeJsFilePath: string = `${relativeSrcFilePath.slice(0, extensionIndex)}.js`;
    for (const [outputPrefix, serializedOptionsBuffer] of outputOptions) {
      const jsFilePath: string = `${outputPrefix}/${relativeJsFilePath}`;
      const mapFilePath: string | undefined = externalSourceMaps ? `${jsFilePath}.map` : undefined;

      const item: ITransformItem = {
        srcFilePath,
        relativeSrcFilePath,
        serializedOptionsBuffer,
        jsFilePath,
        mapFilePath
      };

      outputs.setItem(jsFilePath, item);
    }
  }

  const errors: [string, Error][] = [];

  const nonTsxParserOptions: ParserConfig = {
    syntax: 'typescript',
    decorators: experimentalDecorators,
    dynamicImport: true,
    tsx: false
  };
  const tsxParserOptions: ParserConfig = {
    ...nonTsxParserOptions,
    tsx: true
  };

  const serializedNonTsxParserOptions: Buffer = Buffer.from(JSON.stringify(nonTsxParserOptions));
  const serializedTsxParserOptions: Buffer = Buffer.from(JSON.stringify(tsxParserOptions));

  const serializedASTByFilePath: Map<string, string> = new Map();
  const parseTimes: [string, number][] = [];

  console.log(`Cleaning Outputs`, process.uptime());

  await Async.forEachAsync(moduleKindsToEmit, async ([outPrefix]: [string, IEmitKind]) => {
    const dirToClean: string = `${buildFolder}${outPrefix}`;
    console.log(`Cleaning '${dirToClean}'`);
    await (fs as any).promises.rm(dirToClean, { force: true, recursive: true });
  });

  console.log(`Starting Parse`, process.uptime());

  const parsePromise: Promise<void> = Async.forEachAsync(
    sourceFilePaths,
    async (srcFilePath: string) => {
      const tsx: boolean = srcFilePath.charCodeAt(srcFilePath.length - 1) === 120;
      const serializedParserOptions: Buffer = tsx
        ? serializedTsxParserOptions
        : serializedNonTsxParserOptions;

      const start: number = performance.now();
      try {
        const jsonAST: string = await parseFile(srcFilePath, serializedParserOptions);
        serializedASTByFilePath.set(srcFilePath, jsonAST);
      } catch (error) {
        errors.push([srcFilePath, error as Error]);
        return;
      } finally {
        const end: number = performance.now();
        parseTimes.push([srcFilePath, end - start]);
      }
    },
    {
      concurrency: 4
    }
  );

  const createDirsPromise: Promise<void> = Async.forEachAsync(
    outputs.iterateParentNodes(),
    async (dirname: string): Promise<void> => {
      await fs.promises.mkdir(`${buildFolder}${dirname}`, { recursive: true });
    },
    {
      concurrency: 20
    }
  );

  await Promise.all([parsePromise, createDirsPromise]);

  printTiming(parseTimes, 'Parsed');

  console.log(`Starting Transpile`, process.uptime());

  const writePromise: Promise<void> = Async.forEachAsync(
    writeQueue,
    async ([fileName, content]: [string, Buffer]): Promise<void> => {
      await fs.promises.writeFile(fileName, content);
    },
    {
      concurrency: 20
    }
  );

  await Async.forEachAsync(
    outputs.iterateLeafNodes(),
    async (entry: [string, ITransformItem]) => {
      const { srcFilePath, relativeSrcFilePath, serializedOptionsBuffer, jsFilePath, mapFilePath } = entry[1];

      const jsonAST: string | undefined = serializedASTByFilePath.get(srcFilePath);
      if (!jsonAST) {
        errors.push([jsFilePath, new Error(`Missing AST for '${srcFilePath}'`)]);
        return;
      }

      let result: Output | undefined;

      const start: number = performance.now();
      try {
        result = await transform(jsonAST, true, serializedOptionsBuffer);
      } catch (error) {
        errors.push([jsFilePath, error as Error]);
        return;
      } finally {
        const end: number = performance.now();
        transformTimes.push([jsFilePath, end - start]);
      }

      if (result) {
        let { code, map } = result;

        if (mapFilePath && map) {
          code += `\n//#sourceMappingUrl=./${basename(mapFilePath)}`;
          const parsedMap: ISourceMap = JSON.parse(map);
          parsedMap.sources[0] = relativeSrcFilePath;
          map = JSON.stringify(parsedMap);
          writeQueue.push([`${buildFolder}${mapFilePath}`, Buffer.from(map)]);
        }

        writeQueue.push([`${buildFolder}${jsFilePath}`, Buffer.from(code)]);
      }
    },
    {
      concurrency: 4
    }
  ).then(
    () => writeQueue.finish(),
    (error) => {
      writeQueue.finish();
      throw error;
    }
  );

  printTiming(transformTimes, 'Transformed');

  await writePromise;

  console.log(`Emitted.`, process.uptime());

  const sortedErrors: [string, Error][] = errors.sort((x, y): number => {
    const xPath: string = x[0];
    const yPath: string = y[0];
    return xPath > yPath ? 1 : xPath < yPath ? -1 : 0;
  });
  for (const [, error] of sortedErrors) {
    console.error(error.toString());
  }

  function printTiming(times: [string, number][], descriptor: string): void {
    times.sort((x, y): number => {
      return y[1] - x[1];
    });
    console.log(`${descriptor} ${times.length} files at `, process.uptime());
    console.log(`Slowest files:`);
    for (let i: number = 0, len: number = Math.min(times.length, 10); i < len; i++) {
      const [fileName, time] = times[i];
      console.log(`- ${fileName}: ${time.toFixed(2)}ms`);
    }
    const medianIndex: number = times.length >> 1;
    const [medianFileName, medianTime] = times[medianIndex];
    console.log(`Median (${medianFileName}): ${medianTime.toFixed(2)}ms`);
  }
}

export default plugin;
