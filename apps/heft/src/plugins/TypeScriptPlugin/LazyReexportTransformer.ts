// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as TTypeScript from 'typescript';

function processFile(
  ctx: TTypeScript.TransformationContext,
  sf: TTypeScript.SourceFile,
  ts: typeof TTypeScript
): TTypeScript.SourceFile {
  const exportVisitor: TTypeScript.Visitor = (node: TTypeScript.Node) => {
    if (!ts.isExportDeclaration(node)) {
      return undefined;
    }

    const { isTypeOnly, exportClause, moduleSpecifier } = node;

    if (isTypeOnly || !moduleSpecifier) {
      return undefined;
    }
  };

  return ts.visitEachChild(sf, exportVisitor, ctx);
}

export function transform(ts: typeof TTypeScript): TTypeScript.TransformerFactory<TTypeScript.SourceFile> {
  return (ctx: TTypeScript.TransformationContext) => {
    return (sf: TTypeScript.SourceFile) => processFile(ctx, sf, ts);
  };
}
