# Readdit — A Reddit-Styled Book Reading Environment

## Overview

A fully static site styled after **Old Reddit** that presents book chapters as subreddit posts, with AI-generated discussion comments from four consistent personas. Each **author** is a subreddit (e.g. `r/DonNorman`), and each **book** is a post series within that subreddit. Users process a local PDF into the site using a CLI script, and the result is deployable to GitHub Pages.

Chapter text does **not** live in the web interface. Each chapter's PDF page range is extracted as a separate PDF file stored in a local `chapters/` directory. The thread view links out to open the chapter PDF in a new browser tab. The interface is purely for the discussion layer.

## Architecture

```
readdit/
├── process.py              # CLI: PDF → chapter PDFs + AI comments → static JSON
├── site/                   # GitHub Pages root
│   ├── index.html          # Front page: list of all authors (subreddits)
│   ├── author.html         # Subreddit view: list of chapters for one book
│   ├── chapter.html        # Thread view: persona comments for one chapter
│   ├── style.css           # Old Reddit aesthetic
│   ├── app.js              # Minimal JS to load JSON and render
│   └── data/
│       └── {author-slug}/
│           └── {book-slug}/
│               ├── meta.json       # Book title, author, chapter list
│               └── chapters/
│                   ├── 01.json     # Chapter metadata + generated comments (no chapter text)
│                   ├── 02.json
│                   └── ...
├── chapters/               # LOCAL ONLY — not deployed to GitHub Pages
│   └── {author-slug}/
│       └── {book-slug}/
│           ├── 01.pdf          # Extracted chapter PDF (pages X-Y)
│           ├── 02.pdf
│           └── ...
```

## Part 1: `process.py` — The PDF Processing CLI

### Usage
```bash
python process.py "path/to/book.pdf" --title "The Design of Everyday Things" --author "Don Norman"
```

### What it does
1. **Extract text** from the PDF (use `pymupdf`/`fitz`)
2. **Chunk into chapters** using a two-pass approach:
   - **Pass 1 (heuristic):** Detect headings via font size, bold text, and common patterns ("Chapter 1", "CHAPTER ONE", "Part I", numbered sections, etc.)
   - **Pass 2 (Haiku):** Send the extracted text with page numbers to `claude-haiku-4.5` and ask it to confirm/correct the chapter boundaries. This is cheap and handles edge cases the heuristics miss. Prompt: "Here is the text of a book with page markers. Return a JSON array of chapters with `title` and `start_page` and `end_page` fields."
   - Fallback: if both fail, split into ~20-page chunks
3. **Extract chapter PDFs** into `chapters/{author-slug}/{book-slug}/`:
   - Use pymupdf to extract each chapter as a separate PDF file (e.g. `01.pdf`, `02.pdf`)
   - These stay local and are NOT part of the deployed site
4. **Generate persona comments** for each chapter by calling the Anthropic API:
   - Send the chapter text to `claude-sonnet-4-6` with a system prompt defining all 4 personas
   - Ask for one top-level comment per persona, each 150-300 words
   - Each comment should feel natural — like someone posting on Reddit, but a high quality thoughtful post
   - Parse the response and structure into JSON
5. **Output static JSON** into `site/data/{author-slug}/{book-slug}/`

### Persona Definitions (embed these in the system prompt)

**u/close_reader** (flair: "📖 Line by Line")
- Focuses on craft, style, structure, rhetoric
- Pulls specific short quotes from the chapter and analyzes what they're doing
- Notices patterns, callbacks, shifts in tone
- Voice: thoughtful, precise, a little nerdy about language

**u/devils_advocate** (flair: "🔥 Well, actually...")
- Pushes back on the author's arguments
- Asks "but what about..." and "this assumes that..."
- Steelmans counterarguments
- Voice: respectful but persistent, enjoys the debate

**u/the_connector** (flair: "🔗 Reminds me of...")
- Relates the chapter to other books, thinkers, current events, adjacent fields
- Draws surprising parallels
- Suggests further reading
- Voice: enthusiastic, associative, the "oh you should also check out..." person

**u/tldr_bot** (flair: "🤖 Summary Bot")
- Extracts the 2-4 most important ideas from the chapter
- Restates them clearly and concisely
- Highlights key terms or concepts introduced
- Voice: neutral, helpful, structured (uses bullet points sparingly)

### Comment JSON structure
```json
{
  "chapter_number": 1,
  "chapter_title": "The Psychopathology of Everyday Things",
  "chapter_pdf": "01.pdf",
  "comments": [
    {
      "id": "c1_close_reader",
      "username": "close_reader",
      "flair": "📖 Line by Line",
      "body": "The thing that strikes me about this chapter...",
      "score": 1,
      "timestamp_label": "8 hours ago",
      "replies": []
    }
  ]
}
```

