export interface ICommonTranspileOptions {
  /**
   * Project-relative output folder
   * @default 'lib'
   */
  outDir?: string;
  /**
   * Path to the project tsconfig.json.
   * @default './tsconfig.json'
   */
  tsConfigPath?: string;
}

export interface IProjectOptions {
  buildFolder: string;
}

export interface ITranspileAsyncFunction {
  (projectOptions: IProjectOptions, transpileOptions: ICommonTranspileOptions): Promise<void>;
}
