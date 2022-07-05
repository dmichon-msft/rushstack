import type { IProjectOptions, ITranspileAsyncFunction } from './types';

const projectOptions: IProjectOptions = {
  buildFolder: process.cwd()
};

async function loadTranspiler(): Promise<ITranspileAsyncFunction> {
  switch (process.argv[2]) {
    case 'swc':
      return (await import('./SWCTranspilePlugin')).transpileProjectAsync;
    case 'esbuild':
      return (await import('./ESBuildTranspilePlugin')).transpileProjectAsync;
    case 'typescript':
      return (await import('./TypescriptTranspilePlugin')).transpileProjectAsync;
    default:
      throw new Error(`Unknown transpiler: ${process.argv[2]}`);
  }
}

process.exitCode = 1;
loadTranspiler()
  .then((transpileProjectAsync) => transpileProjectAsync(projectOptions, {}))
  .then(
    () => {
      process.exitCode = 0;
      console.log('Done', process.uptime());
    },
    (err: Error) => {
      console.error(err);
    }
  );
