// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { Async, FileSystem, InternalError, JsonFile, JsonSchema } from '@rushstack/node-core-library';

import { IChangeInfo } from '../api/ChangeManagement';
import { IChangelog } from '../api/Changelog';
import { RushConfiguration } from '../api/RushConfiguration';
import schemaJson from '../schemas/change-file.schema.json';

/**
 * This class represents the collection of change files existing in the repo and provides operations
 * for those change files.
 */
export class ChangeFiles {
  /**
   * Change file path relative to changes folder.
   */
  private _filesPromise: Promise<string[]> | undefined;
  private _changesPath: string;

  public constructor(changesPath: string) {
    this._changesPath = changesPath;
  }

  /**
   * Validate if the newly added change files match the changed packages.
   */
  public static validate(
    newChangeFilePaths: string[],
    changedPackageNames: Set<string>,
    rushConfiguration: RushConfiguration
  ): void {
    const schema: JsonSchema = JsonSchema.fromLoadedObject(schemaJson);

    const projectsWithChangeDescriptions: Set<string> = new Set<string>();
    for (const filePath of newChangeFilePaths) {
      console.log(`Found change file: ${filePath}`);

      const changeFile: IChangeInfo = JsonFile.loadAndValidate(filePath, schema);
      const changes: IChangeInfo[] | undefined = changeFile?.changes;

      if (rushConfiguration.hotfixChangeEnabled) {
        if (changes) {
          for (const change of changes) {
            if (change.type !== 'none' && change.type !== 'hotfix') {
              throw new Error(
                `Change file ${filePath} specifies a type of '${change.type}' ` +
                  `but only 'hotfix' and 'none' change types may be used in a branch with 'hotfixChangeEnabled'.`
              );
            }
          }
        }
      }

      if (changes) {
        for (const change of changes) {
          projectsWithChangeDescriptions.add(change.packageName);
        }
      } else {
        throw new Error(`Invalid change file: ${filePath}`);
      }
    }

    const projectsMissingChangeDescriptions: Set<string> = new Set(changedPackageNames);
    for (const packageName of projectsWithChangeDescriptions) {
      projectsMissingChangeDescriptions.delete(packageName);
    }

    if (projectsMissingChangeDescriptions.size > 0) {
      const projectsMissingChangeDescriptionsArray: string[] = Array.from(
        projectsMissingChangeDescriptions,
        (projectName) => `- ${projectName}`
      );
      throw new Error(
        [
          'The following projects have been changed and require change descriptions, but change descriptions were not ' +
            'detected for them:',
          ...projectsMissingChangeDescriptionsArray,
          'To resolve this error, run "rush change". This will generate change description files that must be ' +
            'committed to source control.'
        ].join('\n')
      );
    }
  }

  public static getChangeComments(newChangeFilePaths: string[]): Map<string, string[]> {
    const changesByPackage: Map<string, string[]> = new Map<string, string[]>();

    for (const filePath of newChangeFilePaths) {
      console.log(`Found change file: ${filePath}`);
      const { changes }: IChangeInfo = JsonFile.load(filePath);
      if (changes) {
        for (const { packageName, comment } of changes) {
          let changesForPackage: string[] | undefined = changesByPackage.get(packageName);
          if (!changesForPackage) {
            changesForPackage = [];
            changesByPackage.set(packageName, changesForPackage);
          }

          if (comment?.length) {
            changesForPackage.push(comment);
          }
        }
      } else {
        throw new Error(`Invalid change file: ${filePath}`);
      }
    }

    return changesByPackage;
  }

  /**
   * Get the array of absolute paths of change files.
   */
  public async getFilesAsync(): Promise<string[]> {
    if (!this._filesPromise) {
      this._filesPromise = (async () => {
        const { default: glob } = await import('fast-glob');
        return (await glob('**/*.json', { cwd: this._changesPath, absolute: true })) ?? [];
      })();
    }

    return this._filesPromise;
  }

  /**
   * Get the path of changes folder.
   */
  public getChangesPath(): string {
    return this._changesPath;
  }

  /**
   * Delete all change files
   */
  public async deleteAllAsync(shouldDelete: boolean, updatedChangelogs?: IChangelog[]): Promise<number> {
    if (updatedChangelogs) {
      // Skip changes files if the package's change log is not updated.
      const packagesToInclude: Set<string> = new Set();
      for (const changelog of updatedChangelogs) {
        packagesToInclude.add(changelog.name);
      }

      const files: string[] = await this.getFilesAsync();
      const filesToDelete: string[] = [];
      await Async.forEachAsync(
        files,
        async (filePath) => {
          const { changes }: IChangeInfo = await JsonFile.loadAsync(filePath);
          const shouldDelete: boolean = !changes?.some(
            (changeInfo) => !packagesToInclude.has(changeInfo.packageName)
          );

          if (shouldDelete) {
            filesToDelete.push(filePath);
          }
        },
        { concurrency: 5 }
      );

      return await this._deleteFilesAsync(filesToDelete, shouldDelete);
    } else {
      // Delete all change files.
      const files: string[] = await this.getFilesAsync();
      return await this._deleteFilesAsync(files, shouldDelete);
    }
  }

  private async _deleteFilesAsync(files: string[], shouldDelete: boolean): Promise<number> {
    if (files.length) {
      console.log(`\n* ${shouldDelete ? 'DELETING:' : 'DRYRUN: Deleting'} ${files.length} change file(s).`);

      await Async.forEachAsync(
        files,
        async (filePath) => {
          console.log(` - ${filePath}`);
          if (shouldDelete) {
            await FileSystem.deleteFileAsync(filePath);
          }
        },
        { concurrency: 5 }
      );
    }

    return files.length;
  }
}
