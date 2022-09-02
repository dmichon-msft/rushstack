// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

// The "rush install" or "rush update" commands will copy this template to
// "common/temp/<pnpmfile.js|.pnpmfile.cjs>" so that it can implement Rush-specific features such as
// implicitly preferred versions. It reads its input data from "common/temp/pnpmfileSettings.json",
// which includes the path to the user's pnpmfile for the currently selected variant. The pnpmfile is
// required directly by this shim and is called after Rush's transformations are applied.

// This file can use "import type" but otherwise should not reference any other modules, since it will
// be run from the "common/temp" directory
import type * as TSemver from 'semver';
import type { IPackageJson } from '@rushstack/node-core-library';

import type { IPnpmShrinkwrapYaml } from './PnpmShrinkwrapFile';
import type { IPnpmfile, IPnpmfileShimSettings, IPnpmfileContext, IInstallableVersion } from './IPnpmfile';

let settings: IPnpmfileShimSettings;
let allPreferredVersions: Map<string, string>;
let allowedAlternativeVersions: Map<string, Set<string>> | undefined;
let allInstallableVersions: Map<string, ReadonlyArray<string>>;
let userPnpmfile: IPnpmfile | undefined;
let semver: typeof TSemver | undefined;

// Initialize all external aspects of the pnpmfile shim. When using the shim, settings
// are always expected to be available. Init must be called before running any hook that
// depends on a resource obtained from or related to the settings, and will require modules
// once so they aren't repeatedly required in the hook functions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function init(context: IPnpmfileContext | any): IPnpmfileContext {
  // Sometimes PNPM may provide us a context arg that doesn't fit spec, ex.:
  // https://github.com/pnpm/pnpm/blob/97c64bae4d14a8c8f05803f1d94075ee29c2df2f/packages/get-context/src/index.ts#L134
  // So we need to normalize the context format before we move on
  if (typeof context !== 'object' || Array.isArray(context)) {
    context = {
      log: (message: string) => {},
      originalContext: context
    } as IPnpmfileContext;
  }

  if (!settings) {
    // Initialize the settings from file
    if (!context.pnpmfileShimSettings) {
      context.pnpmfileShimSettings = require('./pnpmfileSettings.json');
    }
    settings = context.pnpmfileShimSettings!;
  } else if (!context.pnpmfileShimSettings) {
    // Reuse the already initialized settings
    context.pnpmfileShimSettings = settings;
  }

  if (!allPreferredVersions && settings.allPreferredVersions) {
    allPreferredVersions = new Map(Object.entries(settings.allPreferredVersions));
  }

  if (!allowedAlternativeVersions && settings.allowedAlternativeVersions) {
    allowedAlternativeVersions = new Map(
      Object.entries(settings.allowedAlternativeVersions).map(([packageName, versions]) => {
        return [packageName, new Set(versions)];
      })
    );
  }

  if (!allInstallableVersions) {
    allInstallableVersions = new Map(
      settings.allInstallableVersions ? Object.entries(settings.allInstallableVersions) : []
    );
  }

  // If a userPnpmfilePath is provided, we expect it to exist
  if (!userPnpmfile && settings.userPnpmfilePath) {
    userPnpmfile = require(settings.userPnpmfilePath);
  }
  // If a semverPath is provided, we expect it to exist
  if (!semver && settings.semverPath) {
    semver = require(settings.semverPath);
  }
  // Return the normalized context
  return context as IPnpmfileContext;
}

/**
 * Set the preferred versions on the dependency map. For each dependency:
 * 1) Check to see if it is defined in allInstallableVersions.
 *    a) If it is, then take the first compatible version, or error if no version matches.
 *    b) If it is not, then if the version is a defined allowedAlternativeVersion, pass through, or constrain to preferredVersion if compatible
 */
function setPreferredVersions(dependencies: { [dependencyName: string]: string } | undefined): void {
  if (!dependencies) {
    return;
  }

  for (const [name, version] of Object.entries(dependencies)) {
    const installableVersions: ReadonlyArray<string> | undefined = allInstallableVersions.get(name);
    if (installableVersions) {
      if (!checkAndSetInstallableVersion(dependencies, name, version, installableVersions)) {
        throw new Error(
          `Unable to satisfy request for dependency '${name}@${version}'. This repository only allows installation of the following versions of '${name}': ${installableVersions.join(
            ', '
          )}`
        );
      }
    } else {
      const preferredVersion: string | undefined = allPreferredVersions?.get(name);
      if (preferredVersion && !allowedAlternativeVersions?.get(name)?.has(version)) {
        const preferredVersionRange: TSemver.Range | undefined = tryParseRange(preferredVersion);
        const versionRange: TSemver.Range | undefined = tryParseRange(version);

        if (
          preferredVersionRange &&
          versionRange &&
          semver!.subset(preferredVersionRange, versionRange, { includePrerelease: true })
        ) {
          dependencies![name] = preferredVersion;
        }
      }
    }
  }
}

function tryParseSemVer(version: string): TSemver.SemVer | undefined {
  try {
    return new semver!.SemVer(version);
  } catch {
    return;
  }
}

function tryParseRange(version: string): TSemver.Range | undefined {
  try {
    return new semver!.Range(version);
  } catch {
    return;
  }
}

function checkAndSetInstallableVersion(
  dependencies: Record<string, string>,
  name: string,
  version: string,
  installableVersions: ReadonlyArray<IInstallableVersion>
): boolean {
  const versionRange: TSemver.Range | undefined = tryParseRange(version);

  for (const { condition, version } of installableVersions) {
    if (version === version) {
      return true;
    }

    if (versionRange) {
      const rangeCondition: TSemver.Range | undefined = tryParseRange(condition);
      if (!rangeCondition) {
        throw new Error(`Condition '${condition}' for '${name}' is not a valid SemVer Range!`);
      }

      if (rangeCondition && semver!.intersects(rangeCondition, versionRange, { includePrerelease: true })) {
        dependencies[name] = version;
        return true;
      }
    }
  }

  return false;
}

const pnpmfileShim: IPnpmfile = {
  hooks: {
    // Call the original pnpmfile (if it exists)
    afterAllResolved: (lockfile: IPnpmShrinkwrapYaml, context: IPnpmfileContext) => {
      context = init(context);
      return userPnpmfile?.hooks?.afterAllResolved
        ? userPnpmfile.hooks.afterAllResolved(lockfile, context)
        : lockfile;
    },

    // Set the preferred versions in the package, then call the original pnpmfile (if it exists)
    readPackage: (pkg: IPackageJson, context: IPnpmfileContext) => {
      context = init(context);
      setPreferredVersions(pkg.dependencies);
      setPreferredVersions(pkg.devDependencies);
      setPreferredVersions(pkg.optionalDependencies);
      return userPnpmfile?.hooks?.readPackage ? userPnpmfile.hooks.readPackage(pkg, context) : pkg;
    },

    // Call the original pnpmfile (if it exists)
    filterLog: userPnpmfile?.hooks?.filterLog
  }
};

export = pnpmfileShim;
