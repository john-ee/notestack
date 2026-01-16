import { App, Plugin, PluginSettingTab, Setting, Notice, TFolder, TFile, Modal, SecretComponent, requestUrl } from 'obsidian';

interface BookStackSettings {
	baseUrl: string;
	tokenIdSecret: string;
	tokenSecretSecret: string;
	syncFolder: string;
	selectedBooks: number[];
	autoSync: boolean;
	syncInterval: number;
	syncMode: 'pull-only' | 'push-only' | 'bidirectional';
	showDescriptionsInFrontmatter: boolean;
}

const DEFAULT_SETTINGS: BookStackSettings = {
	baseUrl: '',
	tokenIdSecret: '',
	tokenSecretSecret: '',
	syncFolder: 'BookStack',
	selectedBooks: [],
	autoSync: false,
	syncInterval: 60,
	syncMode: 'bidirectional',
	showDescriptionsInFrontmatter: true
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

interface Chapter {
	id: number;
	book_id: number;
	name: string;
	slug: string;
	description: string;
	pages?: Page[];
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
	book_id?: number;
	chapter_id?: number | null;
	book_name?: string;
	chapter_name?: string;
	book_description?: string;
	chapter_description?: string;
	created?: string;
	updated?: string;
	last_synced?: string;
}

export default class BookStackSyncPlugin extends Plugin {
	settings: BookStackSettings;
	syncIntervalId: number | null = null;
	private isSyncing: boolean = false;

	private get isMobile(): boolean {
		return (this.app as any).isMobile ?? false;
	}

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('book-open', 'BookStack Sync', async () => {
			await this.syncBooks();
		});

		this.addCommand({
			id: 'sync-bookstack',
			name: 'Sync BookStack Books',
			callback: async () => {
				await this.syncBooks();
			}
		});

		this.addCommand({
			id: 'select-books',
			name: 'Select Books to Sync',
			callback: () => {
				new BookSelectionModal(this.app, this).open();
			}
		});

		this.addCommand({
			id: 'test-connection',
			name: 'Test BookStack Connection',
			callback: async () => {
				await this.testConnection();
			}
		});

		this.addSettingTab(new BookStackSettingTab(this.app, this));

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

	async getCredentials(): Promise<{ tokenId: string | null; tokenSecret: string | null }> {
		const tokenId = await this.app.secretStorage.getSecret(this.settings.tokenIdSecret);
		const tokenSecret = await this.app.secretStorage.getSecret(this.settings.tokenSecretSecret);
		return { tokenId, tokenSecret };
	}

	async makeRequest(endpoint: string, method: string = 'GET', body?: any): Promise<any> {
		const { tokenId, tokenSecret } = await this.getCredentials();
		if (!tokenId || !tokenSecret) {
			throw new Error('API credentials not configured. Please set up your BookStack API tokens in settings.');
		}

		const url = `${this.settings.baseUrl}/api/${endpoint}`;
		const headers: Record<string, string> = {
			'Authorization': `Token ${tokenId}:${tokenSecret}`,
			'Accept': 'application/json'
		};

		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}

		try {
			console.log(`[BookStack] ${method} ${url} via requestUrl`);
			const res = await requestUrl({
				url,
				method,
				headers,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				throw: false
			});

			console.log(`[BookStack] Response status: ${res.status}`);

			if (res.status < 200 || res.status >= 300) {
				throw new Error(`HTTP ${res.status}: ${res.text}`);
			}

			return res.json;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const errorName = error instanceof Error ? error.name : 'Unknown';
			const detailedError = `API Error [${errorName}]: ${errorMsg}`;
			console.error(`[BookStack] ${detailedError}`, {
				url,
				method,
				endpoint,
				error,
				platform: this.isMobile ? 'mobile' : 'desktop'
			});
			new Notice(`${detailedError}\n\nCheck console for details`);
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

	async getChapter(chapterId: number): Promise<Chapter> {
		return await this.makeRequest(`chapters/${chapterId}`);
	}

	async getPage(pageId: number): Promise<Page> {
		return await this.makeRequest(`pages/${pageId}`);
	}

	async createPage(bookId: number, name: string, markdown: string, chapterId?: number): Promise<Page> {
		const createData: any = {
			book_id: bookId,
			name: name,
			markdown: markdown
		};
		if (chapterId) {
			createData.chapter_id = chapterId;
		}
		return await this.makeRequest('pages', 'POST', createData);
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
		const { tokenId, tokenSecret } = await this.getCredentials();
		if (!tokenId || !tokenSecret) {
			throw new Error('API credentials not configured');
		}
		const url = `${this.settings.baseUrl}/api/pages/${pageId}/export/markdown`;
		try {
			console.log(`[BookStack] Exporting markdown for page ${pageId}`);
			const res = await requestUrl({
				url,
				headers: {
					'Authorization': `Token ${tokenId}:${tokenSecret}`,
					'Accept': 'text/markdown, text/plain, */*'
				},
				throw: false
			});
			console.log(`[BookStack] Export response status: ${res.status}`);
			if (res.status !== 200) {
				throw new Error(`Failed to export page ${pageId}: HTTP ${res.status}`);
			}
			return res.text;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error(`[BookStack] Export markdown error: ${errorMsg}`, error);
			throw error;
		}
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
			let value = line.substring(colonIndex + 1).trim();

			// Remove quotes if present
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
				value = value.slice(1, -1);
			}

			if (key === 'bookstack_id' || key === 'book_id' || key === 'chapter_id') {
				const num = parseInt(value);
				if (!isNaN(num)) {
					(frontmatter as any)[key] = num as any;
				} else if (value === 'null' || value === '') {
					(frontmatter as any)[key] = null as any;
				}
			} else if (['title', 'book_name', 'chapter_name', 'book_description', 'chapter_description', 'created', 'updated', 'last_synced'].includes(key)) {
				(frontmatter as any)[key] = value as any;
			}
		});

		return { frontmatter, body };
	}

	createFrontmatter(metadata: PageFrontmatter): string {
		let fm = '---\n';
		fm += `title: ${metadata.title ?? 'Untitled'}\n`;
		fm += `bookstack_id: ${metadata.bookstack_id ?? ''}\n`;
		fm += `book_id: ${metadata.book_id ?? ''}\n`;
		fm += `chapter_id: ${metadata.chapter_id !== undefined ? metadata.chapter_id : ''}\n`;

		if (this.settings.showDescriptionsInFrontmatter) {
			if (metadata.book_name) {
				fm += `book_name: ${metadata.book_name}\n`;
			}
			if (metadata.book_description) {
				fm += `book_description: "${metadata.book_description.replace(/"/g, '\\"')}"\n`;
			}
			if (metadata.chapter_name) {
				fm += `chapter_name: ${metadata.chapter_name}\n`;
			}
			if (metadata.chapter_description) {
				fm += `chapter_description: "${metadata.chapter_description.replace(/"/g, '\\"')}"\n`;
			}
		}

		fm += `created: ${metadata.created ?? ''}\n`;
		fm += `updated: ${metadata.updated ?? ''}\n`;
		fm += `last_synced: ${metadata.last_synced ?? ''}\n`;
		fm += '---\n\n';
		return fm;
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
		md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gis, '```\n$1\n```\n');
		md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
		md = md.replace(/<br\s*\/?\>/gi, '\n');
		md = md.replace(/<[^>]+>/g, '');
		md = md.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
		md = md.replace(/\n{3,}/g, '\n\n');
		return md.trim();
	}

	async syncBooks() {
		if (this.isSyncing) {
			new Notice('Sync already in progress...');
			return;
		}
		if (!this.settings.baseUrl) {
			new Notice('Please configure BookStack URL in settings');
			return;
		}
		const { tokenId, tokenSecret } = await this.getCredentials();
		if (!tokenId || !tokenSecret) {
			new Notice('Please configure BookStack API credentials in settings');
			return;
		}
		if (this.settings.selectedBooks.length === 0) {
			new Notice('No books selected for sync. Use "Select Books to Sync" command.');
			return;
		}

		this.isSyncing = true;
		new Notice('Starting BookStack sync...');
		try {
			const syncFolder = this.settings.syncFolder;
			await this.ensureFolderExists(syncFolder);
			let pullCount = 0;
			let pushCount = 0;
			let createCount = 0;
			let skipCount = 0;
			let errorCount = 0;

			for (const bookId of this.settings.selectedBooks) {
				const result = await this.syncBook(bookId, syncFolder);
				pullCount += result.pulled;
				pushCount += result.pushed;
				createCount += result.created;
				skipCount += result.skipped;
				errorCount += result.errors;
			}

			const summary: string[] = [];
			if (createCount > 0) summary.push(`${createCount} created`);
			if (pullCount > 0) summary.push(`${pullCount} pulled`);
			if (pushCount > 0) summary.push(`${pushCount} pushed`);
			if (skipCount > 0) summary.push(`${skipCount} skipped`);
			if (errorCount > 0) summary.push(`${errorCount} errors`);
			new Notice(`Sync complete: ${summary.join(', ')}`);
		} catch (error: any) {
			new Notice(`Sync failed: ${error.message}`);
			console.error('BookStack sync error:', error);
		} finally {
			this.isSyncing = false;
		}
	}

	async syncBook(bookId: number, basePath: string): Promise<{ pulled: number; pushed: number; created: number; skipped: number; errors: number }> {
		let pulled = 0, pushed = 0, created = 0, skipped = 0, errors = 0;
		try {
			const book = await this.getBook(bookId);
			const bookPath = `${basePath}/${this.sanitizeFileName(book.name)}`;
			await this.ensureFolderExists(bookPath);

			for (const content of book.contents) {
				if (content.type === 'chapter') {
					const result = await this.syncChapter(content.id, bookPath, book as BookDetail);
					pulled += result.pulled;
					pushed += result.pushed;
					created += result.created;
					skipped += result.skipped;
					errors += result.errors;
				} else if (content.type === 'page') {
					const result = await this.syncPage(content.id, bookPath, book as BookDetail);
					if (result === 'pulled') pulled++;
					else if (result === 'pushed') pushed++;
					else if (result === 'created') created++;
					else if (result === 'skipped') skipped++;
					else if (result === 'error') errors++;
				}
			}

			if (this.settings.syncMode !== 'pull-only') {
				const localResult = await this.syncLocalPages(bookPath, book as BookDetail);
				created += localResult.created;
				errors += localResult.errors;
			}
		} catch (error) {
			console.error(`Failed to sync book ${bookId}:`, error);
			errors++;
		}
		return { pulled, pushed, created, skipped, errors };
	}

	async syncChapter(chapterId: number, bookPath: string, book: BookDetail): Promise<{ pulled: number; pushed: number; created: number; skipped: number; errors: number }> {
		let pulled = 0, pushed = 0, created = 0, skipped = 0, errors = 0;
		try {
			const chapter = await this.getChapter(chapterId);
			const chapterPath = `${bookPath}/${this.sanitizeFileName(chapter.name)}`;
			await this.ensureFolderExists(chapterPath);

			if (chapter.pages) {
				for (const page of chapter.pages) {
					const result = await this.syncPage(page.id, chapterPath, book, chapter);
					if (result === 'pulled') pulled++;
					else if (result === 'pushed') pushed++;
					else if (result === 'created') created++;
					else if (result === 'skipped') skipped++;
					else if (result === 'error') errors++;
				}
			}

			if (this.settings.syncMode !== 'pull-only') {
				const localResult = await this.syncLocalPages(chapterPath, book, chapter);
				created += localResult.created;
				errors += localResult.errors;
			}
		} catch (error) {
			console.error(`Failed to sync chapter ${chapterId}:`, error);
			errors++;
		}
		return { pulled, pushed, created, skipped, errors };
	}

	async syncLocalPages(folderPath: string, book: BookDetail, chapter?: Chapter): Promise<{ created: number; errors: number }> {
		let created = 0;
		let errors = 0;
		try {
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!(folder instanceof TFolder)) {
				return { created, errors };
			}
			for (const file of folder.children) {
				if (!(file instanceof TFile) || file.extension !== 'md') continue;
				if (file.name === 'README.md') continue; // Skip README files

				const content = await this.app.vault.read(file);
				const { frontmatter, body } = this.extractFrontmatter(content);

				if (!frontmatter.bookstack_id) {
					try {
						console.log(`Creating new page in BookStack: ${file.basename}`);
						const newPage = await this.createPage(
							book.id,
							file.basename,
							body,
							chapter?.id
						);

						frontmatter.bookstack_id = newPage.id;
						frontmatter.book_id = book.id;
						frontmatter.chapter_id = chapter?.id ?? null;
						frontmatter.book_name = (book as Book).name;
						frontmatter.book_description = (book as Book).description;
						if (chapter) {
							frontmatter.chapter_name = chapter.name;
							frontmatter.chapter_description = chapter.description;
						}
						frontmatter.created = newPage.created_at;
						frontmatter.updated = newPage.updated_at;
						frontmatter.last_synced = new Date().toISOString();
						frontmatter.title = file.basename;

						const updatedContent = this.createFrontmatter(frontmatter) + body;
						await this.app.vault.modify(file, updatedContent);
						new Notice(`Created page in BookStack: ${file.basename}`);
						created++;
					} catch (error) {
						console.error(`Failed to create page ${file.basename}:`, error);
						new Notice(`Failed to create page: ${file.basename}`);
						errors++;
					}
				}
			}
		} catch (error) {
			console.error(`Failed to sync local pages in ${folderPath}:`, error);
			errors++;
		}
		return { created, errors };
	}

	async syncPage(pageId: number, parentPath: string, book: BookDetail, chapter?: Chapter): Promise<'pulled' | 'pushed' | 'created' | 'skipped' | 'error'> {
		try {
			const page = await this.getPage(pageId);
			const fileName = `${this.sanitizeFileName(page.name)}.md`;
			const filePath = `${parentPath}/${fileName}`;
			const existingFile = this.app.vault.getAbstractFileByPath(filePath);
			const remoteUpdated = new Date(page.updated_at);

			if (existingFile instanceof TFile) {
				const localContent = await this.app.vault.read(existingFile);
				const { frontmatter, body } = this.extractFrontmatter(localContent);
				const lastSynced = frontmatter.last_synced ? new Date(frontmatter.last_synced) : null;
				const localModified = new Date(existingFile.stat.mtime);
				const hasLocalChanges = !!lastSynced && (localModified > new Date(lastSynced.getTime() + 1000));

				if (this.settings.syncMode === 'pull-only') {
					if (lastSynced && remoteUpdated <= lastSynced) return 'skipped';
					await this.pullPage(page, filePath, book, chapter);
					return 'pulled';
				} else if (this.settings.syncMode === 'push-only') {
					if (hasLocalChanges) {
						await this.pushPage(page.id, body, page.name);
						await this.updateLocalSyncTime(existingFile, frontmatter, body);
						return 'pushed';
					}
					return 'skipped';
				} else {
					// Bidirectional
					if (hasLocalChanges && lastSynced) {
						if (remoteUpdated > lastSynced) {
							new Notice(`Conflict: ${page.name} changed in both places. Local changes preserved.`);
							return 'skipped';
						} else {
							await this.pushPage(page.id, body, page.name);
							await this.updateLocalSyncTime(existingFile, frontmatter, body);
							return 'pushed';
						}
					} else {
						if (!lastSynced || remoteUpdated > lastSynced) {
							await this.pullPage(page, filePath, book, chapter);
							return 'pulled';
						} else {
							return 'skipped';
						}
					}
				}
			} else {
				await this.pullPage(page, filePath, book, chapter);
				return 'pulled';
			}
		} catch (error) {
			console.error(`Failed to sync page ${pageId}:`, error);
			return 'error';
		}
	}

	async pullPage(page: Page, filePath: string, book: BookDetail, chapter?: Chapter): Promise<void> {
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
			book_id: book.id,
			chapter_id: chapter?.id ?? null,
			book_name: (book as Book).name,
			book_description: (book as Book).description,
			created: page.created_at,
			updated: page.updated_at,
			last_synced: new Date().toISOString()
		};

		if (chapter) {
			metadata.chapter_name = chapter.name;
			metadata.chapter_description = chapter.description;
		}

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

	async testConnection(): Promise<void> {
		new Notice('Testing BookStack connection...');

		if (!this.settings.baseUrl) {
			new Notice('❌ BookStack URL is not configured');
			return;
		}

		let tokenId: string | null;
		let tokenSecret: string | null;
		try {
			({ tokenId, tokenSecret } = await this.getCredentials());
		} catch (err) {
			console.error('[BookStack] SecretStorage error', err);
			new Notice('❌ Failed to read secrets from Obsidian SecretStorage');
			return;
		}
		if (!tokenId || !tokenSecret) {
			new Notice('❌ API credentials are missing or inaccessible');
			return;
		}

		console.log('[BookStack] Test connection environment', {
			baseUrl: this.settings.baseUrl,
			isMobile: this.isMobile,
			hasTokenId: !!tokenId,
			hasTokenSecret: !!tokenSecret
		});

		try {
			const start = performance.now();
			const response = await this.makeRequest('books');
			const duration = Math.round(performance.now() - start);
			if (!response || !Array.isArray(response.data)) {
				console.error('[BookStack] Unexpected API response', response);
				new Notice('⚠️ Connected, but received an unexpected API response');
				return;
			}
			new Notice(
				`✅ Connection successful\n` +
				`Books visible: ${response.data.length}\n` +
				`Platform: ${this.isMobile ? 'Mobile' : 'Desktop'}\n` +
				`Latency: ${duration} ms`
			);
			console.log('[BookStack] Connection test successful', {
				bookCount: response.data.length,
				latencyMs: duration
			});
		} catch (error: any) {
			const message = error instanceof Error ? error.message : String(error);
			console.error('[BookStack] Connection test failed', {
				error,
				isMobile: this.isMobile,
				baseUrl: this.settings.baseUrl
			});
			let hint = '';
			if (message.includes('Failed to fetch')) {
				hint = 'Network request failed.\n' +
					'• Check HTTPS certificate\n' +
					'• Check CORS settings\n' +
					'• Mobile apps require public HTTPS endpoints';
			} else if (message.includes('401') || message.includes('403')) {
				hint = 'Authentication failed.\n' +
					'• Verify API token permissions\n' +
					'• Ensure token belongs to a non-disabled user';
			}
			new Notice(`❌ Connection failed\n\n${message}${hint ? `\n\n${hint}` : ''}\n\nSee console for details`);
		}
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
					if (checkbox.checked) this.selectedBooks.add(book.id);
					else this.selectedBooks.delete(book.id);
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
		} catch (error: any) {
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
				})
			);

		new Setting(containerEl)
			.setName('API Token ID')
			.setDesc('Select or create a secret for your BookStack API token ID')
			.addComponent(el => new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.tokenIdSecret)
				.onChange(async (value) => {
					this.plugin.settings.tokenIdSecret = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('API Token Secret')
			.setDesc('Select or create a secret for your BookStack API token secret')
			.addComponent(el => new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.tokenSecretSecret)
				.onChange(async (value) => {
					this.plugin.settings.tokenSecretSecret = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Sync Folder')
			.setDesc('Folder where BookStack content will be synced')
			.addText(text => text
				.setPlaceholder('BookStack')
				.setValue(this.plugin.settings.syncFolder)
				.onChange(async (value) => {
					this.plugin.settings.syncFolder = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Show Descriptions in Frontmatter')
			.setDesc('Include book and chapter descriptions in page frontmatter instead of separate README files')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showDescriptionsInFrontmatter)
				.onChange(async (value) => {
					this.plugin.settings.showDescriptionsInFrontmatter = value;
					await this.plugin.saveSettings();
				})
			);

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
				})
			);

		new Setting(containerEl)
			.setName('Auto Sync')
			.setDesc('Automatically sync books at regular intervals')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
					if (value) this.plugin.startAutoSync(); else this.plugin.stopAutoSync();
				})
			);

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
						if (this.plugin.settings.autoSync) this.plugin.startAutoSync();
					}
				})
			);

		containerEl.createEl('h3', { text: 'How to get API credentials' });
		containerEl.createEl('p', { text: '1. Log into your BookStack instance' });
		containerEl.createEl('p', { text: '2. Go to your profile settings' });
		containerEl.createEl('p', { text: '3. Scroll to "API Tokens" section' });
		containerEl.createEl('p', { text: '4. Create a new token and copy the ID and Secret' });
		containerEl.createEl('p', { text: '5. Use the dropdowns above to create new secrets or select existing ones' });

		containerEl.createEl('h3', { text: 'About Sync Modes' });
		containerEl.createEl('p', { text: 'Bidirectional: Compares timestamps and syncs in the direction of the most recent change. If both changed, local is preserved. Creates new pages in BookStack when you add .md files locally.' });
		containerEl.createEl('p', { text: 'Pull Only: Only downloads changes from BookStack, never uploads local changes or creates new pages.' });
		containerEl.createEl('p', { text: 'Push Only: Only uploads local changes to BookStack and creates new pages from local .md files, never downloads remote changes.' });

		containerEl.createEl('h3', { text: 'About Descriptions' });
		containerEl.createEl('p', { text: 'When "Show Descriptions in Frontmatter" is enabled, book and chapter descriptions are stored in each page\'s frontmatter (book_description, chapter_description fields). This eliminates the need for separate README.md files and keeps all metadata with each page.' });

		containerEl.createEl('h3', { text: 'Creating New Pages' });
		containerEl.createEl('p', { text: 'To create a new page in BookStack: Simply create a new .md file in a book or chapter folder. During the next sync, the plugin will automatically create the page in BookStack and add the bookstack_id to the frontmatter.' });

		containerEl.createEl('h3', { text: 'About SecretStorage' });
		containerEl.createEl('p', { text: 'This plugin uses Obsidian\'s SecretStorage to securely store your API credentials. Secrets are stored separately from plugin settings and can be shared across multiple plugins. You can manage all your secrets in Settings → About → Manage secrets.' });
	}
}
