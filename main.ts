import { App, Plugin, PluginSettingTab, Setting, Notice, TFolder, TFile, Modal, SecretComponent } from 'obsidian';

interface BookStackSettings {
	baseUrl: string;
	tokenIdSecret: string;
	tokenSecretSecret: string;
	syncFolder: string;
	selectedBooks: number[];
	autoSync: boolean;
	syncInterval: number;
	syncMode: 'pull-only' | 'push-only' | 'bidirectional';
}

const DEFAULT_SETTINGS: BookStackSettings = {
	baseUrl: '',
	tokenIdSecret: '',
	tokenSecretSecret: '',
	syncFolder: 'BookStack',
	selectedBooks: [],
	autoSync: false,
	syncInterval: 60,
	syncMode: 'bidirectional'
}

interface Book {
	id: number;
	name: string;
	slug: string;
	description: string;
	created_at: string;
	updated_at: string;
}

interface BookDetail extends Book {
	contents: Array<BookContent>;
}

interface BookContent {
	type: 'chapter' | 'page';
	id: number;
	name: string;
	slug: string;
}

interface Page {
	id: number;
	book_id: number;
	chapter_id: number | null;
	name: string;
	slug: string;
	html: string;
	markdown: string;
	created_at: string;
	updated_at: string;
}

interface PageFrontmatter {
	title?: string;
	bookstack_id?: number;
	created?: string;
	updated?: string;
	last_synced?: string;
}

export default class BookStackSyncPlugin extends Plugin {
	settings: BookStackSettings;
	syncIntervalId: number | null = null;

	async onload() {
		await this.loadSettings();

		// Add ribbon icon
		this.addRibbonIcon('book-open', 'BookStack Sync', async () => {
			await this.syncBooks();
		});

		// Add command to sync all books
		this.addCommand({
			id: 'sync-bookstack',
			name: 'Sync BookStack Books',
			callback: async () => {
				await this.syncBooks();
			}
		});

		// Add command to select books
		this.addCommand({
			id: 'select-books',
			name: 'Select Books to Sync',
			callback: () => {
				new BookSelectionModal(this.app, this).open();
			}
		});

		// Add settings tab
		this.addSettingTab(new BookStackSettingTab(this.app, this));

		// Setup auto-sync if enabled
		if (this.settings.autoSync) {
			this.startAutoSync();
		}
	}

	onunload() {
		if (this.syncIntervalId) {
			window.clearInterval(this.syncIntervalId);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	startAutoSync() {
		if (this.syncIntervalId) {
			window.clearInterval(this.syncIntervalId);
		}
		this.syncIntervalId = window.setInterval(
			() => this.syncBooks(),
			this.settings.syncInterval * 60 * 1000
		);
	}

	stopAutoSync() {
		if (this.syncIntervalId) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}

	getCredentials(): { tokenId: string | null, tokenSecret: string | null } {
		const tokenId = this.app.secretStorage.get(this.settings.tokenIdSecret);
		const tokenSecret = this.app.secretStorage.get(this.settings.tokenSecretSecret);
		return { tokenId, tokenSecret };
	}

	async makeRequest(endpoint: string, method: string = 'GET', body?: any): Promise<any> {
		const { tokenId, tokenSecret } = this.getCredentials();

		if (!tokenId || !tokenSecret) {
			throw new Error('API credentials not configured. Please set up your BookStack API tokens in settings.');
		}

		const url = `${this.settings.baseUrl}/api/${endpoint}`;
		const headers: Record<string, string> = {
			'Authorization': `Token ${tokenId}:${tokenSecret}`,
			'Content-Type': 'application/json'
		};

		const options: RequestInit = {
			method,
			headers
		};

		if (body && (method === 'PUT' || method === 'POST')) {
			options.body = JSON.stringify(body);
		}

		try {
			const response = await fetch(url, options);
			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
			}
			return await response.json();
		} catch (error) {
			new Notice(`BookStack API Error: ${error.message}`);
			throw error;
		}
	}

	async listBooks(): Promise<Book[]> {
		const response = await this.makeRequest('books');
		return response.data;
	}

	async getBook(bookId: number): Promise<BookDetail> {
		return await this.makeRequest(`books/${bookId}`);
	}

	async getPage(pageId: number): Promise<Page> {
		return await this.makeRequest(`pages/${pageId}`);
	}

	async updatePage(pageId: number, content: string, name?: string): Promise<Page> {
		const updateData: any = {
			markdown: content
		};

		if (name) {
			updateData.name = name;
		}

		return await this.makeRequest(`pages/${pageId}`, 'PUT', updateData);
	}

	async exportPageMarkdown(pageId: number): Promise<string> {
		const { tokenId, tokenSecret } = this.getCredentials();

		if (!tokenId || !tokenSecret) {
			throw new Error('API credentials not configured');
		}

		const url = `${this.settings.baseUrl}/api/pages/${pageId}/export/markdown`;
		const headers = {
			'Authorization': `Token ${tokenId}:${tokenSecret}`
		};

		const response = await fetch(url, { headers });
		if (!response.ok) {
			throw new Error(`Failed to export page ${pageId}`);
		}
		return await response.text();
	}

	extractFrontmatter(content: string): { frontmatter: PageFrontmatter; body: string } {
		const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) {
			return { frontmatter: {}, body: content };
		}

		const yamlText = match[1];
		const body = match[2];
		const frontmatter: PageFrontmatter = {};

		yamlText.split('\n').forEach(line => {
			const colonIndex = line.indexOf(':');
			if (colonIndex === -1) return;

			const key = line.substring(0, colonIndex).trim();
			const value = line.substring(colonIndex + 1).trim();

			if (key === 'bookstack_id') {
				frontmatter.bookstack_id = parseInt(value);
			} else if (key === 'title' || key === 'created' || key === 'updated' || key === 'last_synced') {
				frontmatter[key as keyof PageFrontmatter] = value as any;
			}
		});

		return { frontmatter, body };
	}

