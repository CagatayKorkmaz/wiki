// Global Search (shared across pages)
// - Local index: title/slug/tags/sidebar_info (scored)
// - Optional deep search: plain-text content cache (sessionStorage)
// - Fallback: server search via /api/notion?search=...

async function fetchNotionList() {
  const cachedStr = localStorage.getItem('notion_pages_cache');
  const cacheTime = localStorage.getItem('notion_pages_cache_time');
  const now = Date.now();
  
  if (cachedStr && cacheTime && (now - parseInt(cacheTime) < 15 * 60 * 1000)) {
    return JSON.parse(cachedStr);
  }
  
  try {
    const res = await fetch('/api/notion?list=true');
    if (!res.ok) return cachedStr ? JSON.parse(cachedStr) : [];
    const json = await res.json();
    const data = json.data || [];
    localStorage.setItem('notion_pages_cache', JSON.stringify(data));
    localStorage.setItem('notion_pages_cache_time', now.toString());
    return data;
  } catch (e) {
    if (cachedStr) return JSON.parse(cachedStr);
    return [];
  }
}

let allPagesCache = null;
async function getAllPages() {
  if (allPagesCache) return allPagesCache;
  allPagesCache = await fetchNotionList();
  return allPagesCache;
}

const openSearchBtn = document.getElementById('openSearch');
const searchModal = document.getElementById('searchModal');
const closeSearchBtn = document.getElementById('closeSearch');
const modalInput = document.getElementById('modalSearchInput');
const resultsContainer = document.getElementById('searchResults');
const searchBackdrop = document.getElementById('searchBackdrop');

let activeIndex = -1;

function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function normalizeText(s) {
  if (!s) return "";
  try {
    return String(s)
      .toLocaleLowerCase("tr-TR")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/ı/g, "i")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  } catch (_) {
    return String(s).toLowerCase().replace(/\s+/g, " ").trim();
  }
}

function parseSearchQuery(input) {
  const raw = (input || "").trim();
  const norm = normalizeText(raw);
  const tokens = norm.split(" ").filter(Boolean);

  // Quick tag filter syntax:
  // - "#etiket"
  // - "tag:etiket"
  let tag = null;
  const remaining = [];
  tokens.forEach((t) => {
    if (t.startsWith("#") && t.length > 1) {
      tag = t.slice(1);
      return;
    }
    if (t.startsWith("tag:") && t.length > 4) {
      tag = t.slice(4);
      return;
    }
    remaining.push(t);
  });

  return { raw, norm, tokens: remaining, tag };
}

function highlight(text, query) {
  if (!text) return '';
  if (!query) return escapeHtml(text);
  try {
    const esc = query.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
    return escapeHtml(text).replace(new RegExp(`(${esc})`, 'gi'), '<span class="text-gold font-semibold">$1</span>');
  } catch (_) { return escapeHtml(text); }
}

function htmlToPlainText(htmlStr) {
  if (!htmlStr) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = htmlStr;
  return (tmp.textContent || tmp.innerText || "").replace(/\s+/g, " ").trim();
}

function getSnippetFromPlain(plainText, queryRaw) {
  if (!plainText) return "";
  const text = String(plainText).replace(/\s+/g, " ");
  const q = (queryRaw || "").trim();
  if (!q) return escapeHtml(text.substring(0, 140)) + (text.length > 140 ? "..." : "");

  // Prefer index on near-original text to keep snippet offsets stable.
  let idx = -1;
  try {
    const hay = text.toLocaleLowerCase("tr-TR").replace(/ı/g, "i");
    const needle = q.toLocaleLowerCase("tr-TR").replace(/ı/g, "i");
    idx = hay.indexOf(needle);
  } catch (_) {
    idx = text.toLowerCase().indexOf(q.toLowerCase());
  }

  if (idx === -1) {
    const ok = normalizeText(text).includes(normalizeText(q));
    if (!ok) return escapeHtml(text.substring(0, 140)) + (text.length > 140 ? "..." : "");
    idx = 0;
  }

  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + q.length + 90);
  let snippet = text.substring(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";
  return highlight(snippet, q);
}

function getSnippet(htmlStrOrPlain, query) {
  if (!htmlStrOrPlain) return "";
  const s = String(htmlStrOrPlain);
  const plain = s.includes("<") ? htmlToPlainText(s) : s;
  return getSnippetFromPlain(plain, query);
}

function saveRecentSearch(slug, title, dateStr) {
  let arr = JSON.parse(localStorage.getItem('recentSearches') || '[]');
  arr = arr.filter(it => it.slug !== slug);
  arr.unshift({ slug, title, updated_at: dateStr });
  if (arr.length > 3) arr = arr.slice(0, 3);
  localStorage.setItem('recentSearches', JSON.stringify(arr));
}

