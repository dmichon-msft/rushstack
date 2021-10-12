// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

// The PosixModeBits are intended to be used with bitwise operations.
/* eslint-disable no-bitwise */

/**
 * An integer value used to specify file permissions for POSIX-like operating systems.
 *
 * @remarks
 *
 * This bitfield corresponds to the "mode_t" structure described in this document:
 * http://pubs.opengroup.org/onlinepubs/9699919799/basedefs/sys_stat.h.html
 *
 * It is used with NodeJS APIs such as fs.Stat.mode and fs.chmodSync().  These values
 * represent a set of permissions and can be combined using bitwise arithmetic.
 *
 * POSIX is a registered trademark of the Institute of Electrical and Electronic Engineers, Inc.
 *
 * @public
 */
// eslint-disable-next-line @typescript-eslint/typedef
export const PosixModeBits = {
  // The bits

  /**
   * Indicates that the item's owner can read the item.
   */
  UserRead: 0o400,

  /**
   * Indicates that the item's owner can modify the item.
   */
  UserWrite: 0o200,

  /**
   * Indicates that the item's owner can execute the item (if it is a file)
   * or search the item (if it is a directory).
   */
  UserExecute: 0o100,

  /**
   * Indicates that users belonging to the item's group can read the item.
   */
  GroupRead: 0o040,

  /**
   * Indicates that users belonging to the item's group can modify the item.
   */
  GroupWrite: 0o020,

  /**
   * Indicates that users belonging to the item's group can execute the item (if it is a file)
   * or search the item (if it is a directory).
   */
  GroupExecute: 0o010,

  /**
   * Indicates that other users (besides the item's owner user or group) can read the item.
   */
  OthersRead: 0o004,

  /**
   * Indicates that other users (besides the item's owner user or group) can modify the item.
   */
  OthersWrite: 0o002,

  /**
   * Indicates that other users (besides the item's owner user or group) can execute the item (if it is a file)
   * or search the item (if it is a directory).
   */
  OthersExecute: 0o001,

  // Helpful aliases

  /**
   * A zero value where no permissions bits are set.
   */
  None: 0,

  /**
   * An alias combining OthersRead, GroupRead, and UserRead permission bits.
   */
  AllRead: 0o444,

  /**
   * An alias combining OthersWrite, GroupWrite, and UserWrite permission bits.
   */
  AllWrite: 0o222,

  /**
   * An alias combining OthersExecute, GroupExecute, and UserExecute permission bits.
   */
  AllExecute: 0o111
} as const;
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace PosixModeBits {
  /**
   * Indicates that the item's owner can read the item.
   */
  export type UserRead = typeof PosixModeBits.UserRead;

  /**
   * Indicates that the item's owner can modify the item.
   */
  export type UserWrite = typeof PosixModeBits.UserWrite;

  /**
   * Indicates that the item's owner can execute the item (if it is a file)
   * or search the item (if it is a directory).
   */
  export type UserExecute = typeof PosixModeBits.UserExecute;

  /**
   * Indicates that users belonging to the item's group can read the item.
   */
  export type GroupRead = typeof PosixModeBits.GroupRead;

  /**
   * Indicates that users belonging to the item's group can modify the item.
   */
  export type GroupWrite = typeof PosixModeBits.GroupWrite;

  /**
   * Indicates that users belonging to the item's group can execute the item (if it is a file)
   * or search the item (if it is a directory).
   */
  export type GroupExecute = typeof PosixModeBits.GroupExecute;

  /**
   * Indicates that other users (besides the item's owner user or group) can read the item.
   */
  export type OthersRead = typeof PosixModeBits.OthersRead;

  /**
   * Indicates that other users (besides the item's owner user or group) can modify the item.
   */
  export type OthersWrite = typeof PosixModeBits.OthersWrite;

  /**
   * Indicates that other users (besides the item's owner user or group) can execute the item (if it is a file)
   * or search the item (if it is a directory).
   */
  export type OthersExecute = typeof PosixModeBits.OthersExecute;

  // Helpful aliases

  /**
   * A zero value where no permissions bits are set.
   */
  export type None = typeof PosixModeBits.None;

  /**
   * An alias combining OthersRead, GroupRead, and UserRead permission bits.
   */
  export type AllRead = typeof PosixModeBits.AllRead;

  /**
   * An alias combining OthersWrite, GroupWrite, and UserWrite permission bits.
   */
  export type AllWrite = typeof PosixModeBits.AllWrite;

  /**
   * An alias combining OthersExecute, GroupExecute, and UserExecute permission bits.
   */
  export type AllExecute = typeof PosixModeBits.AllExecute;
}
// TypeScript doesn't allow specifying that a numeric value is scoped to 0o000-0o777, so `number`
export type PosixModeBits = number;
