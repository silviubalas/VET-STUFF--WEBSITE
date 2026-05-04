const POSTS_INDEX = 'posts/posts.json';
const POSTS_DIR   = 'posts/';
const PAGE_SIZE   = 12;

if (document.getElementById('blog-list')) initBlogList();
if (document.getElementById('blog-post')) initBlogPost();


// ── PAGINA LISTĂ ──────────────────────────────────────────────────────────────

async function initBlogList() {
  const container = document.getElementById('blog-list');

  try {
    const posts = await fetchPosts();

    if (!posts.length) {
      container.innerHTML = '<p class="blog-empty">Nu există articole momentan.</p>';
      return;
    }

    let currentPage = 0;
    const totalPages = Math.ceil(posts.length / PAGE_SIZE);

    function render() {
      const start = currentPage * PAGE_SIZE;
      const pagePosts = posts.slice(start, start + PAGE_SIZE);
      const cards = pagePosts.map(renderCard).join('');

      container.innerHTML =
        `<div class="blog-grid">${cards}</div>` +
        renderPagination(totalPages, currentPage);

      container.querySelectorAll('.page-btn[data-page]').forEach(btn => {
        btn.addEventListener('click', () => {
          currentPage = parseInt(btn.dataset.page, 10);
          render();
          window.scrollTo({ top: container.offsetTop - 120, behavior: 'smooth' });
        });
      });
    }

    render();

  } catch (err) {
    container.innerHTML = '<p class="blog-error">Eroare la încărcarea articolelor. Încearcă din nou.</p>';
    console.error('[Blog] initBlogList:', err);
  }
}

function renderCard(post) {
  const url = `post.html?slug=${encodeURIComponent(post.slug)}`;
  const imgHtml = post.cover
    ? `<a href="${url}" class="blog-card-img-link" tabindex="-1" aria-hidden="true">
         <img src="${escapeHtml(post.cover)}" alt="${escapeHtml(post.title)}" class="blog-card-img" loading="lazy"
              onerror="this.closest('.blog-card-img-link').style.display='none'">
       </a>`
    : '';
  return `
    <article class="blog-card${post.cover ? ' has-img' : ''}">
      ${imgHtml}
      <div class="blog-card-body">
        <div class="blog-card-tags">${post.tags.slice(0, 2).map(t => `<span class="blog-tag">${escapeHtml(t)}</span>`).join('')}</div>
        <h2 class="blog-card-title"><a href="${url}">${escapeHtml(post.title)}</a></h2>
        <time class="blog-card-date" datetime="${post.date}">${formatDate(post.date)}</time>
      </div>
    </article>
  `;
}

function renderPagination(totalPages, currentPage) {
  if (totalPages <= 1) return '';

  const prevBtn = currentPage > 0
    ? `<button class="page-btn page-nav" data-page="${currentPage - 1}">‹ Înapoi</button>`
    : '';
  const nextBtn = currentPage < totalPages - 1
    ? `<button class="page-btn page-nav" data-page="${currentPage + 1}">Înainte ›</button>`
    : '';

  let pageNums = '';
  for (let i = 0; i < totalPages; i++) {
    pageNums += `<button class="page-btn${i === currentPage ? ' active' : ''}" data-page="${i}">${i + 1}</button>`;
  }

  return `<nav class="pagination" aria-label="Paginare">${prevBtn}${pageNums}${nextBtn}</nav>`;
}


// ── PAGINA ARTICOL ────────────────────────────────────────────────────────────

async function initBlogPost() {
  const slug = new URLSearchParams(window.location.search).get('slug');

  if (!slug) {
    showPostError('Lipsește parametrul <code>?slug=</code> din URL.');
    return;
  }

  try {
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

function renderPost(meta, markdown) {
  document.title = `${meta.title} | Blog VET STUFF`;

  const metaEl = document.getElementById('post-meta');
  if (metaEl) {
    const coverHtml = meta.cover
      ? `<div class="post-cover">
           <img src="${escapeHtml(meta.cover)}" alt="${escapeHtml(meta.title)}" loading="eager"
                onerror="this.closest('.post-cover').style.display='none'">
         </div>`
      : '';
    metaEl.innerHTML = `
      ${coverHtml}
      <div class="post-tags">${meta.tags.map(t => `<span class="blog-tag">${escapeHtml(t)}</span>`).join('')}</div>
      <h1 class="post-title">${escapeHtml(meta.title)}</h1>
      <time class="post-date" datetime="${meta.date}">${formatDate(meta.date)}</time>
    `;
  }

  document.getElementById('blog-post').innerHTML = marked.parse(markdown);
}

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


// ── UTILITARE ─────────────────────────────────────────────────────────────────

async function fetchPosts() {
  const res = await fetch(POSTS_INDEX);
  if (!res.ok) throw new Error(`fetch posts.json → HTTP ${res.status}`);
  const data = await res.json();
  return data.sort((a, b) => new Date(b.date) - new Date(a.date));
}

async function fetchMarkdown(slug) {
  const res = await fetch(`${POSTS_DIR}${slug}.md`);
  if (!res.ok) throw new Error(`fetch ${slug}.md → HTTP ${res.status}`);
  return res.text();
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('ro-RO', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
