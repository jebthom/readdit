#!/usr/bin/env python3
"""
process.py — PDF → chapter PDFs + AI comments → static JSON

Usage:
    python process.py "path/to/book.pdf" --title "Book Title" --author "Author Name"
"""

import argparse
from datetime import datetime, timezone
import json
import os
import random
import re
import sys
import time
import unicodedata

import anthropic
import fitz  # pymupdf


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text.lower())
    return re.sub(r"[-\s]+", "-", text).strip("-")


def random_timestamp(chapter_index: int, total_chapters: int) -> str:
    """Earlier chapters get older timestamps."""
    max_hours = 24 * 7  # one week
    base = int((1 - chapter_index / max(total_chapters, 1)) * max_hours)
    hours = max(1, base + random.randint(-3, 3))
    if hours < 24:
        return f"{hours} hours ago"
    days = hours // 24
    return f"{days} days ago"


# ---------------------------------------------------------------------------
# PDF text extraction
# ---------------------------------------------------------------------------

def extract_text_with_pages(pdf_path: str) -> list[dict]:
    """Return list of {page_num (1-based), text, max_font_size, bold_lines}."""
    doc = fitz.open(pdf_path)
    pages = []
    for i, page in enumerate(doc):
        blocks = page.get_text("dict")["blocks"]
        page_text = page.get_text("text")
        max_font = 0
        bold_lines = []
        for block in blocks:
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    size = span.get("size", 0)
                    if size > max_font:
                        max_font = size
                    flags = span.get("flags", 0)
                    if flags & 2**4:  # bold flag
                        bold_lines.append(span.get("text", "").strip())
        pages.append({
            "page_num": i + 1,
            "text": page_text,
            "max_font_size": max_font,
            "bold_lines": bold_lines,
        })
    doc.close()
    return pages


# ---------------------------------------------------------------------------
# Chapter detection — Pass 1: heuristics
# ---------------------------------------------------------------------------

CHAPTER_PATTERNS = [
    re.compile(r"^\s*chapter\s+\w+", re.IGNORECASE),
    re.compile(r"^\s*CHAPTER\s+\w+"),
    re.compile(r"^\s*Part\s+\w+", re.IGNORECASE),
    re.compile(r"^\s*\d+\.\s+\w+"),              # "1. Title"
    re.compile(r"^\s*(?:I{1,3}|IV|V|VI{0,3}|IX|X)\.\s", re.IGNORECASE),
]


def heuristic_chapter_breaks(pages: list[dict]) -> list[dict]:
    """Return candidate chapter starts: [{title, start_page}]."""
    if not pages:
        return []

    # Determine the "body" font size (most common max font per page)
    font_sizes = [p["max_font_size"] for p in pages if p["max_font_size"] > 0]
    if not font_sizes:
        return []
    body_font = max(set(font_sizes), key=font_sizes.count)

    candidates = []
    for page in pages:
        # Check bold lines at top of page for chapter patterns
        for line in page["bold_lines"][:5]:
            for pat in CHAPTER_PATTERNS:
                if pat.match(line):
                    candidates.append({
                        "title": line.strip(),
                        "start_page": page["page_num"],
                    })
                    break
            else:
                continue
            break

        # Check if page has a significantly larger font (heading page)
        if page["max_font_size"] > body_font * 1.3:
            first_lines = page["text"].strip().split("\n")[:3]
            for fl in first_lines:
                fl = fl.strip()
                if len(fl) > 3 and len(fl) < 100:
                    # Avoid duplicates on same page
                    if not any(c["start_page"] == page["page_num"] for c in candidates):
                        candidates.append({
                            "title": fl,
                            "start_page": page["page_num"],
                        })
                    break

    # Deduplicate by page
    seen = set()
    deduped = []
    for c in candidates:
        if c["start_page"] not in seen:
            seen.add(c["start_page"])
            deduped.append(c)
    return sorted(deduped, key=lambda x: x["start_page"])


