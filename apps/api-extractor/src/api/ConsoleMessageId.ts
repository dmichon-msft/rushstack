// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * Unique identifiers for console messages reported by API Extractor.
 *
 * @remarks
 *
 * These strings are possible values for the {@link ExtractorMessage.messageId} property
 * when the `ExtractorMessage.category` is {@link ExtractorMessageCategory.Console}.
 *
 * @public
 */
// eslint-disable-next-line @typescript-eslint/typedef
export const ConsoleMessageId = {
  /**
   * "Analysis will use the bundled TypeScript version ___"
   */
  Preamble: 'console-preamble',

  /**
   * "The target project appears to use TypeScript ___ which is newer than the bundled compiler engine;
   * consider upgrading API Extractor."
   */
  CompilerVersionNotice: 'console-compiler-version-notice',

  /**
   * "Using custom TSDoc config from ___"
   */
  UsingCustomTSDocConfig: 'console-using-custom-tsdoc-config',

  /**
   * "Found metadata in ___"
   */
  FoundTSDocMetadata: 'console-found-tsdoc-metadata',

  /**
   * "Writing: ___"
   */
  WritingDocModelFile: 'console-writing-doc-model-file',

  /**
   * "Writing package typings: ___"
   */
  WritingDtsRollup: 'console-writing-dts-rollup',

  /**
   * "You have changed the public API signature for this project.
   * Please copy the file ___ to ___, or perform a local build (which does this automatically).
   * See the Git repo documentation for more info."
   *
   * OR
   *
   * "The API report file is missing.
   * Please copy the file ___ to ___, or perform a local build (which does this automatically).
   * See the Git repo documentation for more info."
   */
  ApiReportNotCopied: 'console-api-report-not-copied',

  /**
   * "You have changed the public API signature for this project.  Updating ___"
   */
  ApiReportCopied: 'console-api-report-copied',

  /**
   * "The API report is up to date: ___"
   */
  ApiReportUnchanged: 'console-api-report-unchanged',

  /**
   * "The API report file was missing, so a new file was created. Please add this file to Git: ___"
   */
  ApiReportCreated: 'console-api-report-created',

  /**
   * "Unable to create the API report file. Please make sure the target folder exists: ___"
   */
  ApiReportFolderMissing: 'console-api-report-folder-missing',

  /**
   * Used for the information printed when the "--diagnostics" flag is enabled.
   */
  Diagnostics: 'console-diagnostics'
} as const;
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace ConsoleMessageId {
  /**
   * "Analysis will use the bundled TypeScript version ___"
   */
  export type Preamble = typeof ConsoleMessageId.Preamble;

  /**
   * "The target project appears to use TypeScript ___ which is newer than the bundled compiler engine;
   * consider upgrading API Extractor."
   */
  export type CompilerVersionNotice = typeof ConsoleMessageId.CompilerVersionNotice;

  /**
   * "Using custom TSDoc config from ___"
   */
  export type UsingCustomTSDocConfig = typeof ConsoleMessageId.UsingCustomTSDocConfig;

  /**
   * "Found metadata in ___"
   */
  export type FoundTSDocMetadata = typeof ConsoleMessageId.FoundTSDocMetadata;

  /**
   * "Writing: ___"
   */
  export type WritingDocModelFile = typeof ConsoleMessageId.WritingDocModelFile;

  /**
   * "Writing package typings: ___"
   */
  export type WritingDtsRollup = typeof ConsoleMessageId.WritingDtsRollup;

  /**
   * "You have changed the public API signature for this project.
   * Please copy the file ___ to ___, or perform a local build (which does this automatically).
   * See the Git repo documentation for more info."
   *
   * OR
   *
   * "The API report file is missing.
   * Please copy the file ___ to ___, or perform a local build (which does this automatically).
   * See the Git repo documentation for more info."
   */
  export type ApiReportNotCopied = typeof ConsoleMessageId.ApiReportNotCopied;

  /**
   * "You have changed the public API signature for this project.  Updating ___"
   */
  export type ApiReportCopied = typeof ConsoleMessageId.ApiReportCopied;

  /**
   * "The API report is up to date: ___"
   */
  export type ApiReportUnchanged = typeof ConsoleMessageId.ApiReportUnchanged;

  /**
   * "The API report file was missing, so a new file was created. Please add this file to Git: ___"
   */
  export type ApiReportCreated = typeof ConsoleMessageId.ApiReportCreated;

  /**
   * "Unable to create the API report file. Please make sure the target folder exists: ___"
   */
  export type ApiReportFolderMissing = typeof ConsoleMessageId.ApiReportFolderMissing;

  /**
   * Used for the information printed when the "--diagnostics" flag is enabled.
   */
  export type Diagnostics = typeof ConsoleMessageId.Diagnostics;
}
export type ConsoleMessageId = typeof ConsoleMessageId[keyof typeof ConsoleMessageId];