- `chapter_pdf`: filename only — the app resolves the full local path based on a configurable `CHAPTERS_ROOT` path set in `app.js`. The thread view renders a "Read Chapter" link that opens this PDF in a new browser tab.
- `score`: all comments start at 1 (Reddit default). Upvotes and downvotes are **functional** — clicking them updates the score and persists the vote state in `localStorage`. This is purely personal history (your own votes), not fake engagement numbers. The UI should track whether you've upvoted, downvoted, or not voted on each comment, and highlight the arrows accordingly (orange up, periwinkle down, like Reddit).
- `timestamp_label`: randomized like "3 hours ago", "11 hours ago", etc. Earlier chapters get older timestamps.

## Part 2: The Static Site — Old Reddit Clone

### Visual Design: Faithful Old Reddit

This should genuinely look and feel like old.reddit.com. Use a frontend dev skill. Key elements:

**Header bar:**
- Light blue/white top bar
- "Readdit" logo in the Reddit font position (use Verdana or similar, keep it simple)
- Subreddit name: `r/{AuthorName}` with subscriber count ("4 readers, 2 here now" — fake but fun)

**Sidebar:**
- Book cover image (if provided) or placeholder
- Book description / about section
- "Rules": tongue-in-cheek reading group rules ("1. No spoilers for future chapters", "2. Be kind to the author", etc.)
- Chapter list as navigation

**Front Page (index.html):**
- Lists all authors as "subreddits" you're subscribed to
- Each author is a card/link: `r/{AuthorName}` with book count and a brief description
- Styled like the old Reddit front page or subreddit directory

**Author / Book View (author.html):**
- Looks like a subreddit's post listing
- Each chapter is a "post" in the subreddit feed
- Thumbnail: chapter number in a colored square
- Title: "Chapter {N}: {Title}"
- Submitted by `u/{author_slug}` to `r/{AuthorName}`
- Comment count: "{N} comments"
- Upvote/downvote arrows — functional, personal state (see vote behavior below)
- Sort options at top: "hot / new / top" (can be decorative or actually sort)

**Chapter Thread View (chapter.html):**
- Post title at top
- "Read Chapter" link/button that opens the chapter PDF in a new browser tab (the chapter text does NOT live inline in the page)
- Below: comment section with the 4 persona comments
  - Threaded comment UI: username, flair, score, timestamp, collapse buttons
  - Comment text with proper Reddit markdown-style formatting
  - Upvote/downvote arrows — functional, persisted in localStorage as personal vote history
  - "Permalink", "save", "report" links (decorative)

### CSS Guidelines
- Match Old Reddit's actual color palette: `#cee3f8` header, `#eff7ff` body bg, white content cards, `#369` link color
- Verdana/Arial font stack (that's what Old Reddit actually uses)
- 1px solid `#c6c6c6` borders everywhere
- The slightly cramped, information-dense feel is the point — don't modernize it
- Rounded corners only where Old Reddit has them (almost nowhere)
- The "Reddit alien" can be replaced with a book emoji or small custom icon

### JavaScript
- Minimal: load the appropriate JSON file, template the comments into the DOM
- Chapter navigation (prev/next)
- **Vote persistence**: upvotes/downvotes stored in `localStorage` keyed by comment ID. On page load, restore vote state and adjust displayed scores. This is personal reading history — a record of which comments resonated with you.
- Collapse/expand comment threads (like Reddit's `[-]` button)
- `CHAPTERS_ROOT` config variable at the top of `app.js` — set this to the local path where chapter PDFs live (e.g. `file:///C:/Users/.../readdit/chapters/` or a relative path if serving locally)
- No framework needed — vanilla JS is fine for this scope

## Part 3: GitHub Pages Deployment

The `site/` directory should be directly deployable:
- `index.html` at root
- All data in `data/` subdirectory
- No build step needed
- Add a simple `README.md` explaining the project

## Technical Notes

- **Anthropic API**: The processing script should use the Anthropic Python SDK. Two models are used:
  - **Chapter chunking**: `claude-haiku-4.5` — cheap, fast, good enough for structural detection
  - **Persona comments**: `claude-sonnet-4-6` — better writing quality for the discussion comments
  - The user will have `ANTHROPIC_API_KEY` set in their environment.
- **PDF parsing**: `pymupdf` (imported as `fitz`) is the best option — gives font sizes for heading detection, handles most PDFs well. Also used to extract chapter page ranges as separate PDF files.
- **Chapter detection heuristic**: Be generous with what counts as a chapter break. Better to over-split than under-split. Let the user manually adjust the JSON if needed.
- **Rate limiting**: Process chapters sequentially with a small delay between API calls. No need to parallelize.
- **Error handling**: If a chapter fails to generate comments, log it and continue. The site should gracefully handle chapters with missing comments.
- **Chapter PDFs are local only**: The `chapters/` directory should be in `.gitignore`. These are copyrighted materials and must not be pushed to GitHub. The site's "Read Chapter" links assume the user is running locally or has the PDFs accessible at the configured `CHAPTERS_ROOT` path.

## Nice-to-haves (not required for v1)
- Dark mode toggle (Old Reddit didn't have one, but RES did)
- Keyboard navigation (j/k to move between comments, like RES)
- "Mark as read" state persisted in localStorage (grey out chapters you've visited)
- Export your vote history as a reading reflection artifact
- Search across all comments/books