# ---------------------------------------------------------------------------
# Chapter detection — Pass 2: Haiku confirmation
# ---------------------------------------------------------------------------

def haiku_detect_chapters(pages: list[dict], client: anthropic.Anthropic) -> list[dict] | None:
    """Use claude-haiku-4.5 to confirm/correct chapter boundaries."""
    # Build a condensed representation: first 3 lines of each page with page number
    page_summaries = []
    for p in pages:
        first_lines = p["text"].strip().split("\n")[:3]
        preview = " | ".join(l.strip() for l in first_lines if l.strip())
        if preview:
            page_summaries.append(f"[Page {p['page_num']}] {preview}")

    text_block = "\n".join(page_summaries)
    # Truncate if too long for Haiku
    if len(text_block) > 80_000:
        text_block = text_block[:80_000] + "\n... (truncated)"

    prompt = (
        "Here is a summary of each page of a book (first few lines per page). "
        "Identify the chapter boundaries.\n\n"
        "Return ONLY a JSON array of objects with fields: "
        '"title" (chapter title), "start_page" (int), "end_page" (int).\n\n'
        "Do not include front matter, table of contents, index, or bibliography as chapters. "
        "If you cannot determine chapters, return an empty array [].\n\n"
        f"{text_block}"
    )

    try:
        print("  Asking Haiku to confirm chapter boundaries...")
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text
        # Extract JSON from response
        match = re.search(r"\[.*\]", text, re.DOTALL)
        if match:
            chapters = json.loads(match.group())
            if isinstance(chapters, list) and len(chapters) > 0:
                return chapters
    except Exception as e:
        print(f"  Haiku chapter detection failed: {e}")
    return None


# ---------------------------------------------------------------------------
# Merge heuristic + Haiku results
# ---------------------------------------------------------------------------

def detect_chapters(pages: list[dict], client: anthropic.Anthropic) -> list[dict]:
    """
    Two-pass chapter detection. Returns list of
    {title, start_page, end_page, chapter_number}.
    """
    total_pages = len(pages)

    # Pass 2: Haiku
    haiku_chapters = haiku_detect_chapters(pages, client)

    if haiku_chapters and len(haiku_chapters) >= 2:
        print(f"  Haiku detected {len(haiku_chapters)} chapters")
        chapters = haiku_chapters
    else:
        # Pass 1: heuristics
        heuristic = heuristic_chapter_breaks(pages)
        if len(heuristic) >= 2:
            print(f"  Heuristics detected {len(heuristic)} chapter breaks")
            # Convert to chapters with end pages
            chapters = []
            for i, h in enumerate(heuristic):
                end_page = heuristic[i + 1]["start_page"] - 1 if i + 1 < len(heuristic) else total_pages
                chapters.append({
                    "title": h["title"],
                    "start_page": h["start_page"],
                    "end_page": end_page,
                })
        else:
            # Fallback: ~20-page chunks
            print("  Falling back to 20-page chunks")
            chunk_size = 20
            chapters = []
            for start in range(1, total_pages + 1, chunk_size):
                end = min(start + chunk_size - 1, total_pages)
                chapters.append({
                    "title": f"Section {len(chapters) + 1}",
                    "start_page": start,
                    "end_page": end,
                })

    # Assign chapter numbers
    for i, ch in enumerate(chapters):
        ch["chapter_number"] = i + 1

    return chapters


# ---------------------------------------------------------------------------
# Extract chapter PDFs
# ---------------------------------------------------------------------------

