# Test Matrix

## Environment
- A Bookstance instance hosted on a NAS, availabe on the internet network via Reverse Proxy and HTTPS port forwarding
- A dedicated role and user that has :
  - Read/Write/Create rights in one of the books
  - Read rights in the rest
- Android Device (Pixel 8, Android 16)
- NoteStack v0.0.7
- Obsidian 1.11+

## Tests

| # | Test | Expected Result | Status |
|---|------|----------------|--------|
| **Data Structure & Settings** |
| 1 | Load plugin with empty settings | `syncSelection` is empty object `{}` | ✅ Passed |
| 2 | Save full book selection | `syncSelection[bookId] = { mode: 'full' }` | ✅ Passed |
| 3 | Save chapter selection | `syncSelection[bookId] = { mode: 'chapters', chapterIds: [1,2,3] }` | ✅ Passed |
| 4 | Save mixed selection (full + chapters) | Multiple entries with different modes | ✅ Passed|
| 5 | Remove all selections | `syncSelection` becomes empty object | ✅ Passed |
| **Book Selection Modal** |
| 6 | Open modal with no books in BookStack | Shows "No books found" message | ⚪ Not Tested |
| 7 | Open modal with books | Displays list of books with checkboxes and arrows | ✅ Passed |
| 8 | Check a book checkbox | Book checkbox becomes checked, state saved as `mode: 'full'` | ✅ Passed |
| 9 | Uncheck a book checkbox (no chapters selected) | Book removed from `syncSelection` | ✅ Passed |
| 10 | Click expand arrow (collapsed book) | Arrow changes to ▼, chapters load and display | ✅ Passed |
| 11 | Click collapse arrow (expanded book) | Arrow changes to ▶, chapters hide | ✅ Passed |
| 12 | Expand book with no chapters | Shows "No chapters in this book" message | ✅ Passed |
| 13 | Expand book with chapters | Shows list of chapters with checkboxes | ✅ Passed |
| 14 | Check a chapter checkbox | Chapter added to `selectedChapters`, book checkbox unchecked | ✅ Passed |
| 15 | Uncheck a chapter checkbox | Chapter removed from `selectedChapters` | ✅ Passed |
| 16 | Check all chapters individually | Book checkbox shows unchecked state | ✅ Passed |
| 17 | Uncheck last selected chapter | Book removed from selection | ⚪ Not Tested |
| 18 | Check book when chapters are selected | All chapter checkboxes become disabled and unchecked | ✅ Passed |
| 19 | Uncheck book when chapters were selected | Chapter checkboxes become enabled, previous selection lost | ⚪ Not Tested |
| 20 | Collapse book with selected chapters | Selection persists, shows indeterminate checkbox | ⚪ Not Tested |
| 21 | Reopen modal with saved full book selection | Book checkbox is checked, arrow collapsed | ✅ Passed |
| 22 | Reopen modal with saved chapter selection | Book checkbox indeterminate, chapters remembered | ✅ Passed |
| 23 | Save selection with no books/chapters selected | Shows validation or saves empty selection | ⚪ Not Tested |
| 24 | Click Save button | Settings saved, modal closes, notice shown | ✅ Passed |
| **Sync Validation** |
| 25 | Run sync with empty `syncSelection` | Shows "No books or chapters selected" notice | ✅ Passed |
| 26 | Run sync with full book selected | All chapters and standalone pages sync | ✅ Passed |
| 27 | Run sync with only chapters selected | Only selected chapters sync, standalone pages skipped | ✅ Passed |
| 28 | Run sync with mixed selection | Full books sync completely, partial books sync chapters only | ✅ Passed |
| **Pull Sync (Download)** |
| 29 | Pull full book with chapters and standalone pages | All pages downloaded to correct folders | ⚪ Not Tested |
| 30 | Pull selected chapters only | Only chapter pages downloaded, standalone pages ignored | ⚪ Not Tested |
| 31 | Pull from multiple books (full mode) | All books downloaded completely | ⚪ Not Tested |
| 32 | Pull from multiple books (chapter mode) | Only selected chapters from each book downloaded | ⚪ Not Tested |
| 33 | Pull with renamed book folder | Book folder renamed back to match BookStack | ⚪ Not Tested |
| 34 | Pull with renamed chapter folder | Chapter folder renamed back to match BookStack | ⚪ Not Tested |
| 35 | Pull page that exists locally (no changes) | Page skipped, skip count incremented | ⚪ Not Tested |
| 36 | Pull page that was updated remotely | Page content updated locally | ⚪ Not Tested |
| **Push Sync (Upload)** |
| 37 | Push full book with local changes | All modified pages uploaded to BookStack | ⚪ Not Tested |
| 38 | Push selected chapters only | Only pages in selected chapters uploaded | ⚪ Not Tested |
| 39 | Push with new local file in full book mode | New page created in BookStack | ⚪ Not Tested |
| 40 | Push with new local file in chapter mode | New page created in selected chapter | ⚪ Not Tested |
| 41 | Push with new local file in non-selected chapter | Page not created (skipped) | ⚪ Not Tested |
| 42 | Push page with no local changes | Page skipped, skip count incremented | ⚪ Not Tested |
| 43 | Push new chapter folder in full book mode | New chapter created in BookStack | ⚪ Not Tested |
| 44 | Push new chapter folder in chapter mode | Chapter creation skipped (not in selected chapters) | ⚪ Not Tested |
| **Bidirectional Sync** |
| 45 | Bidirectional sync with no conflicts | Pages sync correctly in both directions | ✅ Passed |
| 46 | Bidirectional sync with full book | All pages synced including standalone | ✅ Passed |
| 47 | Bidirectional sync with chapters only | Only selected chapters synced, standalone pages ignored | ✅ Passed |
| 48 | Bidirectional sync with local-only changes | Local changes pushed to BookStack | ✅ Passed |
| 49 | Bidirectional sync with remote-only changes | Remote changes pulled to local | ✅ Passed |
| 50 | Bidirectional sync with conflict (both changed) | Conflict resolution modal shown | ⚪ Not Tested |
| 51 | Conflict resolution: choose local | Local version pushed, remote overwritten | ⚪ Not Tested |
| 52 | Conflict resolution: choose remote | Remote version pulled, local overwritten | ⚪ Not Tested |
| 53 | Conflict resolution: skip | Page unchanged, marked as skipped | ⚪ Not Tested |
| **Progress Display** |
| 54 | Start pull sync | Shows "Pulling from BookStack" | ⚪ Not Tested |
| 55 | Progress updates during sync | No Notice or notification | ⚪ Not Tested |
| 56 | Complete pull sync successfully | Shows final summary with counts | ⚪ Not Tested |
| 57 | Start push sync | Shows "Pushing to BookStack" | ⚪ Not Tested |
| 58 | Start bidirectional sync | Shows "Starting bidirectionnal Sync" | ✅ Passed |
| 59 | Sync with errors | Error count shown in final summary | ⚪ Not Tested |
| 60 | [ Not in the code ] Progress bar calculation | Percentage accurate based on pages processed | ⚪ Not Tested |
| **Page Counting** |
| 61 | Count pages in full book mode | All pages in all chapters + standalone counted | ✅ Passed |
| 62 | Count pages in chapter mode | Only pages in selected chapters counted | ✅ Passed |
| 63 | Count with empty book | Total pages = 0, sync completes without error | ⚪ Not Tested |
| 64 | Count with chapters that have no pages | Those chapters contribute 0 to total | ⚪ Not Tested |
| **Folder & File Management** |
| 65 | Create book folder that doesn't exist | Folder created with sanitized name | ✅ Passed |
| 66 | Rename book folder to match BookStack | Folder renamed, cache updated | ⚪ Not Tested |
| 67 | Rename chapter folder to match BookStack | Folder renamed, cache updated | ⚪ Not Tested |
| 68 | Rename file to match BookStack page name | File renamed to match remote | ⚪ Not Tested |
| 69 | Find file by bookstack_id | Correct file found using frontmatter | ⚪ Not Tested |
| 70 | Find book folder by book_id | Correct folder found by checking file frontmatter | ⚪ Not Tested |
| 71 | Find chapter folder by chapter_id | Correct folder found by checking file frontmatter | ⚪ Not Tested |
| 72 | Cache cleared at sync start | All caches (book, chapter, page) are empty | ⚪ Not Tested |
| 73 | Cache populated during sync | Folders and files added to cache as found | ⚪ Not Tested |
| **Frontmatter Handling** |
| 74 | Extract frontmatter from synced page | All metadata fields extracted correctly | ✅ Passed |
| 75 | Create frontmatter for new page | Frontmatter includes all required fields | ✅ Passed |
| 76 | Update last_synced timestamp | Timestamp updated after sync operation | ✅ Passed |
| 77 | Handle page with no frontmatter | Returns empty frontmatter object, body is full content | ⚪ Not Tested |
| 78 | Strip leading H1 from body | Duplicate title heading removed from content | ✅ Passed |
| **Edge Cases** |
| 79 | Sync while already syncing | Shows "Sync already in progress" notice | ✅ Passed |
| 80 | Sync with no API credentials | Shows "Please configure API credentials" | ✅ Passed |
| 81 | Sync with invalid BookStack URL | Shows connection error | ⚪ Not Tested |
| 82 | Book deleted from BookStack but in selection | Error handled gracefully, continues with other books | ⚪ Not Tested |
| 83 | Chapter deleted from BookStack but in selection | Error handled gracefully, continues with other chapters | ⚪ Not Tested |
| 84 | Page deleted from BookStack | Sync skips or handles deletion gracefully | ⚪ Not Tested |
| 85 | Network error during sync | Error message shown, sync stops gracefully | ⚪ Not Tested |
| 86 | Sync folder doesn't exist | Folder created automatically | ⚪ Not Tested |
| 87 | File with invalid characters in name | Filename sanitized correctly | ⚪ Not Tested |
| 88 | Book/chapter name changes in BookStack | Folder renamed to match new name | ⚪ Not Tested |
| **Auto-Sync** |
| 89 | Enable auto-sync | Interval timer started | ⚪ Not Tested |
| 90 | Disable auto-sync | Interval timer stopped | ⚪ Not Tested |
| 91 | Auto-sync triggers at interval | Sync runs automatically at specified interval | ⚪ Not Tested |
| 92 | Change sync interval | New interval applied, timer restarted | ⚪ Not Tested |
| **Commands** |
| 93 | Run "Sync BookStack Books" command | Executes sync based on mode setting | ✅ Passed |
| 94 | Run "Pull from BookStack" command | Executes pull-only sync | ⚪ Not Tested |
| 95 | Run "Push to BookStack" command | Executes push-only sync | ⚪ Not Tested |
| 96 | Run "Select Books to Sync" command | Opens selection modal | ⚪ Not Tested |
| 97 | Run "Test BookStack Connection" command | Tests API connection and shows result | ✅ Passed |
| **Settings Persistence** |
| 98 | Save settings | Settings written to data.json | ✅ Passed |
| 99 | Load settings on plugin load | Settings read from data.json correctly | ✅ Passed |
| 100 | Migrate old selectedBooks to syncSelection | Old format converted to new format | ✅ Passed |

**Legend:**
- ⚪ Not Tested
- ✅ Passed
- ❌ Failed
- ⚠️ Needs Review