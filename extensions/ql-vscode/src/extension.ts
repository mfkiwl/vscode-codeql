import { commands, Disposable, ExtensionContext, extensions, ProgressLocation, ProgressOptions, window as Window } from 'vscode';
import { ErrorCodes, LanguageClient, ResponseError } from 'vscode-languageclient';
import * as archiveFilesystemProvider from './archive-filesystem-provider';
import { DistributionConfigListener, QueryServerConfigListener } from './config';
import { DatabaseManager } from './databases';
import { DatabaseUI } from './databases-ui';
import { DistributionInstallOrUpdateResultKind, DistributionManager, GithubApiError } from './distribution';
import * as helpers from './helpers';
import { spawnIdeServer } from './ide-server';
import { InterfaceManager } from './interface';
import { ideServerLogger, logger, queryServerLogger } from './logging';
import { compileAndRunQueryAgainstDatabase, EvaluationInfo, tmpDirDisposal } from './queries';
import { QueryHistoryItem, QueryHistoryManager } from './query-history';
import * as qsClient from './queryserver-client';

/**
* extension.ts
* ------------
*
* A vscode extension for QL query development.
*/

/**
 * Holds when we have proceeded past the initial phase of extension activation in which
 * we are trying to ensure that a valid CodeQL distribution exists, and we're actually setting
 * up the bulk of the extension.
 */
let beganMainExtensionActivation = false;

/**
 * A list of vscode-registered-command disposables that contain
 * temporary stub handlers for commands that exist package.json (hence
 * are already connected to onscreen ui elements) but which will not
 * have any useful effect if we haven't located a CodeQL distribution.
 */
const errorStubs: Disposable[] = [];

/**
 * If the user tries to execute vscode commands after extension activation is failed, give
 * a sensible error message.
 */
function registerErrorStubs(ctx: ExtensionContext, message: (command: string) => string) {
  const extensionId = 'Semmle.ql-vscode'; // TODO: Is there a better way of obtaining this?
  const extension = extensions.getExtension(extensionId);
  if (extension === undefined)
    throw new Error(`Can't find extension ${extensionId}`);

  // We want to stub out all commands except the one that lets the
  // user download a CodeQL distrubtion.
  const stubbedCommands = extension.packageJSON.contributes.commands
    .map(entry => entry.command)
    .filter(command => command !== "ql.updateTools");

  stubbedCommands.forEach(command => {
    errorStubs.push(commands.registerCommand(command, () => Window.showErrorMessage(message(command))));
  });
}

export async function activate(ctx: ExtensionContext): Promise<void> {
  // Initialise logging, and ensure all loggers are disposed upon exit.
  ctx.subscriptions.push(logger);
  logger.log('Starting QL extension');

  const distributionConfigListener = new DistributionConfigListener();
  ctx.subscriptions.push(distributionConfigListener);
  const distributionManager = new DistributionManager(ctx, distributionConfigListener);

  async function downloadOrUpdateDistribution(progressTitle: string): Promise<void> {
    const progressOptions: ProgressOptions = {
      location: ProgressLocation.Notification,
      title: progressTitle,
      cancellable: false,
    };
    const result = await helpers.withProgress(progressOptions,
      progress => distributionManager.installOrUpdateDistribution(progress));
    switch (result.kind) {
      case DistributionInstallOrUpdateResultKind.AlreadyUpToDate:
        helpers.showAndLogInformationMessage("CodeQL tools already up to date.");
        break;
      case DistributionInstallOrUpdateResultKind.DistributionUpdated:
        helpers.showAndLogInformationMessage(`CodeQL tools updated to version ${result.updatedRelease.name}.`);
        break;
      case DistributionInstallOrUpdateResultKind.InvalidDistributionLocation:
        helpers.showAndLogErrorMessage("CodeQL tools are installed externally so could not be updated.");
        break;
      default:
        helpers.assertNever(result);
    }
  }

  registerErrorStubs(ctx, command => `Can't execute ${command}: missing CodeQL command-line tools distribution.`);

  ctx.subscriptions.push(commands.registerCommand('ql.updateTools', async () => {
    await downloadOrUpdateDistribution("Checking for CodeQL Updates");
    if (!beganMainExtensionActivation) {
      await activateWithInstalledDistribution(ctx, distributionManager);
    }
  }));

  if (await distributionManager.getCodeQlPath() === undefined) {
    try {
      await downloadOrUpdateDistribution("Installing CodeQL Distribution");
    }
    catch (e) {
      if (e instanceof GithubApiError && (e.status == 404 || e.status == 403)) {
        const errorMessageResponse = Window.showErrorMessage(`Unable to download a CodeQL distribution. See
https://github.com/github/vscode-codeql/blob/master/extensions/ql-vscode/README.md for more details about how
to obtain CodeQL binaries.`, 'Edit Settings');
        // We're deliberately not `await`ing this promise, just
        // asynchronously letting the user follow the convenience link
        // if they want to.
        errorMessageResponse.then(response => {
          if (response !== undefined) {
            commands.executeCommand('workbench.action.openSettingsJson');
          }
        });
      }
      throw e;
    }
  }

  await activateWithInstalledDistribution(ctx, distributionManager);
}

