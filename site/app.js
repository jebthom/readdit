/* ==========================================================================
   Readdit — app.js
   ========================================================================== */

// Set this to the local path where chapter PDFs live.
const CHAPTERS_ROOT = "/chapters/";

// ---------------------------------------------------------------------------
// Dark mode
// ---------------------------------------------------------------------------

function initDarkMode() {
  const saved = localStorage.getItem("readdit_darkmode");
  let dark;
  if (saved !== null) {
    dark = saved === "1";
  } else {
    // Default to on, but respect system preference if explicitly light
    dark = !window.matchMedia("(prefers-color-scheme: light)").matches;
  }
  applyDarkMode(dark);
}

function applyDarkMode(on) {
  document.documentElement.classList.toggle("dark", on);
  const btn = document.getElementById("darkmode-toggle");
  if (btn) btn.textContent = on ? "light mode" : "dark mode";
}

function toggleDarkMode() {
  const on = !document.documentElement.classList.contains("dark");
  localStorage.setItem("readdit_darkmode", on ? "1" : "0");
  applyDarkMode(on);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

async function fetchJSON(path) {
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`Failed to load ${path}: ${resp.status}`);
  return resp.json();
}

function renderMarkdown(text) {
  if (!text) return "";
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/_(.+?)_/g, "<em>$1</em>");
  html = html.replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/^[-*]\s+(.*)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\s*)+)/g, "<ul>$1</ul>");
  html = html
    .split(/\n{2,}/)
    .map(p => {
      p = p.trim();
      if (!p) return "";
      if (p.startsWith("<blockquote>") || p.startsWith("<ul>") || p.startsWith("<ol>")) return p;
      return `<p>${p.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
  html = html.replace(/<\/blockquote>\s*<blockquote>/g, "<br>");
  return html;
}

// ---------------------------------------------------------------------------
// Vote persistence
// ---------------------------------------------------------------------------

function getVoteState(commentId) {
  const votes = JSON.parse(localStorage.getItem("readdit_votes") || "{}");
  return votes[commentId] || 0;
}

function setVoteState(commentId, state) {
  const votes = JSON.parse(localStorage.getItem("readdit_votes") || "{}");
  votes[commentId] = state;
  localStorage.setItem("readdit_votes", JSON.stringify(votes));
}

function handleVote(commentId, direction, baseScore, el) {
  const current = getVoteState(commentId);
  let newState = direction === current ? 0 : direction;
  setVoteState(commentId, newState);

  const root = el.closest(".comment-vote, .vote-col");
  const scoreEl = root.querySelector(".vote-score");
  const upBtn = root.querySelector(".vote-arrow.up");
  const downBtn = root.querySelector(".vote-arrow.down");

  scoreEl.textContent = baseScore + newState;
  upBtn.classList.toggle("active", newState === 1);
  downBtn.classList.toggle("active", newState === -1);
}

// ---------------------------------------------------------------------------
// Subreddit dropdown (header)
// ---------------------------------------------------------------------------

async function initSubredditDropdown() {
  const dropdown = document.getElementById("sr-dropdown");
  if (!dropdown) return;

  try {
    const manifest = await fetchJSON("data/manifest.json");
    const list = dropdown.querySelector(".sr-dropdown-list");
    if (!list) return;

    for (const entry of manifest.authors) {
      const meta = await fetchJSON(`data/${entry.author_slug}/${entry.book_slug}/meta.json`);
      const a = document.createElement("a");
      a.href = `author.html?author=${entry.author_slug}&book=${entry.book_slug}`;
      a.textContent = `r/${meta.author}`;
      list.appendChild(a);
    }
  } catch {
    // No manifest yet
  }
}

// ---------------------------------------------------------------------------
// Sort helpers
// ---------------------------------------------------------------------------

function renderPostHTML(post, showBookTitle) {
  const voteState = getVoteState(post.voteId);
  const score = 1 + voteState;
  const titlePrefix = showBookTitle ? `${post.bookTitle} - ` : "";

  return `
    <div class="post" data-vote-id="${post.voteId}" data-processed-at="${post.processedAt || ""}" data-score="${1 + getVoteState(post.voteId)}">
      <div class="vote-col">
        <button class="vote-arrow up ${voteState === 1 ? "active" : ""}"
          onclick="handleVote('${post.voteId}', 1, 1, this)"></button>
        <span class="vote-score">${score}</span>
        <button class="vote-arrow down ${voteState === -1 ? "active" : ""}"
          onclick="handleVote('${post.voteId}', -1, 1, this)"></button>
      </div>
      <div class="thumb">${post.chapterNumber}</div>
      <div class="post-body">
        <div class="post-title">
          <a href="chapter.html?author=${post.authorSlug}&book=${post.bookSlug}&ch=${post.chapterNumber}">${titlePrefix}Chapter ${post.chapterNumber}: ${post.title}</a>
        </div>
        <div class="post-meta">
          submitted by <a class="author" href="#">u/${post.authorSlug}</a> to
          <a href="author.html?author=${post.authorSlug}&book=${post.bookSlug}">r/${post.authorName}</a>
        </div>
        <div class="post-buttons">
          <a href="chapter.html?author=${post.authorSlug}&book=${post.bookSlug}&ch=${post.chapterNumber}">${post.commentCount} comments</a>
          <a href="#">share</a>
          <a href="#">save</a>
        </div>
      </div>
    </div>`;
}

function sortPosts(posts, mode) {
  const sorted = [...posts];
  if (mode === "new") {
    // Sort by processedAt descending, then chapter number descending
    sorted.sort((a, b) => {
      const da = a.processedAt || "";
      const db = b.processedAt || "";
      if (da !== db) return db.localeCompare(da);
      return b.chapterNumber - a.chapterNumber;
    });
  } else if (mode === "top") {
    // Sort by current score (base + vote state) descending
    sorted.sort((a, b) => {
      const sa = 1 + getVoteState(a.voteId);
      const sb = 1 + getVoteState(b.voteId);
      return sb - sa;
    });
  }
  // "hot" is default order (as returned by data)
  return sorted;
}

function setupSortBar(containerEl, posts, showBookTitle) {
  containerEl.querySelectorAll(".menubar a").forEach(link => {
    link.addEventListener("click", e => {
      e.preventDefault();
      const mode = link.textContent.trim();
      // Update selected state
      containerEl.querySelectorAll(".menubar a").forEach(l => l.classList.remove("selected"));
      link.classList.add("selected");
      // Re-render posts
      const listing = containerEl.querySelector(".post-listing");
      if (listing) {
        const sorted = sortPosts(posts, mode);
        listing.innerHTML = sorted.map(p => renderPostHTML(p, showBookTitle)).join("");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Render: Front page (index.html) — all posts across all books
// ---------------------------------------------------------------------------

async function renderFrontPage() {
  const container = document.getElementById("content");
  if (!container) return;

  container.innerHTML = '<div class="loading">Loading...</div>';

  try {
    let manifest;
    try {
      manifest = await fetchJSON("data/manifest.json");
    } catch {
      container.innerHTML = '<div class="empty-state">No books yet. Run process.py to add one!</div>';
      return;
    }

    // Collect all posts across all books
    const allPosts = [];
    for (const entry of manifest.authors) {
      const meta = await fetchJSON(`data/${entry.author_slug}/${entry.book_slug}/meta.json`);
      for (const ch of meta.chapters) {
        allPosts.push({
          voteId: `post_${entry.author_slug}_${entry.book_slug}_${ch.chapter_number}`,
          authorSlug: entry.author_slug,
          bookSlug: entry.book_slug,
          authorName: meta.author,
          bookTitle: meta.title,
          chapterNumber: ch.chapter_number,
          title: ch.title,
          commentCount: ch.comment_count,
          processedAt: meta.processed_at || "",
        });
      }
    }

    let html = '<div class="menubar"><a href="#" class="selected">hot</a><a href="#">new</a><a href="#">top</a></div>';
    html += '<div class="post-listing">';
    html += allPosts.map(p => renderPostHTML(p, true)).join("");
    html += "</div>";
    container.innerHTML = html;

    setupSortBar(container, allPosts, true);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Error loading data: ${err.message}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Render: Author / Book view (author.html)
// ---------------------------------------------------------------------------

async function renderAuthorPage() {
  const container = document.getElementById("content");
  const sidebar = document.getElementById("sidebar");
  if (!container) return;

  const authorSlug = getParam("author");
  const bookSlug = getParam("book");
  if (!authorSlug || !bookSlug) {
    container.innerHTML = '<div class="empty-state">Missing author or book parameter.</div>';
    return;
  }

  container.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const meta = await fetchJSON(`data/${authorSlug}/${bookSlug}/meta.json`);

    const srName = document.getElementById("sr-name");
    if (srName) srName.textContent = `r/${meta.author}`;

    if (sidebar) {
      sidebar.innerHTML = `
        <div class="sidebox">
          <div class="sidebox-title">About r/${meta.author}</div>
          <div class="sidebox-content sub-info">
            <span class="subscriber-count">${Math.floor(Math.random() * 20) + 4} readers</span>
            <span class="users-here">~${Math.floor(Math.random() * 4) + 1} here now</span>
            <hr style="margin: 8px 0; border: none; border-top: 1px solid #e5e5e5;">
            <strong>${meta.title}</strong><br>
            by ${meta.author}<br><br>
            ${meta.chapters.length} chapters
          </div>
        </div>
        <div class="sidebox">
          <div class="sidebox-title">Rules</div>
          <div class="sidebox-content">
            <ol class="rules">
              <li>No spoilers for future chapters</li>
              <li>Be kind to the author</li>
              <li>One chapter at a time</li>
              <li>Cite page numbers when quoting</li>
              <li>Have fun</li>
            </ol>
          </div>
        </div>`;
    }

    const posts = meta.chapters.map(ch => ({
      voteId: `post_${authorSlug}_${bookSlug}_${ch.chapter_number}`,
      authorSlug,
      bookSlug,
      authorName: meta.author,
      bookTitle: meta.title,
      chapterNumber: ch.chapter_number,
      title: ch.title,
      commentCount: ch.comment_count,
      processedAt: meta.processed_at || "",
    }));

    let html = '<div class="menubar"><a href="#" class="selected">hot</a><a href="#">new</a><a href="#">top</a></div>';
    html += '<div class="post-listing">';
    html += posts.map(p => renderPostHTML(p, true)).join("");
    html += "</div>";
    container.innerHTML = html;

    setupSortBar(container, posts, true);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Render: Chapter thread view (chapter.html)
// ---------------------------------------------------------------------------

function renderComment(c) {
  const voteState = getVoteState(c.id);
  const score = c.score + voteState;

  return `
    <div class="comment" id="${c.id}">
      <div class="comment-inner">
        <div class="comment-header">
          <button class="collapse-btn" onclick="toggleCollapse(this)">[&ndash;]</button>
          <span class="comment-author">u/${c.username}</span>
          ${c.flair ? `<span class="comment-flair">${c.flair}</span>` : ""}
          <span class="comment-score">${score} point${score !== 1 ? "s" : ""}</span>
          <span class="comment-time">${c.timestamp_label}</span>
        </div>
        <div class="comment-body">${renderMarkdown(c.body)}</div>
        <div class="comment-buttons">
          <span class="comment-vote">
            <button class="vote-arrow up ${voteState === 1 ? "active" : ""}"
              onclick="handleVote('${c.id}', 1, ${c.score}, this)"></button>
            <button class="vote-arrow down ${voteState === -1 ? "active" : ""}"
              onclick="handleVote('${c.id}', -1, ${c.score}, this)"></button>
          </span>
          <a href="#">permalink</a>
          <a href="#">save</a>
          <a href="#">report</a>
        </div>
        ${c.replies && c.replies.length > 0 ?
          `<div class="comment-replies">${c.replies.map(renderComment).join("")}</div>` : ""}
      </div>
    </div>`;
}

async function renderChapterPage() {
  const container = document.getElementById("content");
  const sidebar = document.getElementById("sidebar");
  if (!container) return;

  const authorSlug = getParam("author");
  const bookSlug = getParam("book");
  const chNum = parseInt(getParam("ch"), 10);
  if (!authorSlug || !bookSlug || !chNum) {
    container.innerHTML = '<div class="empty-state">Missing parameters.</div>';
    return;
  }

  container.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const [meta, chData] = await Promise.all([
      fetchJSON(`data/${authorSlug}/${bookSlug}/meta.json`),
      fetchJSON(`data/${authorSlug}/${bookSlug}/chapters/${String(chNum).padStart(2, "0")}.json`),
    ]);

    const srName = document.getElementById("sr-name");
    if (srName) srName.textContent = `r/${meta.author}`;

    const pdfUrl = `${CHAPTERS_ROOT}${authorSlug}/${bookSlug}/${chData.chapter_pdf}`;
    const totalCh = meta.chapters.length;

    if (sidebar) {
      let chapLinks = meta.chapters
        .map(ch => `<a href="chapter.html?author=${authorSlug}&book=${bookSlug}&ch=${ch.chapter_number}"
          class="${ch.chapter_number === chNum ? "current" : ""}">Ch ${ch.chapter_number}: ${ch.title}</a>`)
        .join("");

      sidebar.innerHTML = `
        <div class="sidebox">
          <div class="sidebox-title">About r/${meta.author}</div>
          <div class="sidebox-content sub-info">
            <strong>${meta.title}</strong><br>
            by ${meta.author}
          </div>
        </div>
        <div class="sidebox">
          <div class="sidebox-title">Chapters</div>
          <div class="sidebox-content chapter-nav">
            ${chapLinks}
          </div>
        </div>
        <div class="sidebox">
          <div class="sidebox-title">Rules</div>
          <div class="sidebox-content">
            <ol class="rules">
              <li>No spoilers for future chapters</li>
              <li>Be kind to the author</li>
              <li>One chapter at a time</li>
              <li>Cite page numbers when quoting</li>
              <li>Have fun</li>
            </ol>
          </div>
        </div>`;
    }

    let navLinks = "";
    if (chNum > 1) {
      navLinks += `<a href="chapter.html?author=${authorSlug}&book=${bookSlug}&ch=${chNum - 1}">&laquo; Prev Chapter</a>`;
    }
    if (chNum < totalCh) {
      navLinks += `<a href="chapter.html?author=${authorSlug}&book=${bookSlug}&ch=${chNum + 1}">Next Chapter &raquo;</a>`;
    }

    let html = `
      <div class="thread-header">
        <div class="post-title">${meta.title} - Chapter ${chData.chapter_number}: ${chData.chapter_title}</div>
        <div class="post-meta">
          submitted by <a class="author" href="#">u/${authorSlug}</a> to
          <a href="author.html?author=${authorSlug}&book=${bookSlug}">r/${meta.author}</a>
        </div>
        <a class="read-chapter-btn" href="${pdfUrl}" target="_blank">&#128214; Read Chapter (PDF)</a>
        <div class="chapter-nav-links">${navLinks}</div>
      </div>`;

    html += '<div class="comments-area">';
    html += '<div class="comment-sort">sorted by: <a href="#" class="selected">best</a><a href="#">top</a><a href="#">new</a></div>';

    if (chData.comments && chData.comments.length > 0) {
      html += chData.comments.map(renderComment).join("");
    } else {
      html += '<div class="empty-state">No comments yet.</div>';
    }

    html += "</div>";
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Collapse/expand
// ---------------------------------------------------------------------------

function toggleCollapse(btn) {
  const comment = btn.closest(".comment");
  comment.classList.toggle("collapsed");
  btn.textContent = comment.classList.contains("collapsed") ? "[+]" : "[–]";
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  initDarkMode();
  initSubredditDropdown();
});
