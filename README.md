# NoteStack - BookStack Sync Plugin for Obsidian

Bidirectional synchronization between BookStack and Obsidian. Intelligently syncs your BookStack books, chapters, and pages with smart conflict detection. Works on all platforms including Android.

## Features

- 🔄 **Bidirectional Sync** - Intelligently pulls from BookStack or pushes to BookStack based on timestamps
- 🤓 **Smart Conflict Detection** - Detects when both local and remote have changes, preserves local by default
- 📚 **Selective Sync** - Choose which books to synchronize
- ⚙️ **Multiple Sync Modes** - Pull-only, Push-only, or Bidirectional
- 🔁 **Auto-Sync** - Automatically sync at regular intervals
- 📱 **Mobile-Friendly** - Full support for Android and iOS
- 🗂️ **Organized Structure** - Maintains BookStack hierarchy (Books → Chapters → Pages)
- 📝 **Markdown Conversion** - Converts HTML pages to Markdown with fallback support
- 🏷️ **Metadata Preservation** - Keeps page metadata and sync timestamps in frontmatter
- 🔐 **Secure Credentials** - Uses Obsidian's SecretStorage for API credentials

## Installation

### From Obsidian Community Plugins (Recommended - When Available)
1. Open Obsidian Settings
2. Go to Community Plugins
3. Search for "BookStack Sync"
4. Click Install
5. Enable the plugin

### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Create a folder: `<vault>/.obsidian/plugins/bookstack-sync/`
3. Copy the downloaded files into this folder
4. Reload Obsidian
5. Enable the plugin in Settings → Community Plugins

## Setup

### 1. Get BookStack API Credentials

1. Log into your BookStack instance
2. Go to your user profile (click your avatar)
3. Scroll to the "API Tokens" section
4. Click "Create Token"
5. Give it a name (e.g., "Obsidian Sync")
6. Copy the **Token ID** and **Token Secret** (shown only once!)

**Important**: You need the "Access System API" permission assigned to your user role.

### 2. Configure the Plugin

1. Open Obsidian Settings
2. Go to BookStack Sync settings
3. Enter your BookStack instance details:
   - **BookStack URL**: Your instance URL (e.g., `https://bookstack.example.com`)
   - **API Token ID**: Select or create a secret for your token ID
   - **API Token Secret**: Select or create a secret for your token secret
   - **Sync Folder**: Where to store synced content (default: `BookStack`)
   - **Sync Mode**: Choose your preferred sync behavior

### 3. Select Books to Sync

1. Open Command Palette (Ctrl/Cmd + P)
2. Run: "BookStack Sync: Select Books to Sync"
3. Check the books you want to synchronize
4. Click "Save Selection"

## Usage

### Manual Sync

**Option 1: Ribbon Icon**
- Click the book icon (📖) in the left ribbon

**Option 2: Command Palette**
- Open Command Palette (Ctrl/Cmd + P)
- Run: "BookStack Sync: Sync BookStack Books"

### Sync Modes

The plugin offers three sync modes to fit your workflow:

#### **Bidirectional (Recommended)**
Intelligently syncs in both directions based on timestamps:
- **Pulls from BookStack** when remote is newer
- **Pushes to BookStack** when local is newer
- **Preserves local changes** when both have been modified (conflict)
- **Skips** when already in sync

**Example:**
- You edit a page in BookStack → Next sync pulls the changes
- You edit a page in Obsidian → Next sync pushes the changes
- Both edited since last sync → Local preserved, conflict notice shown

#### **Pull Only**
One-way sync from BookStack to Obsidian:
- Downloads changes from BookStack
- Never uploads local changes
- Safe for read-only workflows
- Good when you want to keep BookStack as the source of truth

#### **Push Only**
One-way sync from Obsidian to BookStack:
- Uploads local changes to BookStack
- Never downloads remote changes
- Good for content creation workflows in Obsidian
- Useful when you're the primary editor

### Auto Sync

1. Open Settings → BookStack Sync
2. Enable "Auto Sync"
3. Set your preferred sync interval (in minutes)

The plugin will automatically sync your selected books at the specified interval using your chosen sync mode.

### Sync Summary

After each sync, you'll see a summary notification:
```
Sync complete: 5 pulled, 3 pushed, 2 skipped, 0 errors
```

## File Structure

The plugin creates a structured folder hierarchy matching your BookStack organization:

```
BookStack/
├── Book Name 1/
│   ├── README.md (book description)
│   ├── Page 1.md
│   ├── Page 2.md
│   └── Chapter Name/
│       ├── README.md (chapter description)
│       ├── Page 3.md
│       └── Page 4.md
└── Book Name 2/
    └── ...
```

Each page includes frontmatter with metadata and sync tracking:

```markdown
---
title: Page Name
bookstack_id: 123
created: 2024-01-01T00:00:00.000000Z
updated: 2024-01-15T12:30:00.000000Z
last_synced: 2024-01-15T14:30:00.000000Z
---

Page content here...
```

## How Bidirectional Sync Works

The plugin uses timestamps to determine sync direction:

1. **Gets timestamps:**
   - Remote: BookStack's `updated_at`
   - Local: File modification time
   - Last Sync: From frontmatter

2. **Decides action:**
   - Local modified after last sync + Remote unchanged → **Push to BookStack**
   - Remote modified after last sync + Local unchanged → **Pull from BookStack**
   - Both modified after last sync → **Conflict** (local preserved)
   - Neither modified → **Skip**

