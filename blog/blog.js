// ─────────────────────────────────────────────────────────────────────────────
// blog.js — Logica blogului VET STUFF
// Detectează automat pagina curentă și inițializează funcționalitatea corectă.
// Folosit atât de blog/index.html cât și de blog/post.html.
// ─────────────────────────────────────────────────────────────────────────────

const POSTS_INDEX = 'posts/posts.json'; // indexul cu metadata tuturor articolelor
const POSTS_DIR   = 'posts/';           // directorul cu fișierele .md

// Detectăm pagina după elementele prezente în DOM
if (document.getElementById('blog-list')) initBlogList();
if (document.getElementById('blog-post')) initBlogPost();


// ─────────────────────────────────────────────────────────────────────────────
// PAGINA LISTĂ — blog/index.html
// ─────────────────────────────────────────────────────────────────────────────

async function initBlogList() {
  const container = document.getElementById('blog-list');

  try {
    const posts = await fetchPosts();

    if (!posts.length) {
      container.innerHTML = '<p class="blog-empty">Nu există articole momentan.</p>';
      return;
    }

    container.innerHTML = posts.map(renderCard).join('');

  } catch (err) {
    container.innerHTML = '<p class="blog-error">Eroare la încărcarea articolelor. Încearcă din nou.</p>';
    console.error('[Blog] initBlogList:', err);
  }
}

// Generează HTML-ul pentru un card din grila de articole
function renderCard(post) {
  const url = `post.html?slug=${encodeURIComponent(post.slug)}`;
  return `
    <article class="blog-card">
      <div class="blog-card-top">
        <div class="blog-card-tags">${post.tags.map(t => `<span class="blog-tag">${escapeHtml(t)}</span>`).join('')}</div>
        <time class="blog-card-date" datetime="${post.date}">${formatDate(post.date)}</time>
      </div>
      <h2 class="blog-card-title"><a href="${url}">${escapeHtml(post.title)}</a></h2>
      <p class="blog-card-excerpt">${escapeHtml(post.excerpt)}</p>
      <a href="${url}" class="blog-card-cta">
        Citește articolul
        <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
      </a>
    </article>
  `;
}


// ─────────────────────────────────────────────────────────────────────────────
// PAGINA ARTICOL — blog/post.html
// ─────────────────────────────────────────────────────────────────────────────

async function initBlogPost() {
  // Extragem slug-ul din query string: post.html?slug=primul-articol
  const slug = new URLSearchParams(window.location.search).get('slug');

  if (!slug) {
    showPostError('Lipsește parametrul <code>?slug=</code> din URL.');
    return;
  }

  try {
    // Încărcăm în paralel indexul JSON și fișierul Markdown
    const [posts, markdown] = await Promise.all([
      fetchPosts(),
      fetchMarkdown(slug)
    ]);

    const meta = posts.find(p => p.slug === slug);
    if (!meta) {
      showPostError(`Articolul <code>${escapeHtml(slug)}</code> nu există în posts.json.`);
      return;
    }

    renderPost(meta, markdown);

  } catch (err) {
    showPostError('Nu am putut încărca articolul. Încearcă din nou.');
    console.error('[Blog] initBlogPost:', err);
  }
}

// Randează header-ul și conținutul articolului în DOM
function renderPost(meta, markdown) {
  // Actualizăm titlul tab-ului
  document.title = `${meta.title} | Blog VET STUFF`;

  // Injectăm meta-ul articolului deasupra conținutului
  const metaEl = document.getElementById('post-meta');
  if (metaEl) {
    metaEl.innerHTML = `
      <div class="post-tags">${meta.tags.map(t => `<span class="blog-tag">${escapeHtml(t)}</span>`).join('')}</div>
      <h1 class="post-title">${escapeHtml(meta.title)}</h1>
      <time class="post-date" datetime="${meta.date}">${formatDate(meta.date)}</time>
    `;
  }

  // Convertim Markdown → HTML cu marked și injectăm în container
  document.getElementById('blog-post').innerHTML = marked.parse(markdown);
}

// Afișează un mesaj de eroare în locul conținutului articolului
function showPostError(msg) {
  const metaEl = document.getElementById('post-meta');
  if (metaEl) metaEl.innerHTML = '';

  document.getElementById('blog-post').innerHTML = `
    <div class="blog-error">
      <p>${msg}</p>
      <a href="index.html" class="blog-back-inline">← Înapoi la blog</a>
    </div>
  `;
}


// ─────────────────────────────────────────────────────────────────────────────
// UTILITARE
// ─────────────────────────────────────────────────────────────────────────────

// Încarcă posts.json și returnează articolele sortate descrescător după dată
async function fetchPosts() {
  const res = await fetch(POSTS_INDEX);
  if (!res.ok) throw new Error(`fetch posts.json → HTTP ${res.status}`);
  const data = await res.json();
  return data.sort((a, b) => new Date(b.date) - new Date(a.date));
}

// Încarcă conținutul .md al unui articol după slug
async function fetchMarkdown(slug) {
  const res = await fetch(`${POSTS_DIR}${slug}.md`);
  if (!res.ok) throw new Error(`fetch ${slug}.md → HTTP ${res.status}`);
  return res.text();
}

// Formatează data ISO → română: "1 mai 2026"
function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('ro-RO', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

// Escapează HTML pentru textele afișate direct din JSON (titluri, excerpt-uri)
// Previne XSS în cazul în care posts.json conține caractere speciale
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
