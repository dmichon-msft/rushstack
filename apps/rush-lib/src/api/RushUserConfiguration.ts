// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { FileSystem, JsonFile, JsonSchema } from '@rushstack/node-core-library';
import * as path from 'path';

import { Utilities } from '../utilities/Utilities';
import { RushConstants } from '../logic/RushConstants';

interface IRushUserSettingsJson {
  buildCacheFolder?: string;
  pnpmStoreFolder?: string;
}

/**
 * Rush per-user configuration data.
 *
 * @beta
 */
export class RushUserConfiguration {
  private static _schema: JsonSchema = JsonSchema.fromFile(
    path.resolve(__dirname, '..', 'schemas', 'rush-user-settings.schema.json')
  );

  /**
   * If provided, store build cache in the specified folder. Must be an absolute path.
   */
  public readonly buildCacheFolder: string | undefined;

  /**
   * If provided, store the global pnpm sotre in the specified folder. Must be an absolute path.
   */
  public readonly pnpmStoreFolder: string | undefined;

  private constructor(rushUserConfigurationJson: IRushUserSettingsJson | undefined) {
    this.buildCacheFolder = rushUserConfigurationJson?.buildCacheFolder;
    this.pnpmStoreFolder = rushUserConfigurationJson?.pnpmStoreFolder;

    if (this.buildCacheFolder && !path.isAbsolute(this.buildCacheFolder)) {
      throw new Error('buildCacheFolder must be an absolute path');
    }
    if (this.pnpmStoreFolder && !path.isAbsolute(this.pnpmStoreFolder)) {
      throw new Error('pnpmStoreFolder must be an absolute path');
    }
  }

  public static async initializeAsync(): Promise<RushUserConfiguration> {
    const rushUserFolderPath: string = RushUserConfiguration.getRushUserFolderPath();
    const rushUserSettingsFilePath: string = path.join(rushUserFolderPath, 'settings.json');
    let rushUserSettingsJson: IRushUserSettingsJson | undefined;
    try {
      rushUserSettingsJson = await JsonFile.loadAndValidateAsync(
        rushUserSettingsFilePath,
        RushUserConfiguration._schema
      );
    } catch (e) {
      if (!FileSystem.isNotExistError(e)) {
        throw e;
      }
    }

    return new RushUserConfiguration(rushUserSettingsJson);
  }

  public static initializeSync(): RushUserConfiguration {
    const rushUserFolderPath: string = RushUserConfiguration.getRushUserFolderPath();
    const rushUserSettingsFilePath: string = path.join(rushUserFolderPath, 'settings.json');
    let rushUserSettingsJson: IRushUserSettingsJson | undefined;
    try {
      rushUserSettingsJson = JsonFile.loadAndValidate(
        rushUserSettingsFilePath,
        RushUserConfiguration._schema
      );
    } catch (e) {
      if (!FileSystem.isNotExistError(e)) {
        throw e;
      }
    }

    return new RushUserConfiguration(rushUserSettingsJson);
  }

  public static getRushUserFolderPath(): string {
    const homeFolderPath: string = Utilities.getHomeFolder();
    const rushUserSettingsFilePath: string = path.join(
      homeFolderPath,
      RushConstants.rushUserConfigurationFolderName
    );
    return rushUserSettingsFilePath;
  }
}
