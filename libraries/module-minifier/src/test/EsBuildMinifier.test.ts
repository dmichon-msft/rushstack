// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { IMinifierConnection, IModuleMinificationResult } from '../types';

let esbuildVersion: string = '1.0.0';
jest.mock('esbuild/package.json', () => {
  return {
    get version(): string {
      return esbuildVersion;
    }
  };
});

describe('EsBuildMinifier', () => {
  it('Includes transformOptions in config hash', async () => {
    const { EsBuildMinifier } = await import('../EsBuildMinifier');
    type EsBuildMinifier = typeof EsBuildMinifier.prototype;

    const minifier1: EsBuildMinifier = new EsBuildMinifier({
      transformOptions: {
        minify: true,
        sourcemap: 'external',
        target: 'es5',
        treeShaking: true
      }
    });
    const minifier2: EsBuildMinifier = new EsBuildMinifier({
      transformOptions: {
        minify: false,
        sourcemap: 'external',
        target: 'es2015',
        treeShaking: true
      }
    });

    const connection1: IMinifierConnection = await minifier1.connect();
    await connection1.disconnect();
    const connection2: IMinifierConnection = await minifier2.connect();
    await connection2.disconnect();

    expect(connection1.configHash).toMatchSnapshot('ecma5');
    expect(connection2.configHash).toMatchSnapshot('ecma2015');
    expect(connection1.configHash !== connection2.configHash);
  });

  it('Includes esbuild package version in config hash', async () => {
    const { EsBuildMinifier } = await import('../EsBuildMinifier');
    type EsBuildMinifier = typeof EsBuildMinifier.prototype;

    esbuildVersion = '0.1.2';
    const minifier1: EsBuildMinifier = new EsBuildMinifier({});
    esbuildVersion = '3.4.5';
    const minifier2: EsBuildMinifier = new EsBuildMinifier({});

    const connection1: IMinifierConnection = await minifier1.connect();
    await connection1.disconnect();
    const connection2: IMinifierConnection = await minifier2.connect();
    await connection2.disconnect();

    expect(connection1.configHash).toMatchSnapshot('esbuild-0.1.2');
    expect(connection2.configHash).toMatchSnapshot('esbuild-3.4.5');
    expect(connection1.configHash !== connection2.configHash);
  });

  it('Can remove dead code without mangling', async () => {
    const { EsBuildMinifier } = await import('../EsBuildMinifier');
    type EsBuildMinifier = typeof EsBuildMinifier.prototype;

    const minifier1: EsBuildMinifier = new EsBuildMinifier({
      transformOptions: {
        minify: false,
        sourcemap: 'external',
        target: 'es2020',
        treeShaking: true
      }
    });

    const connection1: IMinifierConnection = await minifier1.connect();
    const hash: string = '1234';
    const code: string = `__MINIFY_MODULE__(function (module, __webpack_exports__, __webpack_require__) {\n// Comment\nlet x;\n// Another comment\n\nconst y = 1;\nconsole.log(y);\n});`;
    const result: IModuleMinificationResult = await new Promise(
      (resolve: (value: IModuleMinificationResult) => void) => {
        minifier1.minify(
          {
            code,
            hash,
            nameForMap: 'test.js',
            externals: []
          },
          resolve
        );
      }
    );
    await connection1.disconnect();

    expect(result).toBeDefined();
    if (result.error) {
      throw result.error;
    }
    expect(result.code).toMatchSnapshot('code');
  });
});
