import type * as webpack from 'webpack';

function noSubprocessLoader(
  this: webpack.LoaderContext<unknown>,
  source: string,
  map: string
): string | undefined {
  const index: number = source.indexOf('.invokeAsSubprocessAsync');
  if (index >= 0) {
    return source.replace(/\.invokeAsSubprocessAsync/g, '.invokeAsync');
  }

  this.async()(undefined, source, map);
}

export default noSubprocessLoader;