3. **Updates metadata:**
   - After successful sync, updates `last_synced` timestamp
   - Tracks sync status per page

### Conflict Handling

When both local and remote have changes since the last sync:
- Local changes are **preserved** (not overwritten)
- A notice appears: `"Conflict: Page Name changed in both places. Local changes preserved."`
- Check the console log for details
- Manually resolve by:
  - Switching to pull-only mode temporarily to get remote version
  - Switching to push-only mode to force upload local version
  - Manually merging changes in BookStack or Obsidian

## Android Usage

This plugin works seamlessly on Android:

1. Install Obsidian from Google Play Store
2. Follow the setup instructions above
3. Use the same commands and features as desktop
4. Auto-sync works great for keeping content updated
5. Bidirectional sync handles edits from any device

**Tip**: Enable auto-sync with bidirectional mode to keep your vault updated across devices without manual intervention.

## API Endpoints Used

The plugin uses the following BookStack API endpoints:

- `GET /api/books` - List all books
- `GET /api/books/{id}` - Get book details with contents
- `GET /api/chapters/{id}` - Get chapter details
- `GET /api/pages/{id}` - Get page details
- `GET /api/pages/{id}/export/markdown` - Export page as Markdown
- `PUT /api/pages/{id}` - Update page content (for push operations)

## Troubleshooting

### "Please configure BookStack settings first"
- Ensure you've entered your BookStack URL
- Verify you've selected secrets for both Token ID and Token Secret
- Check that the secrets contain valid credentials

### "No books selected for sync"
- Run "Select Books to Sync" command
- Select at least one book and save

### Authentication errors (401/403)
- Verify your API credentials are correct
- Ensure your user has "Access System API" permission
- Try regenerating your API token
- Check that the secrets are properly saved in SecretStorage

### Connection errors
- Check your BookStack URL is correct and accessible
- Ensure you have internet connection (especially on mobile)
- Verify your BookStack instance is running
- Remove trailing slashes from the URL

### Conflicts keep appearing
- This means both local and remote have changes
- Choose a resolution strategy:
  - Temporarily switch to "Pull Only" to get remote version
  - Temporarily switch to "Push Only" to upload local version
  - Manually merge changes and then sync

### Pages not updating
- Check the sync summary for skipped/error counts
- Review console logs (Ctrl+Shift+I) for detailed error messages
- Verify the page hasn't been deleted in BookStack
- Check that timestamps in frontmatter are valid

### Push not working
- Ensure you have write permissions in BookStack
- Verify your API token has content editing permissions
- Check that the page exists (bookstack_id in frontmatter is valid)
- Review console logs for API errors

### HTML instead of Markdown
- If markdown export fails, the plugin falls back to HTML-to-Markdown conversion
- This is normal for WYSIWYG-edited pages
- The conversion handles most HTML elements gracefully
- For best results, use Markdown editor in BookStack

## Security & Privacy

- **Secure Storage**: API credentials are stored using Obsidian's SecretStorage, not in plain text
- **No Third Parties**: No data is sent to third parties
- **Direct Communication**: All communication is directly between Obsidian and your BookStack instance
- **HTTPS Support**: Supports secure HTTPS connections to BookStack
- **Vault-Specific**: Secrets are keyed to specific vaults for security
- **Shared Secrets**: Can share credentials across multiple plugins using SecretStorage

## Limitations

- Images are referenced by URL (not downloaded locally)
- Complex HTML formatting may not convert perfectly to Markdown
- Bidirectional sync requires careful timestamp management
- Conflict resolution is manual (local preserved by default)
- Large books may take some time to sync initially
- Push operations update content only (not structure like book/chapter moves)

## Best Practices

1. **Start with Pull-Only** when first setting up to safely test the sync
2. **Use Bidirectional** once comfortable with the plugin behavior
3. **Enable Auto-Sync** with reasonable intervals (30-60 minutes recommended)
4. **Check Sync Summary** after each sync to monitor changes
5. **Resolve Conflicts Promptly** to prevent confusion
6. **Use Markdown in BookStack** for best conversion results
7. **Keep Frontmatter Intact** - don't manually edit sync timestamps
8. **Regular Backups** - always maintain backups of both systems

## Development & Building

This plugin can be built on your NAS or local development environment:

### Requirements
- Node.js 16+ and npm
- TypeScript
- esbuild

### Build Instructions
```bash
npm install
npm run build        # Production build
npm run dev          # Development build with watch mode
```

See the main documentation for detailed NAS/OMV build setup instructions.

## Contributing

Found a bug or have a feature request? Please open an issue on GitHub!

Contributions are welcome via pull requests.

## Changelog

### v0.0.1
- Initial release
- Bidirectional sync with smart conflict detection
- Three sync modes: Bidirectional, Pull-only, Push-only
- SecretStorage integration for secure credential management
- Auto-sync with configurable intervals
- Markdown export with HTML fallback
- Full Android/mobile support
- Timestamp-based sync logic
- Per-page sync tracking

## License

MIT License

## Credits

Built with ❤️ for the Obsidian and BookStack communities.

## Support

- [BookStack Documentation](https://www.bookstackapp.com/docs/)
- [BookStack API Documentation](https://demo.bookstackapp.com/api/docs)
- [Obsidian Plugin Development](https://docs.obsidian.md/)
- [SecretStorage Documentation](https://docs.obsidian.md/plugins/guides/secret-storage)

---

**Note**: This is an unofficial plugin and is not affiliated with BookStack or Obsidian.