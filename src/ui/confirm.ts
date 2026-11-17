/**
 * A small yes / no modal (public `Modal` and `Setting`), used before clearing the stored data.
 */
import { Modal, Setting, type App } from 'obsidian';

export interface ConfirmText {
	readonly title: string;
	readonly message: string;
	readonly confirm: string;
	readonly cancel: string;
}

export class ConfirmModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private readonly text: ConfirmText,
		private readonly onConfirm: () => void,
		private readonly onClosed: () => void = () => undefined,
	) {
		super(app);
	}

	override onOpen(): void {
		this.modalEl.addClass('tabstrip-confirm');
		this.titleEl.setText(this.text.title);
		this.contentEl.createEl('p', { text: this.text.message });
		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText(this.text.cancel).onClick(() => {
					this.close();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText(this.text.confirm)
					.setDestructive()
					.setCta()
					.onClick(() => {
						this.confirmed = true;
						this.close();
					}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
		this.onClosed();
		if (this.confirmed) this.onConfirm();
	}
}
