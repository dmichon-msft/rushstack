// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * String constants for command line processing.
 *
 * @public
 */
// eslint-disable-next-line @typescript-eslint/typedef
export const CommandLineConstants = {
  /**
   * The name of the built-in action that serves suggestions for tab-completion
   */
  TabCompletionActionName: 'tab-complete'
} as const;
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace CommandLineConstants {
  /**
   * The name of the built-in action that serves suggestions for tab-completion
   */
  export type TabCompletionActionName = typeof CommandLineConstants.TabCompletionActionName;
}
export type CommandLineConstants = typeof CommandLineConstants[keyof typeof CommandLineConstants];
