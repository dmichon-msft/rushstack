// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * This simple loader wraps the loading of CSS in script equivalent to
 *  require("load-themed-styles").loadStyles('... css text ...').
 * @packageDocumentation
 */

import { loader } from 'webpack';
import loaderUtils = require('loader-utils');

const loadedThemedStylesPath: string = require.resolve('@microsoft/load-themed-styles');

/**
 * Options for the loader.
 *
 * @public
 */
export interface ILoadThemedStylesLoaderOptions {
  /**
   * If this parameter is set to "true," the "loadAsync" parameter is set to true in the call to loadStyles.
   * Defaults to false.
   */
  async?: boolean;

  /**
   * The path to use for loading `@microsoft/load-themed-styles` in generated code.
   */
  loadThemedStylesPath?: string;
}

/**
 * This simple loader wraps the loading of CSS in script equivalent to
 *  require("load-themed-styles").loadStyles('... css text ...').
 *
 * @public
 */
export class LoadThemedStylesLoader {
  private static _loadedThemedStylesPath: string = loadedThemedStylesPath;

  public constructor() {
    throw new Error('Constructing "LoadThemedStylesLoader" is not supported.');
  }

  public static set loadedThemedStylesPath(value: string) {
    LoadThemedStylesLoader._loadedThemedStylesPath = value;
  }

  /**
   * Use this property to override the path to the `@microsoft/load-themed-styles` package.
   * @deprecated
   * Use the `loadThemedStylesPath` option when specifying the loader instead.
   */
  public static get loadedThemedStylesPath(): string {
    return LoadThemedStylesLoader._loadedThemedStylesPath;
  }

  /**
   * Reset the path to the `@microsoft/load-themed-styles package` to the default.
   */
  public static resetLoadedThemedStylesPath(): void {
    LoadThemedStylesLoader._loadedThemedStylesPath = loadedThemedStylesPath;
  }

  public static pitch(this: loader.LoaderContext, remainingRequest: string): string {
    const options: ILoadThemedStylesLoaderOptions = loaderUtils.getOptions(this) || {};
    if ((options as Record<string, unknown>).namedExport) {
      throw new Error('The "namedExport" option has been removed.');
    }

    const { async = false, loadThemedStylesPath } = options;

    const cssPath: string = loaderUtils.stringifyRequest(this, '!!' + remainingRequest);
    const themedStylesPath: string = JSON.stringify(
      loadThemedStylesPath ?? LoadThemedStylesLoader._loadedThemedStylesPath
    );

    switch (this._module?.type) {
      case 'javascript/auto':
      case 'javascript/esm':
        return [
          `import content from ${cssPath};`,
          `import { loadStyles } from ${themedStylesPath};`,
          '',
          'var locals = content.locals || {};',
          'export default locals;',
          'if(typeof content === "string") content = [[0, content]];',
          '// add the styles to the DOM',
          `for (var i = 0; i < content.length; i++) loadStyles(content[i][1], ${async === true});`
        ].join('\n');
      case undefined:
      case 'javascript/dynamic':
        return [
          `var content = require(${cssPath});`,
          `var loader = require(${themedStylesPath});`,
          '',
          'if(typeof content === "string") content = [[0, content]];',
          'else if(content.locals) module.exports = content.locals;',
          '',
          '// add the styles to the DOM',
          `for (var i = 0; i < content.length; i++) loader.loadStyles(content[i][1], ${async === true});`,
          ''
        ].join('\n');
      default:
        this.emitError(new Error(`Unexpected module type ${this._module.type} in loader-load-themed-styles`));
        return '';
    }
  }
}
