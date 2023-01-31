// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import { AlreadyExistsBehavior, FileSystem, Async, ITerminal } from '@rushstack/node-core-library';

import { Constants } from '../utilities/Constants';
import { getFilePathsAsync, type IFileSelectionSpecifier } from './FileGlobSpecifier';
import type { HeftConfiguration } from '../configuration/HeftConfiguration';
import type { IHeftTaskPlugin } from '../pluginFramework/IHeftPlugin';
import type { IHeftTaskSession, IHeftTaskFileOperations } from '../pluginFramework/HeftTaskSession';
import { ITrackedFileSystemData, TrackingFileSystemAdapter } from '../utilities/TrackingFileSystemAdapter';

/**
 * Used to specify a selection of files to copy from a specific source folder to one
 * or more destination folders.
 *
 * @public
 */
export interface ICopyOperation extends IFileSelectionSpecifier {
  /**
   * Absolute paths to folders which files or folders should be copied to.
   */
  destinationFolders: string[];

  /**
   * Copy only the file and discard the relative path from the source folder.
   */
  flatten?: boolean;

  /**
   * Hardlink files instead of copying.
   *
   * @remarks
   * If the sourcePath is a folder, the contained directory structure will be re-created
   * and all files will be individually hardlinked. This means that folders will be new
   * filesystem entities and will have separate folder metadata, while the contained files
   * will maintain normal hardlink behavior. This is done since folders do not have a
   * cross-platform equivalent of a hardlink, and since file symlinks provide fundamentally
   * different functionality in comparison to hardlinks.
   */
  hardlink?: boolean;
}

/**
 * Used to specify a selection of files to copy from a specific source folder to one
 * or more destination folders.
 *
 * @public
 */
export interface IIncrementalCopyOperation extends ICopyOperation {
  /**
   * If true, the file will be copied only if the source file is contained in the
   * IHeftTaskRunIncrementalHookOptions.changedFiles map.
   */
  onlyIfChanged?: boolean;
}

interface ICopyFilesPluginOptions {
  copyOperations: ICopyOperation[];
}

interface ICopyDescriptor {
  sourcePath: string;
  destinationPath: string;
  hardlink: boolean;
}

export async function copyFilesAsync(
  copyOperations: Iterable<ICopyOperation>,
  terminal: ITerminal,
  lastTrackedData?: ITrackedFileSystemData | undefined,
  fileTimesFromWatcher?: ReadonlyMap<string, { timestamp: number }>
): Promise<ITrackedFileSystemData> {
  const trackingFileSystem: TrackingFileSystemAdapter = new TrackingFileSystemAdapter();
  const copyDescriptors: Map<string, ICopyDescriptor> = await _getCopyDescriptorsAsync(
    copyOperations,
    trackingFileSystem
  );

  if (lastTrackedData) {
    for (const [destinationPath, { sourcePath }] of copyDescriptors) {
      const normalizedSourcePath: string = path.normalize(sourcePath);
      const oldTime: number | undefined = lastTrackedData.files.get(normalizedSourcePath);
      const newTime: number | undefined = fileTimesFromWatcher?.get(normalizedSourcePath)?.timestamp || 0;
      trackingFileSystem.files.set(normalizedSourcePath, newTime);
      if (newTime && newTime === oldTime) {
        terminal.writeVerboseLine(`Skipping up-to-date "${destinationPath}"`);
        copyDescriptors.delete(destinationPath);
      }
    }
  }

  await _copyFilesInnerAsync(copyDescriptors, terminal);
  return {
    files: trackingFileSystem.files,
    contexts: trackingFileSystem.contexts,
    missing: trackingFileSystem.missing
  };
}