function showRecentSearches() {
  if (!resultsContainer) return;
  const items = JSON.parse(localStorage.getItem('recentSearches') || '[]');
  if (items.length === 0) {
    resultsContainer.innerHTML = `<p class="text-gray-400">Son arama geçmişi yok.</p>`;
    return;
  }
  resultsContainer.innerHTML = `<p class="text-gray-400 mb-2 mt-2 text-sm uppercase tracking-wider">Son Aranan Sayfalar</p>`;

  items.forEach((row, idx) => {
    const a = document.createElement('a');
    a.href = `page.html?slug=${row.slug}`;
    a.className = 'block border-b border-border-dark py-3 px-1 text-white hover:bg-white/5 transition search-item';
    const date = row.updated_at ? new Date(row.updated_at).toLocaleDateString("tr-TR") : '';
    a.innerHTML = `
      <div class="flex justify-between items-start">
        <span class="text-[1.05rem] text-white tracking-wide">${escapeHtml(row.title || '')}</span>
        <small class="text-gray-400 whitespace-nowrap ml-2 mt-1">${date}</small>
      </div>`;
    a.dataset.index = String(idx);
    a.addEventListener('click', () => saveRecentSearch(row.slug, row.title, row.updated_at));
    resultsContainer.appendChild(a);
  });
  activeIndex = items.length ? 0 : -1;
  updateActiveItem();
}

function showModal() {
  if (searchModal) {
    searchModal.style.display = 'flex';
    const panel = searchModal.querySelector('div');
    if (panel) {
      panel.classList.remove('modal-leave-active');
      panel.classList.add('modal-enter');
      requestAnimationFrame(() => {
        panel.classList.add('modal-enter-active');
        panel.classList.remove('modal-enter');
      });
    }
  }
  if (searchBackdrop) searchBackdrop.style.display = 'block';
  modalInput?.focus();
  if (modalInput) modalInput.value = '';
  if (resultsContainer) resultsContainer.innerHTML = '';
  showRecentSearches();
}

function hideModal() {
  if (searchModal) {
    const panel = searchModal.querySelector('div');
    if (panel) {
      panel.classList.remove('modal-enter-active');
      panel.classList.add('modal-leave-active');
      setTimeout(() => {
        searchModal.style.display = 'none';
      }, 180);
    } else {
      searchModal.style.display = 'none';
    }
  }
  if (searchBackdrop) searchBackdrop.style.display = 'none';
}

function updateActiveItem() {
  if (!resultsContainer) return;
  const nodes = Array.from(resultsContainer.querySelectorAll('.search-item'));
  nodes.forEach((el, i) => {
    if (i === activeIndex) {
      el.classList.add('bg-white/10');
      el.scrollIntoView({ block: 'nearest' });
    } else {
      el.classList.remove('bg-white/10');
    }
  });
}

function renderResults(items, query, headerTitle = null) {
  if (!resultsContainer) return;

  if (headerTitle && items.length > 0) {
    const h = document.createElement('p');
    h.className = "text-gray-400 mb-2 mt-4 text-sm uppercase tracking-wider";
    h.textContent = headerTitle;
    resultsContainer.appendChild(h);
  }

  items.forEach((row) => {
    const a = document.createElement('a');
    a.href = `page.html?slug=${row.slug}`;
    a.className = 'block border-b border-border-dark py-3 px-1 text-white hover:bg-white/5 transition search-item';

    const date = row.updated_at ? new Date(row.updated_at).toLocaleDateString("tr-TR") : '';
    const titleHtml = highlight(row.title || '', query);
    const tagLine = (row.tags && row.tags.length)
      ? `<div class="text-[0.75rem] text-gray-400 mt-1" style="font-family: 'Cinzel', serif;">Etiketler: ${escapeHtml(row.tags.join(', '))}</div>`
      : '';

    let parentLine = '';
    try {
      if (row.parent_id && Array.isArray(allPagesCache)) {
        const parent = allPagesCache.find(p => p.id === row.parent_id);
        if (parent?.title) {
          parentLine = `<div class="text-[0.75rem] text-gray-500 mt-1" style="font-family: 'Cinzel', serif;">Üst: ${escapeHtml(parent.title)}</div>`;
        }
      }
    } catch (_) { }

    let hasLocalSnippet = false;
    let initialSnippet = "";
    if (row.sidebar_info && String(row.sidebar_info).toLowerCase().includes(String(query).toLowerCase())) {
      initialSnippet = getSnippet(row.sidebar_info, query);
      hasLocalSnippet = true;
    }

    a.innerHTML = `
      <div class="flex justify-between items-start">
        <span class="text-[1.05rem] text-white tracking-wide">${titleHtml}</span>
        <small class="text-gray-400 whitespace-nowrap ml-2 mt-1">${date}</small>
      </div>
      ${tagLine}
      ${parentLine}
      <div class="search-snippet text-[0.8rem] text-gray-300 mt-1.5 leading-relaxed" style="font-family: 'EB Garamond', serif;">${initialSnippet}</div>
    `;

    a.dataset.index = String(resultsContainer.querySelectorAll('.search-item').length);
    a.addEventListener('click', () => saveRecentSearch(row.slug, row.title, row.updated_at));
    resultsContainer.appendChild(a);

    if (!hasLocalSnippet) {
      const snippetDiv = a.querySelector('.search-snippet');
      const contentCache = JSON.parse(sessionStorage.getItem('wiki_contents_full') || '{}');
      let plainCache = {};
      try { plainCache = JSON.parse(sessionStorage.getItem('wiki_contents_plain') || '{}') || {}; } catch (_) { plainCache = {}; }

      if (plainCache[row.slug]) {
        snippetDiv.innerHTML = getSnippet(plainCache[row.slug], query);
      } else if (contentCache[row.slug]) {
        snippetDiv.innerHTML = getSnippet(contentCache[row.slug], query);
      } else {
        fetch(`/api/notion?slug=${row.slug}`)
          .then(r => r.json())
          .then(json => {
            if (json && json.data && json.data.content) {
              const plain = htmlToPlainText(json.data.content);
              try {
                const pc = JSON.parse(sessionStorage.getItem('wiki_contents_plain') || '{}');
                pc[row.slug] = plain;
                sessionStorage.setItem('wiki_contents_plain', JSON.stringify(pc));
              } catch (_) { }
              snippetDiv.innerHTML = getSnippetFromPlain(plain, query);
            }
          }).catch(() => { });
      }
    }
  });

  const allItems = resultsContainer.querySelectorAll('.search-item');
  activeIndex = allItems.length ? 0 : -1;
  updateActiveItem();
}

