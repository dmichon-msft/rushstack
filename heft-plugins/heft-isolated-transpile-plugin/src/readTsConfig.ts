import type * as TTypeScript from 'typescript';
import type { ICommonTranspileOptions, IProjectOptions } from './types';

interface ITypeScriptExtensions {
  resolvePath(base: string, segment: string): string;
}

export type TExtendedTypeScript = typeof TTypeScript & ITypeScriptExtensions;

export function loadTsconfig(
  ts: TExtendedTypeScript,
  projectOptions: IProjectOptions,
  pluginOptions: ICommonTranspileOptions
): TTypeScript.ParsedCommandLine {
  const { tsConfigPath = 'tsconfig.json' } = pluginOptions;

  const { buildFolder } = projectOptions;

  const resolvedTsConfigPath: string = ts.resolvePath(buildFolder, tsConfigPath);

  const parsedConfigFile: ReturnType<typeof ts.readConfigFile> = ts.readConfigFile(
    resolvedTsConfigPath,
    ts.sys.readFile
  );

  const currentFolder: string = buildFolder;

  const tsconfig: TTypeScript.ParsedCommandLine = ts.parseJsonConfigFileContent(
    parsedConfigFile.config,
    {
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      useCaseSensitiveFileNames: true
    },
    currentFolder,
    /*existingOptions:*/ undefined,
    resolvedTsConfigPath
  );

  return tsconfig;
}