def extract_chapter_pdfs(pdf_path: str, chapters: list[dict], output_dir: str):
    """Extract each chapter's page range as a separate PDF."""
    os.makedirs(output_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    for ch in chapters:
        ch_doc = fitz.open()
        # pages are 1-based in our data, 0-based in fitz
        start = ch["start_page"] - 1
        end = ch["end_page"] - 1
        ch_doc.insert_pdf(doc, from_page=start, to_page=end)
        filename = f"{ch['chapter_number']:02d}.pdf"
        ch_doc.save(os.path.join(output_dir, filename))
        ch_doc.close()
        ch["chapter_pdf"] = filename
    doc.close()


# ---------------------------------------------------------------------------
# Generate persona comments
# ---------------------------------------------------------------------------

PERSONA_SYSTEM_PROMPT = """\
You are generating discussion comments for a book reading group styled like Reddit.
There are 4 personas who each leave one top-level comment on every chapter.

**u/close_reader** (flair: "Line by Line")
- Focuses on craft, style, structure, rhetoric
- Pulls specific short quotes from the chapter and analyzes what they're doing
- Notices patterns, callbacks, shifts in tone
- Voice: thoughtful, precise, a little nerdy about language

**u/devils_advocate** (flair: "Well, actually...")
- Pushes back on the author's arguments
- Asks "but what about..." and "this assumes that..."
- Steelmans counterarguments
- Voice: respectful but persistent, enjoys the debate

**u/the_connector** (flair: "Reminds me of...")
- Relates the chapter to other books, thinkers, current events, adjacent fields
- Draws surprising parallels
- Suggests further reading
- Voice: enthusiastic, associative, the "oh you should also check out..." person

**u/tldr_bot** (flair: "Summary Bot")
- Extracts the 2-4 most important ideas from the chapter
- Restates them clearly and concisely
- Highlights key terms or concepts introduced
- Voice: neutral, helpful, structured (uses bullet points sparingly)

For each persona, write one comment of 150-300 words. The comments should feel natural, \
like real Reddit posts — not formal essays. Use the persona's distinct voice.

Return your response as a JSON array with exactly 4 objects, one per persona, in this order:
close_reader, devils_advocate, the_connector, tldr_bot.

Each object has fields:
- "username": the persona's username (no u/ prefix)
- "body": the comment text (can include markdown)

Return ONLY the JSON array, no other text."""


def generate_comments(chapter_text: str, chapter_title: str, book_title: str,
                      author: str, client: anthropic.Anthropic) -> list[dict]:
    """Generate persona comments for a chapter."""
    # Truncate chapter text if very long
    if len(chapter_text) > 60_000:
        chapter_text = chapter_text[:60_000] + "\n\n... (chapter text truncated)"

    user_msg = (
        f'Book: "{book_title}" by {author}\n'
        f"Chapter: {chapter_title}\n\n"
        f"--- CHAPTER TEXT ---\n{chapter_text}"
    )

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        system=PERSONA_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )

    text = response.content[0].text
    match = re.search(r"\[.*\]", text, re.DOTALL)
    if not match:
        raise ValueError("Could not parse persona comments JSON from response")

    raw_comments = json.loads(match.group())

    flairs = {
        "close_reader": "\U0001f4d6 Line by Line",
        "devils_advocate": "\U0001f525 Well, actually...",
        "the_connector": "\U0001f517 Reminds me of...",
        "tldr_bot": "\U0001f916 Summary Bot",
    }

    comments = []
    for c in raw_comments:
        username = c["username"]
        comments.append({
            "id": f"c{len(comments)+1}_{username}",
            "username": username,
            "flair": flairs.get(username, ""),
            "body": c["body"],
            "score": 1,
            "timestamp_label": "",  # filled in later
            "replies": [],
        })

    return comments


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Process a book PDF into Readdit format")
    parser.add_argument("pdf", help="Path to the book PDF")
    parser.add_argument("--title", required=True, help="Book title")
    parser.add_argument("--author", required=True, help="Author name")
    args = parser.parse_args()

    if not os.path.isfile(args.pdf):
        print(f"Error: PDF not found: {args.pdf}")
        sys.exit(1)

    author_slug = slugify(args.author)
    book_slug = slugify(args.title)

    print(f"Processing: \"{args.title}\" by {args.author}")
    print(f"  Author slug: {author_slug}")
    print(f"  Book slug:   {book_slug}")

    # 1. Extract text
    print("\n[1/5] Extracting text from PDF...")
    pages = extract_text_with_pages(args.pdf)
    print(f"  {len(pages)} pages extracted")

    # 2. Detect chapters
    print("\n[2/5] Detecting chapters...")
    client = anthropic.Anthropic()  # uses ANTHROPIC_API_KEY env var
    chapters = detect_chapters(pages, client)
    print(f"  {len(chapters)} chapters found:")
    for ch in chapters:
        print(f"    Ch {ch['chapter_number']}: \"{ch['title']}\" (pp. {ch['start_page']}-{ch['end_page']})")

    # 3. Extract chapter PDFs
    print("\n[3/5] Extracting chapter PDFs...")
    chapter_pdf_dir = os.path.join("chapters", author_slug, book_slug)
    extract_chapter_pdfs(args.pdf, chapters, chapter_pdf_dir)
    print(f"  Saved to {chapter_pdf_dir}/")

    # 4. Generate comments
    print("\n[4/5] Generating persona comments...")
    doc = fitz.open(args.pdf)
    for ch in chapters:
        print(f"  Chapter {ch['chapter_number']}: \"{ch['title']}\"...")
        # Extract text for this chapter's pages
        ch_text = ""
        for p in range(ch["start_page"] - 1, ch["end_page"]):
            ch_text += doc[p].get_text("text") + "\n\n"

        try:
            ch["comments"] = generate_comments(
                ch_text, ch["title"], args.title, args.author, client
            )
            # Assign timestamps
            for comment in ch["comments"]:
                comment["timestamp_label"] = random_timestamp(
                    ch["chapter_number"] - 1, len(chapters)
                )
        except Exception as e:
            print(f"    ERROR generating comments: {e}")
            ch["comments"] = []

        # Rate limiting
        time.sleep(1)
    doc.close()

    # 5. Output static JSON
    print("\n[5/5] Writing static JSON...")
    data_dir = os.path.join("site", "data", author_slug, book_slug)
    chapters_json_dir = os.path.join(data_dir, "chapters")
    os.makedirs(chapters_json_dir, exist_ok=True)

    # meta.json
    processed_at = datetime.now(timezone.utc).isoformat()
    meta = {
        "title": args.title,
        "author": args.author,
        "author_slug": author_slug,
        "book_slug": book_slug,
        "processed_at": processed_at,
        "chapters": [
            {
                "chapter_number": ch["chapter_number"],
                "title": ch["title"],
                "comment_count": len(ch.get("comments", [])),
            }
            for ch in chapters
        ],
    }
    meta_path = os.path.join(data_dir, "meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    print(f"  {meta_path}")

    # Per-chapter JSON
    for ch in chapters:
        ch_data = {
            "chapter_number": ch["chapter_number"],
            "chapter_title": ch["title"],
            "chapter_pdf": ch.get("chapter_pdf", f"{ch['chapter_number']:02d}.pdf"),
            "comments": ch.get("comments", []),
        }
        ch_path = os.path.join(chapters_json_dir, f"{ch['chapter_number']:02d}.json")
        with open(ch_path, "w", encoding="utf-8") as f:
            json.dump(ch_data, f, indent=2, ensure_ascii=False)
        print(f"  {ch_path}")

    # Update manifest.json (used by the front page to discover books)
    manifest_path = os.path.join("site", "data", "manifest.json")
    if os.path.isfile(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    else:
        manifest = {"authors": []}

    # Remove existing entry for this book if re-processing
    manifest["authors"] = [
        a for a in manifest["authors"]
        if not (a["author_slug"] == author_slug and a["book_slug"] == book_slug)
    ]
    manifest["authors"].append({
        "author_slug": author_slug,
        "book_slug": book_slug,
    })
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"  {manifest_path}")

    print(f"\nDone! Processed {len(chapters)} chapters.")
    print(f"  Chapter PDFs: {chapter_pdf_dir}/")
    print(f"  Site data:    {data_dir}/")


if __name__ == "__main__":
    main()
