// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

export function requireExternal<TResult>(moduleName: string): TResult {
  if (typeof __non_webpack_require__ === 'function') {
    // If this library has been bundled with Webpack, we need to call the real `require` function
    // that doesn't get turned into a `__webpack_require__` statement.
    // `__non_webpack_require__` is a Webpack macro that gets turned into a `require` statement
    // during bundling.
    return __non_webpack_require__(moduleName);
  } else {
    return require(moduleName);
  }
}
