// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { minifySingleFileAsync } from '../MinifySingleFile';

describe(minifySingleFileAsync.name, () => {
  it('uses consistent identifiers for webpack vars', async () => {
    const code: string = `__MINIFY_MODULE__(function (module, __webpack_exports__, __webpack_require__) {});`;

    const minifierResult = await minifySingleFileAsync(
      {
        hash: 'foo',
        code,
        nameForMap: undefined,
        externals: undefined
      },
      {
        mangle: true
      }
    );

    expect(minifierResult).toMatchSnapshot();
  });

  it('allows performing only dead code elimination', async () => {
    const code: string = `__MINIFY_MODULE__(function (module, __webpack_exports__, __webpack_require__) {/* comment */var x;\n/* other comment */var y = 10;\nconsole.log(y);});`;

    const minifierResult = await minifySingleFileAsync(
      {
        hash: 'foo',
        code,
        nameForMap: undefined,
        externals: undefined
      },
      {
        compress: {
          defaults: false,
          dead_code: true,
          unused: true
        },
        format: {
          comments: 'all'
        },
        mangle: false
      }
    );

    expect(minifierResult).toMatchSnapshot();
  });
});
