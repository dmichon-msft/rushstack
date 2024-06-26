// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { EOL } from 'os';

import { ITypingsGeneratorOptions, TypingsGenerator } from './TypingsGenerator';

/**
 * @public
 */
export interface IStringValueTyping {
  exportName: string;
  comment?: string;
}

/**
 * @public
 */
export interface IStringValueTypings {
  typings: IStringValueTyping[];
}

/**
 * @public
 */
export interface IStringValuesTypingsGeneratorOptions
  extends ITypingsGeneratorOptions<IStringValueTypings | undefined> {
  /**
   * Setting this option wraps the typings export in a default property.
   */
  exportAsDefault?: boolean;

  /**
   * When `exportAsDefault` is true, this optional setting determines the interface name
   * for the default wrapped export. Ignored when `exportAsDefault` is false.
   */
  exportAsDefaultInterfaceName?: string;
}

const EXPORT_AS_DEFAULT_INTERFACE_NAME: string = 'IExport';

/**
 * This is a simple tool that generates .d.ts files for non-TS files that can be represented as
 * a simple set of named string exports.
 *
 * @public
 */
export class StringValuesTypingsGenerator extends TypingsGenerator {
  public constructor(options: IStringValuesTypingsGeneratorOptions) {
    super({
      ...options,
      parseAndGenerateTypings: async (fileContents: string, filePath: string, relativePath: string) => {
        const stringValueTypings: IStringValueTypings | undefined = await options.parseAndGenerateTypings(
          fileContents,
          filePath,
          relativePath
        );

        if (stringValueTypings === undefined) {
          return;
        }

        const outputLines: string[] = [];
        const interfaceName: string = options.exportAsDefaultInterfaceName
          ? options.exportAsDefaultInterfaceName
          : EXPORT_AS_DEFAULT_INTERFACE_NAME;
        let indent: string = '';
        if (options.exportAsDefault) {
          outputLines.push(`export interface ${interfaceName} {`);
          indent = '  ';
        }

        for (const stringValueTyping of stringValueTypings.typings) {
          const { exportName, comment } = stringValueTyping;

          if (comment && comment.trim() !== '') {
            outputLines.push(
              `${indent}/**`,
              `${indent} * ${comment.replace(/\*\//g, '*\\/')}`,
              `${indent} */`
            );
          }

          if (options.exportAsDefault) {
            outputLines.push(`${indent}'${exportName}': string;`, '');
          } else {
            outputLines.push(`export declare const ${exportName}: string;`, '');
          }
        }

        if (options.exportAsDefault) {
          outputLines.push(
            '}',
            '',
            `declare const strings: ${interfaceName};`,
            '',
            'export default strings;'
          );
        }

        return outputLines.join(EOL);
      }
    });
  }
}
