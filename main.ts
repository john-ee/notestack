import { App, Plugin, PluginSettingTab, Setting, Notice, TFolder, TFile, Modal, SecretComponent, requestUrl } from 'obsidian';

interface BookStackSettings {
	baseUrl: string;
	tokenIdSecret: string;
	tokenSecretSecret: string;
	syncFolder: string;
	syncSelection: {
		[bookId: number]: {
			mode: 'full' | 'chapters';
			chapterIds?: number[];
		}
	};
	autoSync: boolean;
	syncInterval: number;
	syncMode: 'pull-only' | 'push-only' | 'bidirectional';
	// FIX 4: Persisted map of vault folder path → BookStack chapter ID.
	// Keyed by the folder's full vault-relative path (e.g. "BookStack/My Book/My Chapter").
	// Populated when a new chapter is created from a local folder, and checked
	// before creating a chapter so we never create duplicates across sync runs.
	knownChapterFolders: { [folderPath: string]: number };
}

const DEFAULT_SETTINGS: BookStackSettings = {
	baseUrl: '',
	tokenIdSecret: '',
	tokenSecretSecret: '',
	syncFolder: 'BookStack',
	syncSelection: {},
	autoSync: false,
	syncInterval: 60,
	syncMode: 'bidirectional',
	knownChapterFolders: {}
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
	// FIX 3: Hash of page body at last sync/push for change detection.
	body_hash?: string;
}

export default class BookStackSyncPlugin extends Plugin {
	settings: BookStackSettings;
	syncIntervalId: number | null = null;
	private isSyncing: boolean = false;
	private bookFolderCache: Map<number, string> = new Map();
	private chapterFolderCache: Map<number, string> = new Map();
	private pageFolderCache: Map<number, TFile> = new Map();

	// Constants
	private readonly README_FILENAME = 'README.md';
	private readonly MARKDOWN_EXTENSION = 'md';

	private get isMobile(): boolean {
		return (this.app as any).isMobile ?? false;
	}

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('folder-sync', 'BookStack Sync', async () => {
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
			id: 'pull-from-bookstack',
			name: 'Pull from BookStack (Download only)',
			callback: async () => {
				if (this.isSyncing) {
					new Notice('Sync already in progress...');
					return;
				}
				this.isSyncing = true;
	
				// Clear caches at start of sync
				this.bookFolderCache.clear();
				this.chapterFolderCache.clear();
				this.pageFolderCache.clear();
				try {
					await this.pullFromBookStack();
				} finally {
					this.isSyncing = false;
				}
			}
		});

		this.addCommand({
			id: 'push-to-bookstack',
			name: 'Push to BookStack (Upload only)',
			callback: async () => {
				if (this.isSyncing) {
					new Notice('Sync already in progress...');
					return;
				}
				this.isSyncing = true;
				try {
					await this.pushToBookStack();
				} finally {
					this.isSyncing = false;
				}
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

	async createChapter(bookId: number, name: string, description?: string): Promise<Chapter> {
		const createData: any = {
			book_id: bookId,
			name: name,
			description: description || ''
		};
		return await this.makeRequest('chapters', 'POST', createData);
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
			} else if (['title', 'book_name', 'chapter_name', 'book_description', 'chapter_description', 'created', 'updated', 'last_synced', 'body_hash'].includes(key)) {
				(frontmatter as any)[key] = value as any;
			}
		});

		return { frontmatter, body };
	}

	async extractFrontmatterOnly(file: TFile): Promise<PageFrontmatter> {
		const content = await this.app.vault.read(file);
		
		// Quick check: does it start with ---?
		if (!content.startsWith('---\n')) {
			return {};
		}
		
		// Find the end of frontmatter (second ---)
		const endIndex = content.indexOf('\n---\n', 4);
		if (endIndex === -1) {
			return {};
		}
		
		// Extract only frontmatter section
		const frontmatterSection = content.substring(0, endIndex + 5);
		const { frontmatter } = this.extractFrontmatter(frontmatterSection + '\n');
		
		return frontmatter;
	}

