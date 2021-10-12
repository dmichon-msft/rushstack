// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * String constants for common filenames and parts of filenames.
 *
 * @public
 */
// eslint-disable-next-line @typescript-eslint/typedef
export const FileConstants = {
  /**
   * "package.json" - the configuration file that defines an NPM package
   */
  PackageJson: 'package.json'
} as const;
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace FileConstants {
  export type PackageJson = typeof FileConstants.PackageJson;
}
export type FileConstants = typeof FileConstants[keyof typeof FileConstants];

/**
 * String constants for common folder names.
 *
 * @public
 */
// eslint-disable-next-line @typescript-eslint/typedef
export const FolderConstants = {
  /**
   * ".git" - the data storage for a Git working folder
   */
  Git: '.git',

  /**
   * "node_modules" - the folder where package managers install their files
   */
  NodeModules: 'node_modules'
} as const;
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace FolderConstants {
  export type Git = typeof FolderConstants.Git;
  export type NodeModules = typeof FolderConstants.NodeModules;
}
export type FolderConstants = typeof FolderConstants[keyof typeof FolderConstants];