	createFrontmatter(metadata: PageFrontmatter): string {
		return `---
title: ${metadata.title || 'Untitled'}
bookstack_id: ${metadata.bookstack_id || ''}
created: ${metadata.created || ''}
updated: ${metadata.updated || ''}
last_synced: ${metadata.last_synced || ''}
---

`;
	}

	htmlToMarkdown(html: string): string {
		let md = html;
		
		md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n');
		md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n');
		md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n');
		md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n');
		md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n');
		md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n');
		
		md = md.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**');
		md = md.replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**');
		md = md.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*');
		md = md.replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*');
		
		md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');
		
		md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)');
		md = md.replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, '![]($1)');
		
		md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');
		md = md.replace(/<ul[^>]*>/gi, '\n');
		md = md.replace(/<\/ul>/gi, '\n');
		md = md.replace(/<ol[^>]*>/gi, '\n');
		md = md.replace(/<\/ol>/gi, '\n');
		
		md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n');
		
		md = md.replace(/<pre[^>]*><code[^>]*>(.*?)<\/code><\/pre>/gis, '```\n$1\n```\n');
		md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
		
		md = md.replace(/<br\s*\/?>/gi, '\n');
		
		md = md.replace(/<[^>]+>/g, '');
		
		md = md.replace(/&nbsp;/g, ' ');
		md = md.replace(/&amp;/g, '&');
		md = md.replace(/&lt;/g, '<');
		md = md.replace(/&gt;/g, '>');
		md = md.replace(/&quot;/g, '"');
		
		md = md.replace(/\n{3,}/g, '\n\n');
		
		return md.trim();
	}

	async syncBooks() {
		if (!this.settings.baseUrl) {
			new Notice('Please configure BookStack URL in settings');
			return;
		}

		const { tokenId, tokenSecret } = this.getCredentials();
		if (!tokenId || !tokenSecret) {
			new Notice('Please configure BookStack API credentials in settings');
			return;
		}

		if (this.settings.selectedBooks.length === 0) {
			new Notice('No books selected for sync. Use "Select Books to Sync" command.');
			return;
		}

		new Notice('Starting BookStack sync...');

		try {
			const syncFolder = this.settings.syncFolder;
			await this.ensureFolderExists(syncFolder);

			let pullCount = 0;
			let pushCount = 0;
			let skipCount = 0;
			let errorCount = 0;

			for (const bookId of this.settings.selectedBooks) {
				const result = await this.syncBook(bookId, syncFolder);
				pullCount += result.pulled;
				pushCount += result.pushed;
				skipCount += result.skipped;
				errorCount += result.errors;
			}

			const summary = [];
			if (pullCount > 0) summary.push(`${pullCount} pulled`);
			if (pushCount > 0) summary.push(`${pushCount} pushed`);
			if (skipCount > 0) summary.push(`${skipCount} skipped`);
			if (errorCount > 0) summary.push(`${errorCount} errors`);

			new Notice(`Sync complete: ${summary.join(', ')}`);
		} catch (error) {
			new Notice(`Sync failed: ${error.message}`);
			console.error('BookStack sync error:', error);
		}
	}

	async syncBook(bookId: number, basePath: string): Promise<{ pulled: number; pushed: number; skipped: number; errors: number }> {
		let pulled = 0, pushed = 0, skipped = 0, errors = 0;

		try {
			const book = await this.getBook(bookId);
			const bookPath = `${basePath}/${this.sanitizeFileName(book.name)}`;
			await this.ensureFolderExists(bookPath);

			const bookReadme = `# ${book.name}\n\n${book.description || ''}\n\n`;
			await this.createOrUpdateFile(`${bookPath}/README.md`, bookReadme);

			for (const content of book.contents) {
				if (content.type === 'chapter') {
					const result = await this.syncChapter(content.id, bookPath);
					pulled += result.pulled;
					pushed += result.pushed;
					skipped += result.skipped;
					errors += result.errors;
				} else if (content.type === 'page') {
					const result = await this.syncPage(content.id, bookPath);
					if (result === 'pulled') pulled++;
					else if (result === 'pushed') pushed++;
					else if (result === 'skipped') skipped++;
					else if (result === 'error') errors++;
				}
			}
		} catch (error) {
			console.error(`Failed to sync book ${bookId}:`, error);
			errors++;
		}

		return { pulled, pushed, skipped, errors };
	}

	async syncChapter(chapterId: number, bookPath: string): Promise<{ pulled: number; pushed: number; skipped: number; errors: number }> {
		let pulled = 0, pushed = 0, skipped = 0, errors = 0;

		try {
			const chapter = await this.makeRequest(`chapters/${chapterId}`);
			const chapterPath = `${bookPath}/${this.sanitizeFileName(chapter.name)}`;
			await this.ensureFolderExists(chapterPath);

			const chapterReadme = `# ${chapter.name}\n\n${chapter.description || ''}\n\n`;
			await this.createOrUpdateFile(`${chapterPath}/README.md`, chapterReadme);

			if (chapter.pages) {
				for (const page of chapter.pages) {
					const result = await this.syncPage(page.id, chapterPath);
					if (result === 'pulled') pulled++;
					else if (result === 'pushed') pushed++;
					else if (result === 'skipped') skipped++;
					else if (result === 'error') errors++;
				}
			}
		} catch (error) {
			console.error(`Failed to sync chapter ${chapterId}:`, error);
			errors++;
		}

		return { pulled, pushed, skipped, errors };
	}

	async syncPage(pageId: number, parentPath: string): Promise<'pulled' | 'pushed' | 'skipped' | 'error'> {
		try {
			const page = await this.getPage(pageId);
			const fileName = `${this.sanitizeFileName(page.name)}.md`;
			const filePath = `${parentPath}/${fileName}`;
			const existingFile = this.app.vault.getAbstractFileByPath(filePath);

			// Get remote timestamp
			const remoteUpdated = new Date(page.updated_at);

			if (existingFile instanceof TFile) {
				// File exists - check timestamps to decide pull or push
				const localContent = await this.app.vault.read(existingFile);
				const { frontmatter, body } = this.extractFrontmatter(localContent);

				const lastSynced = frontmatter.last_synced ? new Date(frontmatter.last_synced) : null;
				const localModified = new Date(existingFile.stat.mtime);

				// Check if local file was modified after last sync
				const hasLocalChanges = lastSynced && localModified > new Date(lastSynced.getTime() + 1000); // 1s buffer

				if (this.settings.syncMode === 'pull-only') {
					// Pull only mode
					if (lastSynced && remoteUpdated <= lastSynced) {
						console.log(`Skipping ${page.name} - already up to date`);
						return 'skipped';
					}
					await this.pullPage(page, filePath);
					return 'pulled';

				} else if (this.settings.syncMode === 'push-only') {
					// Push only mode
					if (hasLocalChanges) {
						await this.pushPage(page.id, body, page.name);
						await this.updateLocalSyncTime(existingFile, frontmatter, body);
						return 'pushed';
					}
					return 'skipped';

				} else {
					// Bidirectional mode
					if (hasLocalChanges && lastSynced) {
						// Local changes exist
						if (remoteUpdated > lastSynced) {
							// Both changed - conflict!
							new Notice(`Conflict: ${page.name} changed in both places. Local changes preserved.`);
							console.log(`Conflict on ${page.name}: remote=${remoteUpdated}, local=${localModified}, lastSync=${lastSynced}`);
							return 'skipped';
						} else {
							// Only local changed - push
							console.log(`Pushing ${page.name} to BookStack (local newer)`);
							await this.pushPage(page.id, body, page.name);
							await this.updateLocalSyncTime(existingFile, frontmatter, body);
							return 'pushed';
						}
					} else {
						// No local changes
						if (!lastSynced || remoteUpdated > lastSynced) {
							// Remote is newer - pull
							console.log(`Pulling ${page.name} from BookStack (remote newer)`);
							await this.pullPage(page, filePath);
							return 'pulled';
						} else {
							// Already in sync
							return 'skipped';
						}
					}
				}

			} else {
				// File doesn't exist locally - always pull
				await this.pullPage(page, filePath);
				return 'pulled';
			}

		} catch (error) {
			console.error(`Failed to sync page ${pageId}:`, error);
			return 'error';
		}
	}

	async pullPage(page: Page, filePath: string): Promise<void> {
		let content = '';
		try {
			content = await this.exportPageMarkdown(page.id);
		} catch (error) {
			console.log(`Markdown export failed for page ${page.id}, converting HTML`);
			content = this.htmlToMarkdown(page.html);
		}

		const metadata: PageFrontmatter = {
			title: page.name,
			bookstack_id: page.id,
			created: page.created_at,
			updated: page.updated_at,
			last_synced: new Date().toISOString()
		};

		const fullContent = this.createFrontmatter(metadata) + content;
		await this.createOrUpdateFile(filePath, fullContent);
	}

	async pushPage(pageId: number, content: string, name: string): Promise<void> {
		await this.updatePage(pageId, content, name);
	}

	async updateLocalSyncTime(file: TFile, frontmatter: PageFrontmatter, body: string): Promise<void> {
		frontmatter.last_synced = new Date().toISOString();
		const fullContent = this.createFrontmatter(frontmatter) + body;
		await this.app.vault.modify(file, fullContent);
	}

	async ensureFolderExists(path: string) {
		const folders = path.split('/');
		let currentPath = '';

		for (const folder of folders) {
			currentPath = currentPath ? `${currentPath}/${folder}` : folder;
			const folderExists = this.app.vault.getAbstractFileByPath(currentPath);
			
			if (!folderExists) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	async createOrUpdateFile(path: string, content: string) {
		const existingFile = this.app.vault.getAbstractFileByPath(path);
		
		if (existingFile instanceof TFile) {
			await this.app.vault.modify(existingFile, content);
		} else {
			await this.app.vault.create(path, content);
		}
	}

	sanitizeFileName(name: string): string {
		return name
			.replace(/[\\/:*?"<>|]/g, '-')
			.replace(/\s+/g, ' ')
			.trim();
	}
}

class BookSelectionModal extends Modal {
	plugin: BookStackSyncPlugin;
	books: Book[] = [];
	selectedBooks: Set<number>;

	constructor(app: App, plugin: BookStackSyncPlugin) {
		super(app);
		this.plugin = plugin;
		this.selectedBooks = new Set(plugin.settings.selectedBooks);
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Select Books to Sync' });

		const loadingEl = contentEl.createEl('p', { text: 'Loading books...' });

		try {
			this.books = await this.plugin.listBooks();
			loadingEl.remove();

			if (this.books.length === 0) {
				contentEl.createEl('p', { text: 'No books found in your BookStack instance.' });
				return;
			}

			const listEl = contentEl.createEl('div', { cls: 'book-list' });

			for (const book of this.books) {
				const itemEl = listEl.createEl('div', { cls: 'book-item' });
				
				const checkbox = itemEl.createEl('input', { type: 'checkbox' });
				checkbox.checked = this.selectedBooks.has(book.id);
				checkbox.addEventListener('change', () => {
					if (checkbox.checked) {
						this.selectedBooks.add(book.id);
					} else {
						this.selectedBooks.delete(book.id);
					}
				});

				itemEl.createEl('label', { text: book.name });
			}

			const buttonContainer = contentEl.createEl('div', { cls: 'button-container' });
			
			const saveBtn = buttonContainer.createEl('button', { text: 'Save Selection' });
			saveBtn.addEventListener('click', async () => {
				this.plugin.settings.selectedBooks = Array.from(this.selectedBooks);
				await this.plugin.saveSettings();
				new Notice(`${this.selectedBooks.size} books selected for sync`);
				this.close();
			});

		} catch (error) {
			loadingEl.setText(`Error loading books: ${error.message}`);
			console.error('Error loading books:', error);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class BookStackSettingTab extends PluginSettingTab {
	plugin: BookStackSyncPlugin;

	constructor(app: App, plugin: BookStackSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'BookStack Sync Settings' });

		new Setting(containerEl)
			.setName('BookStack URL')
			.setDesc('Base URL of your BookStack instance (e.g., https://bookstack.example.com)')
			.addText(text => text
				.setPlaceholder('https://bookstack.example.com')
				.setValue(this.plugin.settings.baseUrl)
				.onChange(async (value) => {
					this.plugin.settings.baseUrl = value.replace(/\/$/, '');
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('API Token ID')
			.setDesc('Select or create a secret for your BookStack API token ID')
			.addComponent(el => new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.tokenIdSecret)
				.onChange(async (value) => {
					this.plugin.settings.tokenIdSecret = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('API Token Secret')
			.setDesc('Select or create a secret for your BookStack API token secret')
			.addComponent(el => new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.tokenSecretSecret)
				.onChange(async (value) => {
					this.plugin.settings.tokenSecretSecret = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync Folder')
			.setDesc('Folder where BookStack content will be synced')
			.addText(text => text
				.setPlaceholder('BookStack')
				.setValue(this.plugin.settings.syncFolder)
				.onChange(async (value) => {
					this.plugin.settings.syncFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync Mode')
			.setDesc('Choose how sync operates: pull from BookStack, push to BookStack, or bidirectional')
			.addDropdown(dropdown => dropdown
				.addOption('bidirectional', 'Bidirectional (Smart sync based on timestamps)')
				.addOption('pull-only', 'Pull Only (BookStack → Obsidian)')
				.addOption('push-only', 'Push Only (Obsidian → BookStack)')
				.setValue(this.plugin.settings.syncMode)
				.onChange(async (value) => {
					this.plugin.settings.syncMode = value as any;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto Sync')
			.setDesc('Automatically sync books at regular intervals')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
					if (value) {
						this.plugin.startAutoSync();
					} else {
						this.plugin.stopAutoSync();
					}
				}));

		new Setting(containerEl)
			.setName('Sync Interval (minutes)')
			.setDesc('How often to sync when auto-sync is enabled')
			.addText(text => text
				.setPlaceholder('60')
				.setValue(String(this.plugin.settings.syncInterval))
				.onChange(async (value) => {
					const num = parseInt(value);
					if (!isNaN(num) && num > 0) {
						this.plugin.settings.syncInterval = num;
						await this.plugin.saveSettings();
						if (this.plugin.settings.autoSync) {
							this.plugin.startAutoSync();
						}
					}
				}));

		containerEl.createEl('h3', { text: 'How to get API credentials' });
		containerEl.createEl('p', { text: '1. Log into your BookStack instance' });
		containerEl.createEl('p', { text: '2. Go to your profile settings' });
		containerEl.createEl('p', { text: '3. Scroll to "API Tokens" section' });
		containerEl.createEl('p', { text: '4. Create a new token and copy the ID and Secret' });
		containerEl.createEl('p', { text: '5. Use the dropdowns above to create new secrets or select existing ones' });
		
		containerEl.createEl('h3', { text: 'About Sync Modes' });
		containerEl.createEl('p', { 
			text: 'Bidirectional: Compares timestamps and syncs in the direction of the most recent change. If both changed, local is preserved.'
		});
		containerEl.createEl('p', { 
			text: 'Pull Only: Only downloads changes from BookStack, never uploads local changes.'
		});
		containerEl.createEl('p', { 
			text: 'Push Only: Only uploads local changes to BookStack, never downloads remote changes.'
		});
		
		containerEl.createEl('h3', { text: 'About SecretStorage' });
		containerEl.createEl('p', { 
			text: 'This plugin uses Obsidian\'s SecretStorage to securely store your API credentials. ' +
			      'Secrets are stored separately from plugin settings and can be shared across multiple plugins. ' +
			      'You can manage all your secrets in Settings → About → Manage secrets.'
		});
	}
}