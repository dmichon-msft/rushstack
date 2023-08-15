// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { minify, MinifyOptions, MinifyOutput, SimpleIdentifierMangler } from 'terser';
import type { RawSourceMap } from 'source-map';

declare module 'terser' {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  interface SourceMapOptions {
    asObject?: boolean;
  }
}

import { getIdentifier } from './MinifiedIdentifier';
import type {
  IModuleMinificationRequest,
  IModuleMinificationResult,
  IModuleMinificationSuccessResult
} from './types';

const nth_identifier: SimpleIdentifierMangler = {
  get: getIdentifier
};

/**
 * Minifies a single chunk of code. Factored out for reuse between WorkerPoolMinifier and LocalMinifier
 * @internal
 */
export async function minifySingleFileAsync(
  request: IModuleMinificationRequest,
  terserOptions: MinifyOptions,
  useDecodedMap?: boolean
): Promise<IModuleMinificationResult> {
  const { code, nameForMap, hash, externals } = request;

  try {
    const {
      format: rawFormat,
      output: rawOutput,
      mangle: originalMangle,
      ...remainingOptions
    } = terserOptions;

    const format: MinifyOptions['format'] = rawFormat || rawOutput || {};

    const mangle: MinifyOptions['mangle'] =
      originalMangle === false ? false : typeof originalMangle === 'object' ? { ...originalMangle } : {};

    const finalOptions: MinifyOptions = {
      ...remainingOptions,
      format,
      mangle
    };
    format.comments = false;

    if (mangle) {
      mangle.nth_identifier = nth_identifier;
    }

    if (mangle && externals) {
      mangle.reserved = mangle.reserved ? externals.concat(mangle.reserved) : externals;
    }

    finalOptions.sourceMap = nameForMap
      ? {
          asObject: true
        }
      : false;

    const minified: MinifyOutput = await minify(
      {
        [nameForMap || 'code']: code
      },
      finalOptions
    );

    const result: IModuleMinificationSuccessResult = {
      hash,
      error: undefined,
      code: minified.code!,
      decodedMap: useDecodedMap ? minified.decoded_map : undefined,
      map: useDecodedMap ? undefined : minified.map
    };

    return result;
  } catch (error) {
    console.error(error);
    return {
      hash,
      error: error as Error,
      code: undefined,
      decodedMap: undefined,
      map: undefined
    };
  }
}
