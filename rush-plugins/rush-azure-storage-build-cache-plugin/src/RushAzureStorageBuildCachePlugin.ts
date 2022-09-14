// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { Import } from '@rushstack/node-core-library';
import type {
  IRushPlugin,
  RushSession,
  RushConfiguration,
  IPhasedCommand,
  IExecutionResult,
  ICreateOperationsContext,
  ILogger
} from '@rushstack/rush-sdk';

import type { AzureEnvironmentName } from './AzureAuthenticationBase';

const AzureStorageBuildCacheProviderModule: typeof import('./AzureStorageBuildCacheProvider') = Import.lazy(
  './AzureStorageBuildCacheProvider',
  require
);

const PLUGIN_NAME: string = 'AzureStorageBuildCachePlugin';

/**
 * @public
 */
interface IAzureBlobStorageConfigurationJson {
  /**
   * The name of the the Azure storage account to use for build cache.
   */
  storageAccountName: string;

  /**
   * The name of the container in the Azure storage account to use for build cache.
   */
  storageContainerName: string;

  /**
   * The Azure environment the storage account exists in. Defaults to AzureCloud.
   */
  azureEnvironment?: AzureEnvironmentName;

  /**
   * An optional prefix for cache item blob names.
   */
  blobPrefix?: string;

  /**
   * An optional maximum concurrency for cache writes.
   */
  concurrency?: number;

  /**
   * If set to true, allow writing to the cache. Defaults to false.
   */
  isCacheWriteAllowed?: boolean;
}

/**
 * @public
 */
export class RushAzureStorageBuildCachePlugin implements IRushPlugin {
  public pluginName: string = PLUGIN_NAME;

  public apply(rushSession: RushSession, rushConfig: RushConfiguration): void {
    rushSession.hooks.runAnyPhasedCommand.tap(PLUGIN_NAME, (command: IPhasedCommand) => {
      let buildCacheProvider:
        | typeof AzureStorageBuildCacheProviderModule.AzureStorageBuildCacheProvider.prototype
        | undefined;

      rushSession.registerCloudBuildCacheProviderFactory('azure-blob-storage', (buildCacheConfig) => {
        type IBuildCache = typeof buildCacheConfig & {
          azureBlobStorageConfiguration: IAzureBlobStorageConfigurationJson;
        };
        const { azureBlobStorageConfiguration } = buildCacheConfig as IBuildCache;
        buildCacheProvider = new AzureStorageBuildCacheProviderModule.AzureStorageBuildCacheProvider({
          storageAccountName: azureBlobStorageConfiguration.storageAccountName,
          storageContainerName: azureBlobStorageConfiguration.storageContainerName,
          azureEnvironment: azureBlobStorageConfiguration.azureEnvironment,
          blobPrefix: azureBlobStorageConfiguration.blobPrefix,
          concurrency: azureBlobStorageConfiguration.concurrency,
          isCacheWriteAllowed: !!azureBlobStorageConfiguration.isCacheWriteAllowed
        });
        return buildCacheProvider;
      });

      command.hooks.afterExecuteOperations.tapPromise(
        PLUGIN_NAME,
        async (result: IExecutionResult, context: ICreateOperationsContext) => {
          if (!buildCacheProvider) {
            return;
          }

          const logger: ILogger = rushSession.getLogger(PLUGIN_NAME);

          await buildCacheProvider.flushWritesAsync(logger);
        }
      );
    });
  }
}
