/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as electron from 'electron';
import { memoize } from '../../../base/common/decorators.js';
import { Event } from '../../../base/common/event.js';
import { hash } from '../../../base/common/hash.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService, IRelaunchHandler, IRelaunchOptions } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IRequestService } from '../../request/common/request.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { IUpdate, State, StateType, UpdateType } from '../common/update.js';
import { AbstractUpdateService, createUpdateURL, UpdateErrorClassification } from './abstractUpdateService.js';
import { IDialogMainService } from '../../dialogs/electron-main/dialogMainService.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { StorageScope, StorageTarget } from '../../storage/common/storage.js';
import { localize } from '../../../nls.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { massageMessageBoxOptions } from '../../dialogs/common/dialogs.js';

const MOVE_TO_APPLICATIONS_FOLDER_CHOICE_KEY = 'application.moveToApplicationsFolder';

export class DarwinUpdateService extends AbstractUpdateService implements IRelaunchHandler {

	private readonly disposables = new DisposableStore();

	@memoize private get onRawError(): Event<string> { return Event.fromNodeEventEmitter(electron.autoUpdater, 'error', (_, message) => message); }
	@memoize private get onRawUpdateNotAvailable(): Event<void> { return Event.fromNodeEventEmitter<void>(electron.autoUpdater, 'update-not-available'); }
	@memoize private get onRawUpdateAvailable(): Event<void> { return Event.fromNodeEventEmitter(electron.autoUpdater, 'update-available'); }
	@memoize private get onRawUpdateDownloaded(): Event<IUpdate> { return Event.fromNodeEventEmitter(electron.autoUpdater, 'update-downloaded', (_, releaseNotes, version, timestamp) => ({ version, productVersion: version, timestamp })); }

	constructor(
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IConfigurationService configurationService: IConfigurationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IRequestService requestService: IRequestService,
		@ILogService logService: ILogService,
		@IProductService productService: IProductService,
		@IDialogMainService private readonly dialogMainService: IDialogMainService,
		@IApplicationStorageMainService private readonly applicationStorageMainService: IApplicationStorageMainService
	) {
		super(lifecycleMainService, configurationService, environmentMainService, requestService, logService, productService);

		lifecycleMainService.setRelaunchHandler(this);
	}

	handleRelaunch(options?: IRelaunchOptions): boolean {
		if (options?.addArgs || options?.removeArgs) {
			return false; // we cannot apply an update and restart with different args
		}

		if (this.state.type !== StateType.Ready) {
			return false; // we only handle the relaunch when we have a pending update
		}

		this.logService.trace('update#handleRelaunch(): running raw#quitAndInstall()');
		this.doQuitAndInstall();

		return true;
	}

	protected override async initialize(): Promise<void> {
		await super.initialize();
		this.onRawError(this.onError, this, this.disposables);
		this.onRawUpdateAvailable(this.onUpdateAvailable, this, this.disposables);
		this.onRawUpdateDownloaded(this.onUpdateDownloaded, this, this.disposables);
		this.onRawUpdateNotAvailable(this.onUpdateNotAvailable, this, this.disposables);
	}

	private onError(err: string): void {
		this.telemetryService.publicLog2<{ messageHash: string }, UpdateErrorClassification>('update:error', { messageHash: String(hash(String(err))) });
		this.logService.error('UpdateService error:', err);

		// only show message when explicitly checking for updates
		const message = (this.state.type === StateType.CheckingForUpdates && this.state.explicit) ? err : undefined;
		this.setState(State.Idle(UpdateType.Archive, message));
	}

	protected buildUpdateFeedUrl(quality: string): string | undefined {
		let assetID: string;
		if (!this.productService.darwinUniversalAssetId) {
			assetID = process.arch === 'x64' ? 'darwin' : 'darwin-arm64';
		} else {
			assetID = this.productService.darwinUniversalAssetId;
		}
		const url = createUpdateURL(assetID, quality, this.productService);
		try {
			electron.autoUpdater.setFeedURL({ url });
		} catch (e) {
			// application is very likely not signed
			this.logService.error('Failed to set update feed URL', e);
			return undefined;
		}
		return url;
	}