	createFrontmatter(metadata: PageFrontmatter): string {
		let fm = '---\n';
		fm += `title: ${metadata.title ?? 'Untitled'}\n`;
		fm += `bookstack_id: ${metadata.bookstack_id ?? ''}\n`;
		fm += `book_id: ${metadata.book_id ?? ''}\n`;
		fm += `chapter_id: ${metadata.chapter_id !== undefined ? metadata.chapter_id : ''}\n`;
		
		// Always include descriptions in frontmatter
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
		
		fm += `created: ${metadata.created ?? ''}\n`;
		fm += `updated: ${metadata.updated ?? ''}\n`;
		fm += `last_synced: ${metadata.last_synced ?? ''}\n`;
		if (metadata.body_hash) {
			fm += `body_hash: ${metadata.body_hash}\n`;
		}
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

	stripLeadingTitleFromBody(body: string, title: string): string {
		if (!body || !title) return body;
		
		const lines = body.split('\n');
		if (lines.length === 0) return body;

		// Normalize and compare
		const firstLine = lines[0].trim();
		const normalizedTitle = title.trim();
		
		// Check various h1 formats: "# Title", "#Title", "#  Title"
		const h1Regex = /^#\s+(.+)$/;
		const match = firstLine.match(h1Regex);
		
		if (match) {
			const headingText = match[1].trim();
			// Case-insensitive comparison
			if (headingText.toLowerCase() === normalizedTitle.toLowerCase()) {
				// Remove heading and following blank lines
				let startIndex = 1;
				while (startIndex < lines.length && lines[startIndex].trim() === '') {
					startIndex++;
				}
				return lines.slice(startIndex).join('\n');
			}
		}

		return body;
	}

	hashBody(body: string): string {
		// Trim before hashing so leading/trailing whitespace differences
		// (e.g. the extra newline extractFrontmatter captures after ---)
		// never cause a false hash mismatch between write and read.
		const normalized = body.trim();
		let hash = 5381;
		for (let i = 0; i < normalized.length; i++) {
			hash = ((hash << 5) + hash) ^ normalized.charCodeAt(i);
			hash = hash >>> 0;
		}
		return hash.toString(16).padStart(8, '0');
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
		if (Object.keys(this.settings.syncSelection).length === 0) {
			new Notice('No books or chapters selected for sync. Use "Select Books to Sync" command.');
			return;
		}

		this.isSyncing = true;
		
		// Clear all caches at start of sync to ensure fresh state
		this.bookFolderCache.clear();
		this.chapterFolderCache.clear();
		this.pageFolderCache.clear();
		
		try {
			switch (this.settings.syncMode) {
				case 'pull-only':
					await this.pullFromBookStack();
					break;
				case 'push-only':
					await this.pushToBookStack();
					break;
				case 'bidirectional':
					await this.bidirectionalSync();
					break;
			}
		} catch (error: any) {
			new Notice(`Sync failed: ${error.message}`);
			console.error('BookStack sync error:', error);
		} finally {
			this.isSyncing = false;
		}
	}

	async pullFromBookStack() {
		new Notice('Pulling from BookStack...');
		// Clear caches at start
		this.bookFolderCache.clear();
		this.chapterFolderCache.clear();
		this.pageFolderCache.clear();
		
		const syncFolder = this.settings.syncFolder;
		await this.ensureFolderExists(syncFolder);
		
		let pullCount = 0;
		let skipCount = 0;
		let errorCount = 0;

		for (const [bookIdStr, selection] of Object.entries(this.settings.syncSelection)) {
			const bookId = Number(bookIdStr);
			try {
				if (selection.mode === 'full') {
					const result = await this.pullBook(bookId, syncFolder);
					pullCount += result.pulled;
					skipCount += result.skipped;
					errorCount += result.errors;
				} else {
					const book = await this.getBook(bookId);
					const bookPath = await this.findOrCreateFolderWithRename(
						bookId,
						book.name,
						syncFolder,
						(id, parent) => this.findBookFolderByBookId(id, parent),
						'book'
					);
					
					for (const chapterId of selection.chapterIds || []) {
						const result = await this.pullChapter(chapterId, bookPath, book);
						pullCount += result.pulled;
						skipCount += result.skipped;
						errorCount += result.errors;
					}
				}
			} catch (error) {
				console.error(`Error pulling book ${bookId}:`, error);
				errorCount++;
			}
		}

		const summary: string[] = [];
		if (pullCount > 0) summary.push(`${pullCount} pulled`);
		if (skipCount > 0) summary.push(`${skipCount} skipped`);
		if (errorCount > 0) summary.push(`${errorCount} errors`);
		new Notice(`Pull complete: ${summary.join(', ')}`);
	}

	async pushToBookStack() {
		new Notice('Pushing to BookStack...');
		// Clear caches at start
		this.bookFolderCache.clear();
		this.chapterFolderCache.clear();
		this.pageFolderCache.clear();
		
		const syncFolder = this.settings.syncFolder;
		await this.ensureFolderExists(syncFolder);
		
		let pushCount = 0;
		let createCount = 0;
		let skipCount = 0;
		let errorCount = 0;

		for (const [bookIdStr, selection] of Object.entries(this.settings.syncSelection)) {
			const bookId = Number(bookIdStr);
			try {
				if (selection.mode === 'full') {
					const result = await this.pushBook(bookId, syncFolder);
					pushCount += result.pushed;
					createCount += result.created;
					skipCount += result.skipped;
					errorCount += result.errors;
				} else {
					const book = await this.getBook(bookId);
					const bookPath = await this.findOrCreateFolderWithRename(
						bookId,
						book.name,
						syncFolder,
						(id, parent) => this.findBookFolderByBookId(id, parent),
						'book'
					);
					
					for (const chapterId of selection.chapterIds || []) {
						const result = await this.pushChapter(chapterId, bookPath, book);
						pushCount += result.pushed;
						skipCount += result.skipped;
						errorCount += result.errors;
					}
				}
			} catch (error) {
				console.error(`Error pushing book ${bookId}:`, error);
				errorCount++;
			}
		}

		const summary: string[] = [];
		if (createCount > 0) summary.push(`${createCount} created`);
		if (pushCount > 0) summary.push(`${pushCount} pushed`);
		if (skipCount > 0) summary.push(`${skipCount} skipped`);
		if (errorCount > 0) summary.push(`${errorCount} errors`);
		new Notice(`Push complete: ${summary.join(', ')}`);
	}

	async bidirectionalSync() {
		new Notice('Starting bidirectional sync...');
		// Clear caches at start
		this.bookFolderCache.clear();
		this.chapterFolderCache.clear();
		this.pageFolderCache.clear();
		
		const syncFolder = this.settings.syncFolder;
		await this.ensureFolderExists(syncFolder);
		
		let pullCount = 0;
		let pushCount = 0;
		let createCount = 0;
		let skipCount = 0;
		let errorCount = 0;

		for (const [bookIdStr, selection] of Object.entries(this.settings.syncSelection)) {
			const bookId = Number(bookIdStr);
			try {
				if (selection.mode === 'full') {
					const result = await this.syncBookBidirectional(bookId, syncFolder);
					pullCount += result.pulled;
					pushCount += result.pushed;
					createCount += result.created;
					skipCount += result.skipped;
					errorCount += result.errors;
				} else {
					const book = await this.getBook(bookId);
					const bookPath = await this.findOrCreateFolderWithRename(
						bookId,
						book.name,
						syncFolder,
						(id, parent) => this.findBookFolderByBookId(id, parent),
						'book'
					);
					
					for (const chapterId of selection.chapterIds || []) {
						const result = await this.syncChapterBidirectional(chapterId, bookPath, book);
						pullCount += result.pulled;
						pushCount += result.pushed;
						createCount += result.created;
						skipCount += result.skipped;
						errorCount += result.errors;
					}
				}
			} catch (error) {
				console.error(`Error syncing book ${bookId}:`, error);
				errorCount++;
			}
		}

		const summary: string[] = [];
		if (createCount > 0) summary.push(`${createCount} created`);
		if (pullCount > 0) summary.push(`${pullCount} pulled`);
		if (pushCount > 0) summary.push(`${pushCount} pushed`);
		if (skipCount > 0) summary.push(`${skipCount} skipped`);
		if (errorCount > 0) summary.push(`${errorCount} errors`);
		new Notice(`Sync complete: ${summary.join(', ')}`);
	}

	async pullBook(bookId: number, basePath: string): Promise<{ pulled: number; skipped: number; errors: number }> {
		let pulled = 0, skipped = 0, errors = 0;
		try {
			const book = await this.getBook(bookId);
			const bookPath = await this.findOrCreateFolderWithRename(
				bookId,
				book.name,
				basePath,
				(id, parent) => this.findBookFolderByBookId(id, parent),
				'book'
			);

			// FIX 8: Track all remote page IDs to detect orphaned local files.
			const remotePageIds = new Set<number>();

			for (const content of book.contents) {
				if (content.type === 'chapter') {
					const chapter = await this.getChapter(content.id);
					chapter.pages?.forEach(p => remotePageIds.add(p.id));
					const result = await this.pullChapter(content.id, bookPath, book as BookDetail);
					pulled += result.pulled;
					skipped += result.skipped;
					errors += result.errors;
				} else if (content.type === 'page') {
					remotePageIds.add(content.id);
					const result = await this.pullPageSync(content.id, bookPath, book as BookDetail);
					switch (result) {
						case 'pulled': pulled++; break;
						case 'skipped': skipped++; break;
						case 'error': errors++; break;
					}
				}
			}

			// FIX 8: Retire orphaned local pages deleted from BookStack.
			const retired = await this.retireDeletedPages(bookPath, remotePageIds);
			if (retired > 0) console.log(`[BookStack] Retired ${retired} deleted page(s) from book ${bookId}`);

		} catch (error) {
			this.handleSyncError(`Failed to pull book ${bookId}`, error);
			errors++;
		}
		return { pulled, skipped, errors };
	}

	async pushBook(bookId: number, basePath: string): Promise<{ pushed: number; created: number; skipped: number; errors: number }> {
		let pushed = 0, created = 0, skipped = 0, errors = 0;
		try {
			const book = await this.getBook(bookId);
			const bookPath = await this.findOrCreateFolderWithRename(
				bookId,
				book.name,
				basePath,
				(id, parent) => this.findBookFolderByBookId(id, parent),
				'book'
			);

			// Push existing pages
			for (const content of book.contents) {
				if (content.type === 'chapter') {
					const result = await this.pushChapter(content.id, bookPath, book as BookDetail);
					pushed += result.pushed;
					skipped += result.skipped;
					errors += result.errors;
				} else if (content.type === 'page') {
					const result = await this.pushPageSync(content.id, bookPath, book as BookDetail);
					switch (result) {
						case 'pushed': pushed++; break;
						case 'skipped': skipped++; break;
						case 'error': errors++; break;
					}
				}
			}

			// Create new pages from local files
			const localResult = await this.syncLocalPages(bookPath, book as BookDetail);
			created += localResult.created;
			errors += localResult.errors;
		} catch (error) {
			this.handleSyncError(`Failed to push book ${bookId}`, error);
			errors++;
		}
		return { pushed, created, skipped, errors };
	}

	async syncBookBidirectional(bookId: number, basePath: string): Promise<{ pulled: number; pushed: number; created: number; skipped: number; errors: number }> {
		let pulled = 0, pushed = 0, created = 0, skipped = 0, errors = 0;
		try {
			const book = await this.getBook(bookId);
			const bookPath = await this.findOrCreateFolderWithRename(
				bookId,
				book.name,
				basePath,
				(id, parent) => this.findBookFolderByBookId(id, parent),
				'book'
			);

			// FIX 8: Track all remote page IDs to detect orphaned local files.
			const remotePageIds = new Set<number>();

			for (const content of book.contents) {
				if (content.type === 'chapter') {
					const chapter = await this.getChapter(content.id);
					chapter.pages?.forEach(p => remotePageIds.add(p.id));
					const result = await this.syncChapterBidirectional(content.id, bookPath, book as BookDetail);
					pulled += result.pulled;
					pushed += result.pushed;
					created += result.created;
					skipped += result.skipped;
					errors += result.errors;
				} else if (content.type === 'page') {
					remotePageIds.add(content.id);
					const result = await this.syncPageBidirectional(content.id, bookPath, book as BookDetail);
					switch (result) {
						case 'pulled': pulled++; break;
						case 'pushed': pushed++; break;
						case 'created': created++; break;
						case 'skipped': skipped++; break;
						case 'error': errors++; break;
					}
				}
			}

			// Create new local pages
			const localResult = await this.syncLocalPages(bookPath, book as BookDetail);
			created += localResult.created;
			errors += localResult.errors;

			// FIX 8: Retire orphaned local pages deleted from BookStack.
			const retired = await this.retireDeletedPages(bookPath, remotePageIds);
			if (retired > 0) console.log(`[BookStack] Retired ${retired} deleted page(s) from book ${bookId}`);

		} catch (error) {
			this.handleSyncError(`Failed to sync book ${bookId}`, error);
			errors++;
		}
		return { pulled, pushed, created, skipped, errors };
	}

	async pullChapter(chapterId: number, bookPath: string, book: BookDetail): Promise<{ pulled: number; skipped: number; errors: number }> {
		let pulled = 0, skipped = 0, errors = 0;
		try {
			const chapter = await this.getChapter(chapterId);
			const chapterPath = await this.findOrCreateFolderWithRename(
				chapterId,
				chapter.name,
				bookPath,
				(id, parent) => this.findChapterFolderByChapterId(id, parent),
				'chapter'
			);

			// FIX 4: Register the resolved folder path so handlePotentialNewChapter
			// never mistakes this existing chapter for a new one on future syncs.
			if (this.settings.knownChapterFolders[chapterPath] !== chapterId) {
				this.settings.knownChapterFolders[chapterPath] = chapterId;
				await this.saveSettings();
			}

			if (chapter.pages) {
				for (const page of chapter.pages) {
					const result = await this.pullPageSync(page.id, chapterPath, book, chapter);
					switch (result) {
						case 'pulled': pulled++; break;
						case 'skipped': skipped++; break;
						case 'error': errors++; break;
					}
				}
			}
		} catch (error) {
			this.handleSyncError(`Failed to pull chapter ${chapterId}`, error);
			errors++;
		}
		return { pulled, skipped, errors };
	}

	async pushChapter(chapterId: number, bookPath: string, book: BookDetail): Promise<{ pushed: number; skipped: number; errors: number }> {
		let pushed = 0, skipped = 0, errors = 0;
		try {
			const chapter = await this.getChapter(chapterId);
			const chapterPath = await this.findOrCreateFolderWithRename(
				chapterId,
				chapter.name,
				bookPath,
				(id, parent) => this.findChapterFolderByChapterId(id, parent),
				'chapter'
			);

			// FIX 4: Keep the known-chapters map current so handlePotentialNewChapter
			// never re-creates this chapter from a local folder on future syncs.
			if (this.settings.knownChapterFolders[chapterPath] !== chapterId) {
				this.settings.knownChapterFolders[chapterPath] = chapterId;
				await this.saveSettings();
			}

			if (chapter.pages) {
				for (const page of chapter.pages) {
					const result = await this.pushPageSync(page.id, chapterPath, book, chapter);
					switch (result) {
						case 'pushed': pushed++; break;
						case 'skipped': skipped++; break;
						case 'error': errors++; break;
					}
				}
			}

			// Create new pages from local files
			const localResult = await this.syncLocalPages(chapterPath, book, chapter);
			errors += localResult.errors;
		} catch (error) {
			this.handleSyncError(`Failed to push chapter ${chapterId}`, error);
			errors++;
		}
		return { pushed, skipped, errors };
	}

	async syncChapterBidirectional(chapterId: number, bookPath: string, book: BookDetail): Promise<{ pulled: number; pushed: number; created: number; skipped: number; errors: number }> {
		let pulled = 0, pushed = 0, created = 0, skipped = 0, errors = 0;
		try {
			const chapter = await this.getChapter(chapterId);
			const chapterPath = await this.findOrCreateFolderWithRename(
				chapterId,
				chapter.name,
				bookPath,
				(id, parent) => this.findChapterFolderByChapterId(id, parent),
				'chapter'
			);

			// FIX 4: Keep the known-chapters map current so handlePotentialNewChapter
			// never re-creates this chapter from a local folder on future syncs.
			if (this.settings.knownChapterFolders[chapterPath] !== chapterId) {
				this.settings.knownChapterFolders[chapterPath] = chapterId;
				await this.saveSettings();
			}

			if (chapter.pages) {
				for (const page of chapter.pages) {
					const result = await this.syncPageBidirectional(page.id, chapterPath, book, chapter);
					switch (result) {
						case 'pulled': pulled++; break;
						case 'pushed': pushed++; break;
						case 'created': created++; break;
						case 'skipped': skipped++; break;
						case 'error': errors++; break;
					}
				}
			}

			// Create new local pages
			const localResult = await this.syncLocalPages(chapterPath, book, chapter);
			created += localResult.created;
			errors += localResult.errors;
		} catch (error) {
			this.handleSyncError(`Failed to sync chapter ${chapterId}`, error);
			errors++;
		}
		return { pulled, pushed, created, skipped, errors };
	}

	// ─────────────────────────────────────────────────────────────
	// FIX 1: syncLocalPages
	//
	// BEFORE: the code read the raw file into `content`, extracted
	// frontmatter/body, but then passed `body` directly to createPage.
	// The problem was twofold:
	//   a) `body` was never stripped of its leading title (H1), so
	//      BookStack received a duplicate title as the first line of
	//      the page content.
	//   b) For files with no frontmatter block, `extractFrontmatter`
	//      returned the full raw file as `body`, meaning any accidental
	//      `---` separator in the content could corrupt parsing.
	//
	// AFTER: `body` (already correctly extracted by extractFrontmatter)
	// is now passed through `stripLeadingTitleFromBody` before being
	// sent to `createPage`, exactly mirroring what the push path does.
	// This ensures no duplicate H1 title is uploaded and the content
	// sent is always the clean body portion only.
	// ─────────────────────────────────────────────────────────────
	async syncLocalPages(folderPath: string, book: BookDetail, chapter?: Chapter): Promise<{ created: number; errors: number }> {
		let created = 0;
		let errors = 0;
		try {
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!(folder instanceof TFolder)) {
				return { created, errors };
			}

			// First, handle subdirectories (potential new chapters)
			for (const item of folder.children) {
				if (item instanceof TFolder) {
					if (!chapter) {
						await this.handlePotentialNewChapter(item, book);
					}
				}
			}

			// Then handle files in this folder
			for (const file of folder.children) {
				if (!(file instanceof TFile) || this.shouldSkipFile(file)) continue;

				const content = await this.app.vault.read(file);
				const { frontmatter, body } = this.extractFrontmatter(content);

				if (!frontmatter.bookstack_id) {
					try {
						console.log(`Creating new page in BookStack: ${file.basename}`);

						// FIX 1: Strip leading H1 title from body before uploading,
						// matching behaviour of the push path. Without this, BookStack
						// would receive the page title both in the `name` field and as
						// an H1 at the top of the content, displaying it twice.
						const cleanedBody = this.stripLeadingTitleFromBody(body, file.basename);

						const newPage = await this.createPage(
							book.id,
							file.basename,
							cleanedBody,   // ← was `body` before this fix
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
						// Trim body so the file, the hash, and future reads are all consistent.
						// extractFrontmatter captures the extra \n after --- as part of body,
						// so writing the raw body would accumulate blank lines on each sync.
						const trimmedBody = body.trim();
						frontmatter.body_hash = this.hashBody(trimmedBody);
						frontmatter.title = file.basename;

						const updatedContent = this.createFrontmatter(frontmatter) + trimmedBody;
						await this.app.vault.modify(file, updatedContent);
						new Notice(`Created page in BookStack: ${file.basename}`);
						created++;
					} catch (error) {
						this.handleSyncError(`Failed to create page ${file.basename}`, error);
						new Notice(`Failed to create page: ${file.basename}`);
						errors++;
					}
				}
			}
		} catch (error) {
			this.handleSyncError(`Failed to sync local pages in ${folderPath}`, error);
			errors++;
		}
		return { created, errors };
	}

	// ─────────────────────────────────────────────────────────────
	// FIX 4: handlePotentialNewChapter
	//
	// BEFORE: the code detected whether a folder already corresponded to
	// a BookStack chapter by scanning every .md file inside it and reading
	// its chapter_id frontmatter. This had two problems:
	//   a) An empty folder (no .md files yet) would always look like a new
	//      chapter and attempt to create one in BookStack on every sync run.
	//   b) Any folder containing .md files without chapter_id frontmatter
	//      (e.g. notes the user placed manually) would also trigger repeated
	//      chapter creation attempts.
	//
	// AFTER: instead of scanning file frontmatter, we maintain a persisted
	// map `knownChapterFolders` in plugin settings (saved to disk via
	// saveSettings). The key is the folder's full vault-relative path;
	// the value is the BookStack chapter ID.
	//
	// On every call we check this map first. If the folder path is already
	// registered, we skip creation entirely — no file scanning needed.
	// When we do create a new chapter, we immediately register the folder
	// path in the map and persist it, so future syncs won't re-create it.
	//
	// No extra files are created in the vault. The map lives exclusively
	// in plugin data alongside the rest of the settings.
	// ─────────────────────────────────────────────────────────────
	async handlePotentialNewChapter(folder: TFolder, book: BookDetail): Promise<void> {
		const folderName = folder.name;
		const folderPath = folder.path;

		// FIX 4: Check the persisted map first — no file scanning required.
		// If this folder path is already registered, it was created in a
		// previous sync run. Skip it entirely.
		const knownChapterId = this.settings.knownChapterFolders[folderPath];
		if (knownChapterId !== undefined) {
			console.log(`[BookStack] Known chapter folder: ${folderPath} (ID: ${knownChapterId})`);
			return;
		}

		// Folder is not in the map. Check file frontmatter as a secondary
		// guard — handles the case where the map was cleared or the plugin
		// was reinstalled but files from a previous sync still exist.
		for (const file of folder.children) {
			if (file instanceof TFile && file.extension === 'md') {
				const frontmatter = await this.extractFrontmatterOnly(file);
				if (frontmatter.chapter_id) {
					// Register it now so future syncs use the fast path
					this.settings.knownChapterFolders[folderPath] = frontmatter.chapter_id;
					await this.saveSettings();
					console.log(`[BookStack] Retroactively registered chapter folder: ${folderPath} (ID: ${frontmatter.chapter_id})`);
					return;
				}
			}
		}

		// Neither the map nor any file frontmatter recognises this folder.
		// This is a genuinely new chapter the user created locally.
		try {
			console.log(`[BookStack] Creating new chapter in BookStack: ${folderName}`);
			const newChapter = await this.createChapter(book.id, folderName);
			new Notice(`Created chapter in BookStack: ${folderName}`);

			// FIX 4: Register immediately so the next sync (including the
			// recursive syncLocalPages call below) treats this as known.
			this.settings.knownChapterFolders[folderPath] = newChapter.id;
			await this.saveSettings();

			const chapterResult = await this.syncLocalPages(folder.path, book, newChapter);
			console.log(`[BookStack] Synced ${chapterResult.created} pages in new chapter ${folderName}`);
		} catch (error) {
			this.handleSyncError(`Failed to create chapter ${folderName}`, error);
			new Notice(`Failed to create chapter: ${folderName}`);
		}
	}


	async pullPageSync(pageId: number, parentPath: string, book: BookDetail, chapter?: Chapter): Promise<'pulled' | 'skipped' | 'error'> {
		try {
			const page = await this.getPage(pageId);
			
			let existingFile = await this.findFileByBookStackId(pageId, parentPath);
			
			if (existingFile) {
				existingFile = await this.renameFileIfNeeded(existingFile, page.name, parentPath);
			}
		
			const expectedFilePath = `${parentPath}/${this.sanitizeFileName(page.name)}.md`;
			
			const remoteUpdated = new Date(page.updated_at);

			if (existingFile instanceof TFile) {
				const localContent = await this.app.vault.read(existingFile);
				const { frontmatter } = this.extractFrontmatter(localContent);
				const lastSynced = frontmatter.last_synced ? new Date(frontmatter.last_synced) : null;

				if (lastSynced && remoteUpdated <= lastSynced) {
					return 'skipped';
				}
			}

			await this.pullPage(page, expectedFilePath, book, chapter);
			return 'pulled';
		} catch (error) {
			console.error(`Failed to pull page ${pageId}:`, error);
			return 'error';
		}
	}

	async pushPageSync(pageId: number, parentPath: string, book: BookDetail, chapter?: Chapter): Promise<'pushed' | 'skipped' | 'error'> {
		try {
			const page = await this.getPage(pageId);
			
			let existingFile = await this.findFileByBookStackId(pageId, parentPath);
			
			if (!existingFile) {
				return 'skipped';
			}
			
			existingFile = await this.renameFileIfNeeded(existingFile, page.name, parentPath);

			const localContent = await this.app.vault.read(existingFile);
			const { frontmatter, body } = this.extractFrontmatter(localContent);
			// FIX 3: Use body hash to detect local changes, not mtime.
			// If no hash is stored (file predates this fix), fall back to mtime
			// so those files are not silently skipped forever.
			const storedHash = frontmatter.body_hash;
			const currentHash = this.hashBody(body);
			let hasLocalChanges: boolean;
			if (storedHash) {
				hasLocalChanges = storedHash !== currentHash;
			} else {
				// Legacy fallback for files without a stored hash.
				const lastSynced = frontmatter.last_synced ? new Date(frontmatter.last_synced) : null;
				const localModified = new Date(existingFile.stat.mtime);
				hasLocalChanges = !!lastSynced && localModified.getTime() > lastSynced.getTime() + 2000;
			}

			if (hasLocalChanges) {
				const cleanedBody = this.stripLeadingTitleFromBody(body, page.name);
				await this.pushPage(page.id, cleanedBody, page.name);
				await this.updateLocalSyncTime(existingFile, frontmatter, body);
				return 'pushed';
			}

			return 'skipped';
		} catch (error) {
			console.error(`Failed to push page ${pageId}:`, error);
			return 'error';
		}
	}

	async syncPageBidirectional(pageId: number, parentPath: string, book: BookDetail, chapter?: Chapter): Promise<'pulled' | 'pushed' | 'created' | 'skipped' | 'error'> {
		try {
			const page = await this.getPage(pageId);
			
			let existingFile = await this.findFileByBookStackId(pageId, parentPath);
			
			if (existingFile) {
				existingFile = await this.renameFileIfNeeded(existingFile, page.name, parentPath);
			}
		
		const expectedFilePath = `${parentPath}/${this.sanitizeFileName(page.name)}.md`;
			
			const remoteUpdated = new Date(page.updated_at);

			if (existingFile instanceof TFile) {
				const localContent = await this.app.vault.read(existingFile);
				const { frontmatter, body } = this.extractFrontmatter(localContent);
				const lastSynced = frontmatter.last_synced ? new Date(frontmatter.last_synced) : null;

				// FIX 3: Use body hash to detect local changes, not mtime.
				// If no hash is stored (file predates this fix), fall back to mtime
				// vs last_synced so those files are not silently skipped forever.
				const storedHash = frontmatter.body_hash;
				const currentHash = this.hashBody(body);
				// localModified is always computed — used by ConflictResolutionModal.
				const localModified = new Date(existingFile.stat.mtime);
				let hasLocalChanges: boolean;
				if (storedHash) {
					hasLocalChanges = storedHash !== currentHash;
				} else {
					// Legacy fallback for files without a stored hash.
					hasLocalChanges = !!lastSynced && localModified.getTime() > lastSynced.getTime() + 2000;
				}

				if (hasLocalChanges && lastSynced) {
					if (remoteUpdated > lastSynced) {
						// CONFLICT DETECTED - Show resolution modal
						const remoteContent = await this.getRemotePageContent(page);
						
						return new Promise<'pulled' | 'pushed' | 'created' | 'skipped' | 'error'>((resolve) => {
							const modal = new ConflictResolutionModal(
								this.app,
								this,
								page.name,
								body,
								remoteContent,
								localModified,
								remoteUpdated,
								async (choice) => {
									try {
										if (choice === 'local') {
											if (!(existingFile instanceof TFile)) {
												throw new Error('Expected existing local file during conflict resolution.');
											}
											const cleanedBody = this.stripLeadingTitleFromBody(body, page.name);
											await this.pushPage(page.id, cleanedBody, page.name);
											await this.updateLocalSyncTime(existingFile, frontmatter, body);
											new Notice(`✅ Pushed local version of: ${page.name}`);
											resolve('pushed');
										} else if (choice === 'remote') {
											await this.pullPage(page, expectedFilePath, book, chapter);
											new Notice(`✅ Pulled remote version of: ${page.name}`);
											resolve('pulled');
										} else {
											new Notice(`⏭️ Skipped conflict: ${page.name}`);
											resolve('skipped');
										}
									} catch (error) {
										console.error(`Error resolving conflict for ${page.name}:`, error);
										new Notice(`❌ Error resolving conflict: ${page.name}`);
										resolve('error');
									}
								}
							);
							modal.open();
						});
					} else {
						if (!(existingFile instanceof TFile)) {
							throw new Error('Expected existing local file while pushing newer local version.');
						}
						const cleanedBody = this.stripLeadingTitleFromBody(body, page.name);
						await this.pushPage(page.id, cleanedBody, page.name);
						await this.updateLocalSyncTime(existingFile, frontmatter, body);
						return 'pushed'
					}
				} else {
					if (!lastSynced || remoteUpdated > lastSynced) {
						await this.pullPage(page, expectedFilePath, book, chapter);
						return 'pulled';
					} else {
						return 'skipped';
					}
				}
			} else {
				await this.pullPage(page, expectedFilePath, book, chapter);
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

		content = this.stripLeadingTitleFromBody(content, page.name);

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
		// body_hash is assigned below after trimming, so the hash and file contents are always in sync.

		if (chapter) {
			metadata.chapter_name = chapter.name;
			metadata.chapter_description = chapter.description;
		}

		// Trim content so the stored hash and file body are always consistent,
		// regardless of what exportPageMarkdown or htmlToMarkdown return.
		const trimmedContent = content.trim();
		metadata.body_hash = this.hashBody(trimmedContent);
		const fullContent = this.createFrontmatter(metadata) + trimmedContent;
		await this.createOrUpdateFile(filePath, fullContent);
	}

	async getRemotePageContent(page: Page): Promise<string> {
		try {
			return await this.exportPageMarkdown(page.id);
		} catch (error) {
			console.log(`Markdown export failed for page ${page.id}, converting HTML`);
			return this.htmlToMarkdown(page.html);
		}
	}

	async pushPage(pageId: number, content: string, name: string): Promise<void> {
		await this.updatePage(pageId, content, name);
	}

	async updateLocalSyncTime(file: TFile, frontmatter: PageFrontmatter, body: string): Promise<void> {
		frontmatter.last_synced = new Date().toISOString();
		// Trim body before writing: extractFrontmatter captures the extra \n
		// after the closing --- as part of body, so without trimming each
		// push cycle would prepend another blank line to the file content.
		const trimmedBody = body.trim();
		// FIX 3: Hash the trimmed body — consistent with hashBody() which
		// also trims, and with what will be read back on the next sync.
		frontmatter.body_hash = this.hashBody(trimmedBody);
		const fullContent = this.createFrontmatter(frontmatter) + trimmedBody;
		await this.app.vault.modify(file, fullContent);
	}

	// ─────────────────────────────────────────────────────────────
	// FIX 8: retireDeletedPages
	//
	// After a pull or bidirectional sync, scans the book folder (and its
	// chapter subfolders) for .md files whose bookstack_id frontmatter
	// value is NOT in remotePageIds — the set of IDs returned by the API.
	// Such files represent pages deleted from BookStack that are now orphaned
	// locally. They are sent to Obsidian trash (respecting the user's trash
	// setting: system trash or .trash folder) rather than silently deleted.
	//
	// Only runs for pull-only and bidirectional syncs. Push-only does not
	// download the remote page list so cannot reliably detect deletions.
	// ─────────────────────────────────────────────────────────────
	async retireDeletedPages(bookFolderPath: string, remotePageIds: Set<number>): Promise<number> {
		let retired = 0;

		const scanFolder = async (folderPath: string) => {
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!(folder instanceof TFolder)) return;

			for (const item of folder.children) {
				if (item instanceof TFolder) {
					await scanFolder(item.path);
				} else if (item instanceof TFile && item.extension === 'md') {
					if (this.shouldSkipFile(item)) continue;
					try {
						const frontmatter = await this.extractFrontmatterOnly(item);
						if (frontmatter.bookstack_id && !remotePageIds.has(frontmatter.bookstack_id)) {
							console.log(`[BookStack] Trashing deleted page: ${item.path}`);
							// Use Obsidian's built-in trash, which respects the user's
							// vault setting (system trash or .trash folder).
							await this.app.vault.trash(item, true);
							new Notice(`Trashed: ${item.basename} (removed from BookStack)`);
							retired++;
						}
					} catch (err) {
						console.error(`[BookStack] Error trashing deleted page: ${item.path}`, err);
					}
				}
			}
		};

		await scanFolder(bookFolderPath);
		return retired;
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

	async findFileByBookStackId(pageId: number, parentPath: string): Promise<TFile | null> {
		if (this.pageFolderCache.has(pageId)) {
			const cachedFile = this.pageFolderCache.get(pageId)!;
			if (cachedFile.parent?.path === parentPath) {
				return cachedFile;
			}
			this.pageFolderCache.delete(pageId);
		}
		
		const folder = this.app.vault.getAbstractFileByPath(parentPath);
		if (!(folder instanceof TFolder)) {
			return null;
		}

		for (const file of folder.children) {
			if (!(file instanceof TFile) || file.extension !== 'md') continue;
			
			try {
				const frontmatter = await this.extractFrontmatterOnly(file);
				
				if (frontmatter.bookstack_id === pageId) {
					this.pageFolderCache.set(pageId, file);
					return file;
				}
			} catch (error) {
				console.error(`Error reading file ${file.path}:`, error);
			}
		}
		
		return null;
	}

	async findBookFolderByBookId(bookId: number, basePath: string): Promise<string | null> {
		if (this.bookFolderCache.has(bookId)) {
			return this.bookFolderCache.get(bookId)!;
		}
		
		const baseFolder = this.app.vault.getAbstractFileByPath(basePath);
		if (!(baseFolder instanceof TFolder)) return null;
		
		for (const item of baseFolder.children) {
			if (!(item instanceof TFolder)) continue;
			
			const hasMatchingPage = await this.folderContainsBookId(item, bookId);
			if (hasMatchingPage) {
				this.bookFolderCache.set(bookId, item.path);
				return item.path;
			}
		}
		
		return null;
	}

	async folderContainsBookId(folder: TFolder, bookId: number): Promise<boolean> {
		for (const file of folder.children) {
			if (file instanceof TFile && file.extension === 'md') {
				try {
					const frontmatter = await this.extractFrontmatterOnly(file);
					if (frontmatter.book_id === bookId) {
						return true;
					}
				} catch (error) {
					// Continue checking other files
				}
			}
			if (file instanceof TFolder) {
				const found = await this.folderContainsBookId(file, bookId);
				if (found) return true;
			}
		}
		return false;
	}

	async findChapterFolderByChapterId(chapterId: number, bookPath: string): Promise<string | null> {
		if (this.chapterFolderCache.has(chapterId)) {
			return this.chapterFolderCache.get(chapterId)!;
		}
		
		const bookFolder = this.app.vault.getAbstractFileByPath(bookPath);
		if (!(bookFolder instanceof TFolder)) return null;
		
		for (const item of bookFolder.children) {
			if (!(item instanceof TFolder)) continue;
			
			const hasMatchingPage = await this.folderContainsChapterId(item, chapterId);
			if (hasMatchingPage) {
				this.chapterFolderCache.set(chapterId, item.path);
				return item.path;
			}
		}
		
		return null;
	}

	async folderContainsChapterId(folder: TFolder, chapterId: number): Promise<boolean> {
		for (const file of folder.children) {
			if (file instanceof TFile && file.extension === 'md') {
				try {
					const frontmatter = await this.extractFrontmatterOnly(file);
					if (frontmatter.chapter_id === chapterId) {
						return true;
					}
				} catch (error) {
					// Continue checking other files
				}
			}
		}
		return false;
	}

	// ─────────────────────────────────────────────────────────────
	// FIX 2: findOrCreateFolderWithRename
	//
	// BEFORE: the rename call was:
	//   await this.app.fileManager.renameFile(existingFolder, expectedNameSanitized);
	//
	// `renameFile`'s second argument must be the FULL vault-relative
	// destination path, not just the new folder name. Passing only the
	// name caused Obsidian to move the folder to the vault root instead
	// of renaming it in place, silently restructuring the vault.
	//
	// AFTER: the full destination path is constructed by combining the
	// folder's current parent path with the new sanitized name:
	//   const renamedPath = `${existingFolder.parent!.path}/${expectedNameSanitized}`;
	//   await this.app.fileManager.renameFile(existingFolder, renamedPath);
	//
	// The cache and return value are then updated to use `renamedPath`
	// so subsequent lookups in the same sync run remain consistent.
	// ─────────────────────────────────────────────────────────────
	async findOrCreateFolderWithRename(
		folderId: number,
		expectedName: string,
		parentPath: string,
		finderFn: (id: number, parent: string) => Promise<string | null>,
		folderType: 'book' | 'chapter'
	): Promise<string> {
		// Clear cache for this specific item to force fresh lookup
		if (folderType === 'book') {
			this.bookFolderCache.delete(folderId);
		} else if (folderType === 'chapter') {
			this.chapterFolderCache.delete(folderId);
		}
		
		// Try to find existing folder by ID (searching through files)
		let existingPath = await finderFn(folderId, parentPath);
		
		// Expected path based on current name from BookStack
		const sanitizedName = this.sanitizeFileName(expectedName);
		const expectedPath = `${parentPath}/${sanitizedName}`;

		// Track the final resolved path — may be updated after a rename
		let finalPath = existingPath || expectedPath;
		
		// If folder exists, check if name matches and rename if needed
		if (existingPath) {
			const existingFolder = this.app.vault.getAbstractFileByPath(existingPath);
			if (existingFolder instanceof TFolder) {
				const currentName = existingFolder.name;

				if (currentName !== sanitizedName) {
					console.log(`[BookStack] Detected renamed ${folderType}: "${currentName}" → "${sanitizedName}"`);

					// FIX 2: Build the full vault-relative destination path.
					// existingFolder.parent is the containing folder (e.g. "BookStack").
					// Without the parent path prefix, renameFile moves the folder
					// to the vault root instead of renaming it in place.
					const renamedPath = `${existingFolder.parent!.path}/${sanitizedName}`;

					try {
						await this.app.fileManager.renameFile(existingFolder, renamedPath);
						console.log(`[BookStack] Successfully renamed ${folderType} folder to: ${renamedPath}`);
						// Update finalPath so the cache and return value reflect the new location
						finalPath = renamedPath;
					} catch (error) {
						console.error(`[BookStack] Failed to rename ${folderType} folder:`, error);
						// On failure keep the existing path so the sync can continue
						finalPath = existingPath;
					}
				}
				// If names already match, finalPath is already set to existingPath above
			}
		}
		
		// Only create folder if it doesn't already exist
		if (!existingPath) {
			await this.ensureFolderExists(finalPath);
			console.log(`[BookStack] Created new ${folderType} folder: ${finalPath}`);
		}
		
		// Update cache with final resolved path
		if (folderType === 'book') {
			this.bookFolderCache.set(folderId, finalPath);
		} else if (folderType === 'chapter') {
			this.chapterFolderCache.set(folderId, finalPath);
		}
		
		return finalPath;
	}

	async renameFileIfNeeded(file: TFile, expectedName: string, parentPath: string): Promise<TFile> {
		const expectedFileName = `${this.sanitizeFileName(expectedName)}.md`;
		const expectedFilePath = `${parentPath}/${expectedFileName}`;
		
		if (file.name !== expectedFileName) {
			console.log(`[BookStack] Renaming file: ${file.name} → ${expectedFileName}`);
			await this.app.fileManager.renameFile(file, expectedFilePath);
			return this.app.vault.getAbstractFileByPath(expectedFilePath) as TFile;
		}
		
		return file;
	}

	shouldSkipFile(file: TFile): boolean {
		if (file.extension !== this.MARKDOWN_EXTENSION) return true;
		if (file.name === this.README_FILENAME) return true;
		return false;
	}

	handleSyncError(context: string, error: unknown): void {
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.error(`[BookStack] ${context}:`, error);
	}

	isTFile(file: any): file is TFile {
		return file instanceof TFile;
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

interface BookState {
	bookChecked: boolean;
	selectedChapters: Set<number>;
	chapters?: BookContent[];
	expanded: boolean;
}

class BookSelectionModal extends Modal {
	plugin: BookStackSyncPlugin;
	books: Book[] = [];
	bookStates: Map<number, BookState> = new Map();
	containerEl: HTMLElement;

	constructor(app: App, plugin: BookStackSyncPlugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Select Books and Chapters to Sync' });
		
		const loadingEl = contentEl.createEl('p', { text: 'Loading books...' });
		
		try {
			this.books = await this.plugin.listBooks();
			loadingEl.remove();
			
			if (this.books.length === 0) {
				contentEl.createEl('p', { text: 'No books found in your BookStack instance.' });
				return;
			}
			
			for (const book of this.books) {
				const selection = this.plugin.settings.syncSelection[book.id];
				
				if (!selection) {
					this.bookStates.set(book.id, {
						bookChecked: false,
						selectedChapters: new Set(),
						expanded: false
					});
				} else if (selection.mode === 'full') {
					this.bookStates.set(book.id, {
						bookChecked: true,
						selectedChapters: new Set(),
						expanded: false
					});
				} else {
					this.bookStates.set(book.id, {
						bookChecked: false,
						selectedChapters: new Set(selection.chapterIds || []),
						expanded: false
					});
				}
			}
			
			const listEl = contentEl.createEl('div', { cls: 'book-list' });
			
			for (const book of this.books) {
				await this.renderBookRow(listEl, book);
			}
			
			const buttonContainer = contentEl.createEl('div', { cls: 'button-container' });
			const saveBtn = buttonContainer.createEl('button', { text: 'Save Selection' });
			saveBtn.addEventListener('click', async () => {
				await this.save();
			});
			
		} catch (error: any) {
			loadingEl.setText(`Error loading books: ${error.message}`);
			console.error('Error loading books:', error);
		}
	}

	async renderBookRow(container: HTMLElement, book: Book) {
		const state = this.bookStates.get(book.id)!;
		
		const bookItemEl = container.createEl('div', { cls: 'book-item' });
		
		const arrowEl = bookItemEl.createEl('span', { 
			cls: 'book-arrow',
			text: state.expanded ? '▼' : '▶'
		});
		arrowEl.style.cursor = 'pointer';
		arrowEl.style.marginRight = '8px';
		arrowEl.style.display = 'inline-block';
		arrowEl.style.width = '12px';
		
		const bookCheckbox = bookItemEl.createEl('input', { type: 'checkbox' });
		bookCheckbox.checked = state.bookChecked;
		bookCheckbox.indeterminate = !state.bookChecked && state.selectedChapters.size > 0;
		
		bookCheckbox.addEventListener('change', () => {
			if (bookCheckbox.checked) {
				state.bookChecked = true;
				state.selectedChapters.clear();
				this.updateChapterCheckboxes(book.id, true);
			} else {
				state.bookChecked = false;
				this.updateChapterCheckboxes(book.id, false);
			}
			this.updateBookCheckbox(book.id);
		});
		
		bookItemEl.createEl('label', { text: ` 📚 ${book.name}` });
		
		const chapterContainerEl = container.createEl('div', { 
			cls: 'chapter-container',
			attr: { style: 'display: none; margin-left: 30px;' }
		});
		
		arrowEl.addEventListener('click', async () => {
			state.expanded = !state.expanded;
			arrowEl.setText(state.expanded ? '▼' : '▶');
			
			if (state.expanded) {
				chapterContainerEl.style.display = 'block';
				if (!state.chapters) {
					chapterContainerEl.empty();
					chapterContainerEl.createEl('p', { text: 'Loading chapters...' });
					try {
						const bookDetail = await this.plugin.getBook(book.id);
						state.chapters = bookDetail.contents.filter(c => c.type === 'chapter');
						chapterContainerEl.empty();
						
						if (state.chapters.length === 0) {
							chapterContainerEl.createEl('p', { 
								text: 'No chapters in this book',
								attr: { style: 'font-style: italic; color: #888;' }
							});
						} else {
							for (const chapter of state.chapters) {
								this.renderChapterRow(chapterContainerEl, chapter, book.id);
							}
						}
					} catch (error) {
						console.error('Error loading chapters:', error);
						chapterContainerEl.empty();
						chapterContainerEl.createEl('p', { 
							text: 'Error loading chapters',
							attr: { style: 'color: red;' }
						});
					}
				}
			} else {
				chapterContainerEl.style.display = 'none';
			}
		});
		
		(bookItemEl as any).bookCheckbox = bookCheckbox;
		(bookItemEl as any).chapterContainer = chapterContainerEl;
		(bookItemEl as any).bookId = book.id;
	}

	renderChapterRow(container: HTMLElement, chapter: BookContent, bookId: number) {
		const state = this.bookStates.get(bookId)!;
		
		const chapterItemEl = container.createEl('div', { 
			cls: 'chapter-item',
			attr: { style: 'margin-left: 20px;' }
		});
		
		const chapterCheckbox = chapterItemEl.createEl('input', { type: 'checkbox' });
		chapterCheckbox.checked = state.selectedChapters.has(chapter.id);
		chapterCheckbox.disabled = state.bookChecked;
		
		chapterCheckbox.addEventListener('change', () => {
			if (chapterCheckbox.checked) {
				state.bookChecked = false;
				state.selectedChapters.add(chapter.id);
			} else {
				state.selectedChapters.delete(chapter.id);
			}
			this.updateBookCheckbox(bookId);
		});
		
		chapterItemEl.createEl('label', { text: ` 📂 ${chapter.name}` });
		
		(chapterItemEl as any).chapterCheckbox = chapterCheckbox;
		(chapterItemEl as any).chapterId = chapter.id;
	}

	updateChapterCheckboxes(bookId: number, disable: boolean) {
		const bookItems = this.contentEl.querySelectorAll('.book-item');
		for (const item of Array.from(bookItems)) {
			if ((item as any).bookId === bookId) {
				const chapterContainer = (item as any).chapterContainer;
				if (chapterContainer) {
					const chapterCheckboxes = chapterContainer.querySelectorAll('input[type="checkbox"]');
					for (const cb of Array.from(chapterCheckboxes)) {
						(cb as HTMLInputElement).disabled = disable;
						if (disable) {
							(cb as HTMLInputElement).checked = false;
						}
					}
				}
				break;
			}
		}
	}

	updateBookCheckbox(bookId: number) {
		const state = this.bookStates.get(bookId)!;
		
		const bookItems = this.contentEl.querySelectorAll('.book-item');
		for (const item of Array.from(bookItems)) {
			if ((item as any).bookId === bookId) {
				const bookCheckbox = (item as any).bookCheckbox as HTMLInputElement;
				bookCheckbox.checked = state.bookChecked;
				bookCheckbox.indeterminate = !state.bookChecked && state.selectedChapters.size > 0;
				break;
			}
		}
	}

	async save() {
		const syncSelection: BookStackSettings['syncSelection'] = {};
		
		for (const [bookId, state] of this.bookStates) {
			if (state.bookChecked) {
				syncSelection[bookId] = { mode: 'full' };
			} else if (state.selectedChapters.size > 0) {
				syncSelection[bookId] = {
					mode: 'chapters',
					chapterIds: Array.from(state.selectedChapters)
				};
			}
		}
		
		this.plugin.settings.syncSelection = syncSelection;
		await this.plugin.saveSettings();
		
		const totalBooks = Object.keys(syncSelection).length;
		const fullBooks = Object.values(syncSelection).filter(s => s.mode === 'full').length;
		const partialBooks = totalBooks - fullBooks;
		
		let message = `Selection saved: ${totalBooks} book${totalBooks !== 1 ? 's' : ''}`;
		if (partialBooks > 0) {
			message += ` (${partialBooks} partial)`;
		}
		
		new Notice(message);
		this.close();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class ConflictResolutionModal extends Modal {
	plugin: BookStackSyncPlugin;
	pageName: string;
	localContent: string;
	remoteContent: string;
	localModified: Date;
	remoteModified: Date;
	onResolve: (choice: 'local' | 'remote' | 'skip') => void;

	constructor(
		app: App,
		plugin: BookStackSyncPlugin,
		pageName: string,
		localContent: string,
		remoteContent: string,
		localModified: Date,
		remoteModified: Date,
		onResolve: (choice: 'local' | 'remote' | 'skip') => void
	) {
		super(app);
		this.plugin = plugin;
		this.pageName = pageName;
		this.localContent = localContent;
		this.remoteContent = remoteContent;
		this.localModified = localModified;
		this.remoteModified = remoteModified;
		this.onResolve = onResolve;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('bookstack-conflict-modal');

		contentEl.createEl('h2', { text: '⚠️ Sync Conflict Detected' });
		contentEl.createEl('p', { 
			text: `The page "${this.pageName}" has been modified in both Obsidian and BookStack.`,
			cls: 'conflict-description'
		});

		const timingEl = contentEl.createEl('div', { cls: 'conflict-timing' });
		timingEl.createEl('p', { text: `Local modified: ${this.localModified.toLocaleString()}` });
		timingEl.createEl('p', { text: `Remote modified: ${this.remoteModified.toLocaleString()}` });

		const previewContainer = contentEl.createEl('div', { cls: 'conflict-preview-container' });

		const localPreview = previewContainer.createEl('div', { cls: 'conflict-preview' });
		localPreview.createEl('h3', { text: '📝 Local Version (Obsidian)' });
		const localPre = localPreview.createEl('pre', { cls: 'conflict-content' });
		localPre.textContent = this.truncateContent(this.localContent);

		const remotePreview = previewContainer.createEl('div', { cls: 'conflict-preview' });
		remotePreview.createEl('h3', { text: '☁️ Remote Version (BookStack)' });
		const remotePre = remotePreview.createEl('pre', { cls: 'conflict-content' });
		remotePre.textContent = this.truncateContent(this.remoteContent);

		const buttonContainer = contentEl.createEl('div', { cls: 'conflict-buttons' });

		const keepLocalBtn = buttonContainer.createEl('button', { 
			text: '⬆️ Keep Local (Push to BookStack)',
			cls: 'mod-cta'
		});
		keepLocalBtn.addEventListener('click', () => {
			this.onResolve('local');
			this.close();
		});

		const keepRemoteBtn = buttonContainer.createEl('button', { 
			text: '⬇️ Keep Remote (Pull from BookStack)',
			cls: 'mod-warning'
		});
		keepRemoteBtn.addEventListener('click', () => {
			this.onResolve('remote');
			this.close();
		});

		const skipBtn = buttonContainer.createEl('button', { 
			text: '⏭️ Skip for Now'
		});
		skipBtn.addEventListener('click', () => {
			this.onResolve('skip');
			this.close();
		});
	}

	truncateContent(content: string, maxLength: number = 500): string {
		if (content.length <= maxLength) return content;
		return content.substring(0, maxLength) + '\n\n... (content truncated)';
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

		containerEl.createEl('h3', { text: 'Creating New Pages' });
		containerEl.createEl('p', { text: 'To create a new page in BookStack: Simply create a new .md file in a book or chapter folder. During the next sync, the plugin will automatically create the page in BookStack and add the bookstack_id to the frontmatter.' });

		containerEl.createEl('h3', { text: 'Creating New Chapters' });
		containerEl.createEl('p', { text: 'To create a new chapter in BookStack: Simply create a new folder in a book. During the next sync, the plugin will automatically create the chapter in BookStack and add the bookstack_id to the frontmatter.' });

		containerEl.createEl('h3', { text: 'About SecretStorage' });
		containerEl.createEl('p', { text: 'This plugin uses Obsidian\'s SecretStorage to securely store your API credentials. Secrets are stored separately from plugin settings and can be shared across multiple plugins. You can manage all your secrets in Settings → About → Manage secrets.' });
	}
}