async function _getCopyDescriptorsAsync(
  copyConfigurations: Iterable<ICopyOperation>,
  fs: TrackingFileSystemAdapter | undefined
): Promise<Map<string, ICopyDescriptor>> {
  // Create a map to deduplicate and prevent double-writes
  // resolvedDestinationFilePath -> descriptor
  const destinationCopyDescriptors: Map<string, ICopyDescriptor> = new Map();

  await Async.forEachAsync(
    copyConfigurations,
    async (copyConfiguration: ICopyOperation) => {
      // The source path is required to be a folder
      const sourceFolder: string | undefined = copyConfiguration.sourcePath;
      const sourceFilePaths: Set<string> | undefined = await getFilePathsAsync(copyConfiguration, fs);

      // Dedupe and throw if a double-write is detected
      for (const destinationFolderPath of copyConfiguration.destinationFolders) {
        for (const sourceFilePath of sourceFilePaths!) {
          // Only include the relative path from the sourceFolder if flatten is false
          const resolvedDestinationPath: string = path.resolve(
            destinationFolderPath,
            copyConfiguration.flatten
              ? path.basename(sourceFilePath)
              : path.relative(sourceFolder!, sourceFilePath)
          );

          // Throw if a duplicate copy target with a different source or options is specified
          const existingDestinationCopyDescriptor: ICopyDescriptor | undefined =
            destinationCopyDescriptors.get(resolvedDestinationPath);
          if (existingDestinationCopyDescriptor) {
            if (
              existingDestinationCopyDescriptor.sourcePath === sourceFilePath &&
              existingDestinationCopyDescriptor.hardlink === !!copyConfiguration.hardlink
            ) {
              // Found a duplicate, avoid adding again
              continue;
            }
            throw new Error(
              `Cannot copy multiple files to the same destination "${resolvedDestinationPath}".`
            );
          }

          // Finally, default hardlink to false, add to the result, and add to the map for deduping
          const processedCopyDescriptor: ICopyDescriptor = {
            sourcePath: sourceFilePath,
            destinationPath: resolvedDestinationPath,
            hardlink: !!copyConfiguration.hardlink
          };

          destinationCopyDescriptors.set(resolvedDestinationPath, processedCopyDescriptor);
        }
      }
    },
    { concurrency: Constants.maxParallelism }
  );

  return destinationCopyDescriptors;
}

async function _copyFilesInnerAsync(
  copyDescriptors: Map<string, ICopyDescriptor>,
  terminal: ITerminal
): Promise<void> {
  if (copyDescriptors.size === 0) {
    return;
  }

  let copiedFolderOrFileCount: number = 0;
  let linkedFileCount: number = 0;
  await Async.forEachAsync(
    copyDescriptors.values(),
    async (copyDescriptor: ICopyDescriptor) => {
      if (copyDescriptor.hardlink) {
        linkedFileCount++;
        await FileSystem.createHardLinkAsync({
          linkTargetPath: copyDescriptor.sourcePath,
          newLinkPath: copyDescriptor.destinationPath,
          alreadyExistsBehavior: AlreadyExistsBehavior.Overwrite
        });
        terminal.writeVerboseLine(
          `Linked "${copyDescriptor.sourcePath}" to "${copyDescriptor.destinationPath}".`
        );
      } else {
        copiedFolderOrFileCount++;
        await FileSystem.copyFilesAsync({
          sourcePath: copyDescriptor.sourcePath,
          destinationPath: copyDescriptor.destinationPath,
          alreadyExistsBehavior: AlreadyExistsBehavior.Overwrite
        });
        terminal.writeVerboseLine(
          `Copied "${copyDescriptor.sourcePath}" to "${copyDescriptor.destinationPath}".`
        );
      }
    },
    { concurrency: Constants.maxParallelism }
  );

  const folderOrFilesPlural: string = copiedFolderOrFileCount === 1 ? '' : 's';
  terminal.writeLine(
    `Copied ${copiedFolderOrFileCount} folder${folderOrFilesPlural} or file${folderOrFilesPlural} and ` +
      `linked ${linkedFileCount} file${linkedFileCount === 1 ? '' : 's'}`
  );
}

function* _resolveCopyOperationPaths(
  heftConfiguration: HeftConfiguration,
  copyOperations: Iterable<ICopyOperation>
): IterableIterator<ICopyOperation> {
  function resolvePath(inputPath: string): string {
    return path.resolve(heftConfiguration.buildFolderPath, inputPath);
  }

  for (const copyOperation of copyOperations) {
    yield {
      ...copyOperation,
      sourcePath: resolvePath(copyOperation.sourcePath),
      destinationFolders: copyOperation.destinationFolders.map(resolvePath)
    };
  }
}

const PLUGIN_NAME: 'copy-files-plugin' = 'copy-files-plugin';

export default class CopyFilesPlugin implements IHeftTaskPlugin<ICopyFilesPluginOptions> {
  public apply(
    taskSession: IHeftTaskSession,
    heftConfiguration: HeftConfiguration,
    pluginOptions: ICopyFilesPluginOptions
  ): void {
    taskSession.hooks.registerFileOperations.tap(
      PLUGIN_NAME,
      (operations: IHeftTaskFileOperations): IHeftTaskFileOperations => {
        // TODO: Remove transformation once improved heft-config-file is used to resolve paths
        for (const operation of _resolveCopyOperationPaths(heftConfiguration, pluginOptions.copyOperations)) {
          operations.copyOperations.add(operation);
        }
        return operations;
      }
    );
  }
}
