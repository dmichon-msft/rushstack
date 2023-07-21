// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { createHash } from 'crypto';

import serialize from 'serialize-javascript';
import { transform, type TransformOptions, type TransformResult } from 'esbuild';

import type {
  IMinifierConnection,
  IModuleMinificationCallback,
  IModuleMinificationRequest,
  IModuleMinificationResult,
  IModuleMinifier
} from './types';

/**
 * Options for configuring the EsBuildMinifier
 * @public
 */
export interface IEsBuildMinifierOptions {
  transformOptions?: TransformOptions;
}

/**
 * Minifier implementation that uses esbuild in async mode.
 * @public
 */
export class EsBuildMinifier implements IModuleMinifier {
  private readonly _transformOptions: TransformOptions;

  private readonly _resultCache: Map<string, IModuleMinificationResult>;
  private readonly _configHash: string;

  public constructor(options: IEsBuildMinifierOptions) {
    const { transformOptions = {} } = options || {};

    this._transformOptions = transformOptions;

    const { version: esbuildVersion } = require('esbuild/package.json');

    this._configHash = createHash('sha256')
      .update(EsBuildMinifier.name, 'utf8')
      .update(`esbuild@${esbuildVersion}`)
      .update(serialize(transformOptions))
      .digest('base64');

    this._resultCache = new Map();
  }

  /**
   * Transform that invokes Terser on the main thread
   * @param request - The request to process
   * @param callback - The callback to invoke
   */
  public minify(request: IModuleMinificationRequest, callback: IModuleMinificationCallback): void {
    const { hash } = request;

    const cached: IModuleMinificationResult | undefined = this._resultCache.get(hash);
    if (cached) {
      return callback(cached);
    }

    const options: TransformOptions = {
      ...this._transformOptions,
      sourcefile: request.nameForMap
    };

    transform(request.code, options)
      .then((transformResult: TransformResult) => {
        const result: IModuleMinificationResult = {
          error: undefined,
          code: transformResult.code,
          map: transformResult.map ? JSON.parse(transformResult.map) : undefined,
          hash
        };

        callback(result);
      })
      .catch((error) => {
        callback({
          error: error as Error,
          code: undefined,
          map: undefined,
          hash
        });
      });
  }

  public async connect(): Promise<IMinifierConnection> {
    return {
      configHash: this._configHash,
      disconnect: async () => {
        // Do nothing.
      }
    };
  }
}
