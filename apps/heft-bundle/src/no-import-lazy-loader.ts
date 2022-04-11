import type * as webpack from 'webpack';

const lazyImportRegex: RegExp = /=[^.]+\.Import\.lazy\(([^,]+),\srequire\);/g;

function noSubprocessLoader(
  this: webpack.LoaderContext<unknown>,
  source: string,
  map: string
): string | undefined {
  lazyImportRegex.lastIndex = -1;
  const hasMatch: boolean = lazyImportRegex.test(source);
  if (hasMatch) {
    lazyImportRegex.lastIndex--;
    return source.replace(lazyImportRegex, '=require($1);');
  }

  this.async()(undefined, source, map);
}

export default noSubprocessLoader;
