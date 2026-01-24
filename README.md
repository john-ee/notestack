# NoteStack - BookStack Sync Plugin for Obsidian

Bidirectional synchronization between BookStack and Obsidian. Turn your BookStack instance into an Obsidian vault subfolder and keep all your notes in one place.

## Features

- **Bidirectional Sync** - Automatically syncs based on timestamps with conflict detection
- **Flexible Sync Modes** - Pull-only, Push-only, or Bidirectional
- **Interactive Conflict Resolution** - Choose which version to keep when conflicts occur
- **Selective Book and Chapter Sync** - Choose which books or chapters to synchronize
- **Auto-Sync** - Configurable automatic syncing at regular intervals (Untested for now - I use manual sync)
- **Create New Content** - Create pages and chapters directly from Obsidian
- **Mobile Support** - Full Android and iOS compatibility
- **Secure Credentials** - Uses Obsidian's SecretStorage API
- **Markdown Conversion** - Automatic HTML-to-Markdown conversion with fallback

## Installation

### Manual Installation
1. Download `main.js`, `manifest.json`, `styles.css` from [latest release](https://github.com/john-ee/notestack/releases/)
2. Create folder: `<vault>/.obsidian/plugins/notestack/`
3. Copy files into folder
4. Settings → Community Plugins → Enable "NoteStack"

### From Community Plugins (When Available)
1. Settings → Community Plugins → Browse
2. Search "NoteStack" or "BookStack Sync"
3. Install and enable

## Quick Setup

### 1. Get API Credentials
1. Log into BookStack → Profile → API Tokens
2. Create token and copy **Token ID** and **Token Secret**
3. Ensure your user has "Access System API" permission

### 2. Configure Plugin
1. Settings → NoteStack
2. Enter BookStack URL (e.g., `https://bookstack.example.com`)
3. Create/select secrets for Token ID and Token Secret
4. Choose sync folder (default: `BookStack`)

### 3. Select Books
1. Command Palette → "NoteStack: Select Books to Sync"
2. Check desired books → Save

### 4. Test Connection
- Command Palette → "NoteStack: Test BookStack Connection"

## Usage

### Manual Sync Commands
- **Sync** - Smart sync based on configured mode (Ctrl/Cmd+P → "Sync BookStack Books")
- **Pull** - Download from BookStack only (Ctrl/Cmd+P → "Pull from BookStack")
- **Push** - Upload to BookStack only (Ctrl/Cmd+P → "Push to BookStack")
- **Ribbon Icon** - Click folder sync icon in left sidebar

### Sync Modes

| Mode | Behavior | Best For |
|------|----------|----------|
| **Bidirectional** | Sync based on timestamps, shows conflict modal on conflicts | Active editing in both places |
| **Pull Only** | Download only, never upload | BookStack as source of truth |
| **Push Only** | Upload only, never download | Obsidian as primary editor |

### Auto-Sync Settings
- **Auto Sync** - Enable automatic syncing. Runs only when Obsidian is open or running.
- **Sync Interval** - How often to sync (minutes)

**⚠️ Important:** Auto-sync can interrupt your work if conflicts occur, as it will show a popup dialog asking which version to keep. For uninterrupted work, use manual sync instead.


### Conflict Resolution

When both local and remote have changes, an interactive modal appears asking which version to keep:

- ⬆️ **Keep Local** - Push your version to BookStack
- ⬇️ **Keep Remote** - Pull BookStack version
- ⏭️ **Skip** - Resolve later manually

**Note:** This popup can appear during auto-sync, interrupting your work.

### Creating New Content

**New Pages:**
1. Create `.md` file in book/chapter folder
2. Add content i the page
3. Run sync - page created in BookStack automatically
4. `bookstack_id` added to frontmatter

**New Chapters:**
1. Create folder in book folder
2. Add `.md` files inside
3. Run sync - chapter and pages created in BookStack

**Note :** Once the file or the chapter is created, you have to rename it from Bookstack

## File Structure

```
BookStack/
├── Book Name/
│   ├── Page 1.md
│   ├── Page 2.md
│   └── Chapter Name/
│       ├── Page 3.md
│       └── Page 4.md
```

**Page Frontmatter:**
```yaml
---
title: Page Name
bookstack_id: 123
book_id: 45
chapter_id: 67
created: 2024-01-01T00:00:00Z
updated: 2024-01-15T12:30:00Z
last_synced: 2024-01-15T14:30:00Z
---
```

## Missing Features & Limitations

### Not Well Suited For:
- **Heavy Formatting** - Complex tables, nested layouts, and advanced HTML may not convert cleanly to Markdown
- **Attachments** - Images, PDFs, and files are referenced by URL only (not downloaded locally)
- **Large Media Libraries** - Books with many embedded images/files require manual handling
- **WYSIWYG Content** - Rich text from visual editors may lose formatting in conversion

### Current Limitations:
- No image/attachment downloads
- No support for BookStack drawings
- Complex HTML → Markdown conversion may be imperfect
- Cannot move pages between books/chapters
- Cannot delete content (sync only updates) - not planned
  - There are no methods to actually delete. If you delete a file or a folder the synchronization should restore it
- Large initial syncs may be slow

### Best For:
- Text-heavy documentation
- Markdown-native content
- Simple formatting (headings, lists, links, code blocks)
- Reference documentation with external images

## Next steps
- [x] Use frontmatter data from pages for a resilient book and chapter structure.
- [x] Synchronise at the chapter level for more granular control.
- [ ] Restore a renaming page feature.
- [ ] Test out attachment management, more specifically images.

## Security

- API credentials stored in Obsidian SecretStorage (encrypted)
- Direct Obsidian ↔ BookStack communication only via the requestUrl method
- No third-party servers
- HTTPS support
- Vault-specific credential storage

## Development

```bash
npm install
npm run dev          # Development with watch
npm run build        # Production build
```

## Changelog

### v0.0.7
- Synchronize at the chapter level instead of synchronizing the full book
  - Page that are not in chapters will not be synced. These appear only if you sync the full book.

### v0.0.6
- Refactored the code, notably the Books and Chapter sync logic into a Folder logic called by both
- Cached the frontmatter data to reduce the numbers of searches inside the page.

### v0.0.5
- Fixed a bug that wrote the title of the page in the body when the renaming mechanism ran.

### v0.0.4
- Self healing mechanisms based on frontmatter. If you rename the book or chapter folder locally it will rename itself back from Bookstack.
- Added a check that skips adding the title of the page in the body of the file.

### v0.0.3
- Interactive conflict resolution modal
- Create chapters from folders

### v0.0.2
- Dedicated push/pull commands

### v0.0.1
- Initial release

## Support

- [BookStack API Docs](https://demo.bookstackapp.com/api/docs)
- [Obsidian Plugin Docs](https://docs.obsidian.md/)

---


**⚠️ Disclaimer:** This is an unofficial plugin built with suggested code from Claude and Copilot. You are responsible for your data. Always maintain backups. Not affiliated with BookStack or Obsidian.