	protected doCheckForUpdates(explicit: boolean): void {
		if (!this.url) {
			return;
		}

		this.setState(State.CheckingForUpdates(explicit));

		const url = explicit ? this.url : `${this.url}?bg=true`;
		electron.autoUpdater.setFeedURL({ url });
		electron.autoUpdater.checkForUpdates();
	}

	protected override async ensureUpdatePrerequisite(): Promise<void> {
		if (!electron.app.isInApplicationsFolder()) {
			let allowed = this.applicationStorageMainService.getBoolean(`${MOVE_TO_APPLICATIONS_FOLDER_CHOICE_KEY}`, StorageScope.APPLICATION);
			if (allowed === undefined) {
				const { response, checkboxChecked } = await this.dialogMainService.showMessageBox({
					type: 'info',
					buttons: [
						localize({ key: 'move', comment: ['&& denotes a mnemonic'] }, "&&Move to Applications folder"),
						localize({ key: 'cancel', comment: ['&& denotes a mnemonic'] }, "&&Cancel")
					],
					message: localize('moveToApplicationsFolderWarning', "{0} works best when run from the Applications folder.", this.productService.nameLong),
					checkboxLabel: localize('remember', "Do not ask again"),
					cancelId: 1
				});

				allowed = response === 0;
				if (allowed && checkboxChecked) {
					this.applicationStorageMainService.store(`${MOVE_TO_APPLICATIONS_FOLDER_CHOICE_KEY}`, allowed, StorageScope.APPLICATION, StorageTarget.MACHINE);
				}
			}

			if (allowed) {
				try {
					electron.app.moveToApplicationsFolder({
						conflictHandler: conflictType => {
							if (conflictType === 'exists') {
								const response = electron.dialog.showMessageBoxSync(massageMessageBoxOptions({
									type: 'warning',
									buttons: [
										localize({ key: 'continue', comment: ['&& denotes a mnemonic'] }, "&&Continue"),
										localize({ key: 'cancel', comment: ['&& denotes a mnemonic'] }, "&&Cancel")
									],
									message: localize('applicationAlreadyExists', "Another copy of {0} already exists inside the Applications folder which will be replaced, would you like to continue ?", this.productService.nameLong),
									cancelId: 1
								}, this.productService).options);
								return (response === 0);
							}
							return false;
						}
					});
				} catch (error) {
					this.logService.trace(`update#moveToApplicationsFolder: failed with ${toErrorMessage(error)}`);
				}
			}
		}
	}

	private onUpdateAvailable(): void {
		if (this.state.type !== StateType.CheckingForUpdates) {
			return;
		}

		this.setState(State.Downloading);
	}

	private onUpdateDownloaded(update: IUpdate): void {
		if (this.state.type !== StateType.Downloading) {
			return;
		}

		this.setState(State.Downloaded(update));

		type UpdateDownloadedClassification = {
			owner: 'joaomoreno';
			newVersion: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The version number of the new VS Code that has been downloaded.' };
			comment: 'This is used to know how often VS Code has successfully downloaded the update.';
		};
		this.telemetryService.publicLog2<{ newVersion: String }, UpdateDownloadedClassification>('update:downloaded', { newVersion: update.version });

		this.setState(State.Ready(update));
	}

	private onUpdateNotAvailable(): void {
		if (this.state.type !== StateType.CheckingForUpdates) {
			return;
		}

		this.setState(State.Idle(UpdateType.Archive));
	}

	protected override doQuitAndInstall(): void {
		this.logService.trace('update#quitAndInstall(): running raw#quitAndInstall()');
		electron.autoUpdater.quitAndInstall();
	}

	dispose(): void {
		this.disposables.dispose();
	}
}