async function activateWithInstalledDistribution(ctx: ExtensionContext, distributionManager: DistributionManager) {
  beganMainExtensionActivation = true;
  // Remove any error stubs command handlers left over from first part
  // of activation.
  errorStubs.forEach(stub => stub.dispose());

  const qlConfigurationListener = await QueryServerConfigListener.createQueryServerConfigListener(distributionManager);
  ctx.subscriptions.push(qlConfigurationListener);

  ctx.subscriptions.push(queryServerLogger);
  ctx.subscriptions.push(ideServerLogger);

  const qs = new qsClient.QueryServerClient(qlConfigurationListener, {
    logger: queryServerLogger,
  }, task => Window.withProgress({ title: 'QL query server', location: ProgressLocation.Window }, task));
  ctx.subscriptions.push(qs);
  await qs.startQueryServer();

  const dbm = new DatabaseManager(ctx, qlConfigurationListener, logger);
  ctx.subscriptions.push(dbm);
  const databaseUI = new DatabaseUI(ctx, dbm, qs);
  ctx.subscriptions.push(databaseUI);

  const qhm = new QueryHistoryManager(ctx, async item => showResultsForInfo(item.info));
  const intm = new InterfaceManager(ctx, dbm, qlConfigurationListener, queryServerLogger);
  ctx.subscriptions.push(intm);
  archiveFilesystemProvider.activate(ctx);

  async function showResultsForInfo(info: EvaluationInfo): Promise<void> {
    await intm.showResults(info);
  }

  async function compileAndRunQuery(quickEval: boolean) {
    if (qs !== undefined) {
      try {
        const dbItem = await databaseUI.getDatabaseItem();
        if (dbItem === undefined) {
          throw new Error('Can\'t run query without a selected database');
        }
        const info = await compileAndRunQueryAgainstDatabase(qlConfigurationListener, qs, dbItem, quickEval);
        await showResultsForInfo(info);
        qhm.push(new QueryHistoryItem(info));
      }
      catch (e) {
        if (e instanceof ResponseError && e.code == ErrorCodes.RequestCancelled) {
          logger.log(e.message);
        }
        else if (e instanceof Error)
          helpers.showAndLogErrorMessage(e.message);
        else
          throw e;
      }
    }
  }

  ctx.subscriptions.push(tmpDirDisposal);

  let client = new LanguageClient('QL Language Server', () => spawnIdeServer(qlConfigurationListener), {
    documentSelector: [
      { language: 'ql', scheme: 'file' },
      { language: 'yaml', scheme: 'file', pattern: '**/qlpack.yml' }
    ],
    synchronize: {
      configurationSection: 'ql'
    },
    // Ensure that language server exceptions are logged to the same channel as its output.
    outputChannel: ideServerLogger.outputChannel
  }, true);

  ctx.subscriptions.push(commands.registerCommand('ql.runQuery', async () => await compileAndRunQuery(false)));
  ctx.subscriptions.push(commands.registerCommand('ql.quickEval', async () => await compileAndRunQuery(true)));

  ctx.subscriptions.push(client.start());
}