async function doSearch(q) {
  const parsed = parseSearchQuery(q);
  if (!parsed.raw || parsed.raw.length < 2) {
    showRecentSearches();
    return;
  }

  if (resultsContainer) resultsContainer.innerHTML = `<p class="text-gray-400">Aranıyor...</p>`;

  try {
    const pages = await getAllPages();
    const queryNorm = parsed.norm;
    const tokens = parsed.tokens;
    const tagFilter = parsed.tag ? normalizeText(parsed.tag) : null;

    const scorePage = (p) => {
      const title = normalizeText(p.title || "");
      const slugN = normalizeText(p.slug || "");
      const sidebar = normalizeText(p.sidebar_info || "");
      const tags = (p.tags || []).map(t => normalizeText(t));

      if (tagFilter) {
        const ok = tags.some(t => t.includes(tagFilter));
        if (!ok) return null;
      }

      for (const t of tokens) {
        if (!t) continue;
        const ok =
          title.includes(t) ||
          slugN.includes(t) ||
          sidebar.includes(t) ||
          tags.some(x => x.includes(t));
        if (!ok) return null;
      }

      let score = 0;
      const qJoined = tokens.join(" ") || queryNorm;

      if (title === qJoined) score += 5000;
      if (title.startsWith(qJoined)) score += 2000;
      if (title.includes(qJoined)) score += 1200;
      if (slugN === qJoined) score += 1100;
      if (slugN.includes(qJoined)) score += 600;
      if (tags.some(t => t === qJoined)) score += 700;
      if (tags.some(t => t.includes(qJoined))) score += 450;
      if (sidebar.includes(qJoined)) score += 250;
      if (!p.parent_id) score += 60;

      const updated = p.updated_at ? Date.parse(p.updated_at) : 0;
      score += Math.min(50, Math.floor(updated / 86400000) % 50);

      return score;
    };

    const exactMatches = (pages || [])
      .map(p => {
        const score = scorePage(p);
        if (score === null) return null;
        return { ...p, _score: score };
      })
      .filter(Boolean)
      .sort((a, b) => (b._score || 0) - (a._score || 0))
      .slice(0, 20);

    const localDeepMatches = [];
    if (queryNorm.length >= 3) {
      let plainCache = {};
      try {
        plainCache = JSON.parse(sessionStorage.getItem('wiki_contents_plain') || '{}') || {};
      } catch (_) { plainCache = {}; }

      const htmlCache = JSON.parse(sessionStorage.getItem('wiki_contents_full') || '{}');
      const plainCount = Object.keys(plainCache).length;
      const htmlCount = Object.keys(htmlCache || {}).length;
      if (htmlCount > 0 && plainCount < Math.min(5, htmlCount)) {
        try {
          Object.keys(htmlCache).forEach((slug) => {
            if (!plainCache[slug]) plainCache[slug] = htmlToPlainText(htmlCache[slug]);
          });
          sessionStorage.setItem('wiki_contents_plain', JSON.stringify(plainCache));
        } catch (_) { }
      }

      const already = new Set(exactMatches.map(x => x.slug));
      const tokenNeedles = tokens.length ? tokens : [queryNorm];

      (pages || []).forEach((p) => {
        if (already.has(p.slug)) return;
        const plain = plainCache[p.slug];
        if (!plain) return;

        const hay = normalizeText(plain);
        const ok = tokenNeedles.every((t) => hay.includes(t));
        if (!ok) return;

        localDeepMatches.push({ ...p, _score: 150 });
      });
    }

    const combinedLocal = [...exactMatches, ...localDeepMatches].slice(0, 20);

    if (resultsContainer) resultsContainer.innerHTML = '';
    const highlightQuery = tokens.join(" ").trim();

    if (combinedLocal.length > 0) {
      const header = tagFilter ? `Yerel Sonuçlar (Tag: ${parsed.tag})` : "Yerel Sonuçlar";
      renderResults(combinedLocal, highlightQuery || parsed.raw, header);
    } else if (resultsContainer) {
      resultsContainer.innerHTML = `<p class="text-gray-400">Yerel bellekte bulunamadı, sunucu taraması yapılıyor...</p>`;
    }

    const shouldCallServer =
      parsed.raw.length >= 3 &&
      (combinedLocal.length < 6 || (tagFilter && combinedLocal.length < 3));

    if (shouldCallServer) {
      try {
        if (doSearch._abort) doSearch._abort.abort();
      } catch (_) { }
      const ac = new AbortController();
      doSearch._abort = ac;

      const res = await fetch(`/api/notion?search=${encodeURIComponent(parsed.raw)}`, { signal: ac.signal });
      if (res.ok) {
        const json = await res.json();
        const apiMatches = json.data || [];

        const newMatches = apiMatches
          .filter(d => !combinedLocal.find(l => l.id === d.id))
          .slice(0, 10);

        if (newMatches.length > 0) {
          if (combinedLocal.length === 0 && resultsContainer) resultsContainer.innerHTML = '';
          renderResults(newMatches, highlightQuery || parsed.raw, "Sunucu Sonuçları 🌐");
        } else if (combinedLocal.length === 0 && resultsContainer) {
          resultsContainer.innerHTML = `<p class="text-gray-400">Koskoca Wiki'de böyle bir kelime bulunamadı!</p>`;
        }
      }
    }
  } catch (error) {
    if (error && error.name === "AbortError") return;
    if (resultsContainer) resultsContainer.innerHTML = `<p class="text-red-400">Ağ Hatası: ${error.message}</p>`;
  }
}

// Wire up events (only if modal exists on the page)
openSearchBtn?.addEventListener('click', showModal);
closeSearchBtn?.addEventListener('click', hideModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideModal();
});

searchModal?.addEventListener('click', (e) => {
  if (e.target === searchModal) hideModal();
});

const debouncedSearch = debounce((e) => doSearch(e.target.value), 350);
modalInput?.addEventListener('input', (e) => {
  if (e.target.value.length === 0) {
    showRecentSearches();
  }
});
modalInput?.addEventListener('input', debouncedSearch);

document.addEventListener('keydown', (e) => {
  if (searchModal?.style.display !== 'flex') return;
  const items = resultsContainer?.querySelectorAll('.search-item') || [];
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex = Math.min(activeIndex + 1, items.length - 1);
    updateActiveItem();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex = Math.max(activeIndex - 1, 0);
    updateActiveItem();
  } else if (e.key === 'Enter') {
    const el = items[activeIndex];
    if (el) window.location.href = el.getAttribute('href');
  }
});

// Background Sync: prefetch page contents to enable deep search without delay.
setTimeout(async () => {
  try {
    const pages = await getAllPages();
    const contentCache = JSON.parse(sessionStorage.getItem('wiki_contents_full') || '{}');
    let plainCache = {};
    try { plainCache = JSON.parse(sessionStorage.getItem('wiki_contents_plain') || '{}') || {}; } catch (_) { plainCache = {}; }

    const missing = pages.filter(p => !contentCache[p.slug]);

    for (const p of missing) {
      try {
        const res = await fetch(`/api/notion?slug=${p.slug}`);
        if (!res.ok) continue;
        const json = await res.json();
        if (json?.data?.content) {
          contentCache[p.slug] = json.data.content;
          plainCache[p.slug] = htmlToPlainText(json.data.content);
          sessionStorage.setItem('wiki_contents_full', JSON.stringify(contentCache));
          sessionStorage.setItem('wiki_contents_plain', JSON.stringify(plainCache));
        }
      } catch (_) { }
      await new Promise(r => setTimeout(r, 600));
    }
  } catch (_) { }
}, 3000);

