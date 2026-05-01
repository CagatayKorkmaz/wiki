// Fetch helper for Notion Proxy
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

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadRecentPages() {
  const list = document.getElementById("recentPagesList");
  if (!list) return;
  list.innerHTML = `<p class="text-gray-400 text-sm">Loading...</p>`;

  try {
    const data = await getAllPages();
    list.innerHTML = "";

    const pages = data.slice(0, 5); // Already sorted by last_edited_time in proxy

    if (pages.length === 0) {
      list.innerHTML = `<p class="text-gray-400 text-sm">Henüz sayfa yok.</p>`;
      return;
    }

    pages.forEach((page) => {
      const container = document.createElement("a");
      container.href = `page.html?slug=${page.slug}`;
      container.className = "block border border-border-dark p-3 hover:bg-white/10 transition";

      const labelDate = new Date(page.updated_at).toLocaleDateString("tr-TR");
      const labelText = `Güncellendi: ${labelDate}`;

      container.innerHTML = `
        <div class="flex justify-between items-center">
          <span class="font-bold text-white">${escapeHtml(page.title || '')}</span>
          <small class="text-gray-400 ml-3 whitespace-nowrap">${labelText}</small>
        </div>
      `;
      list.appendChild(container);
    });
  } catch (error) {
    list.innerHTML = `<p class="text-red-400">Hata: ${error.message}</p>`;
  }
}

loadRecentPages();

function loadRecentlyVisited() {
  const list = document.getElementById('recentVisitedList');
  if (!list) return;
  list.innerHTML = '';
  let items = [];
  try {
    items = JSON.parse(localStorage.getItem('recentVisited') || '[]');
  } catch (_) { items = []; }
  
  if (!items.length) {
    list.innerHTML = `<p class="text-gray-400 text-sm">Henüz ziyaret yok.</p>`;
    return;
  }
  
  items.sort((a,b) => new Date(b.visited_at||0) - new Date(a.visited_at||0));
  items.slice(0,5).forEach(v => {
    const a = document.createElement('a');
    a.href = `page.html?slug=${v.slug}`;
    a.className = 'block border border-border-dark p-3 hover:bg-white/10 transition';
    const when = v.visited_at ? new Date(v.visited_at).toLocaleDateString("tr-TR") : '';
    a.innerHTML = `
      <div class="flex justify-between items-center">
        <span class="font-bold text-white">${escapeHtml(v.title || v.slug || '')}</span>
        <small class="text-gray-400 ml-3 whitespace-nowrap">${when}</small>
      </div>`;
    list.appendChild(a);
  });
}

loadRecentlyVisited();

async function loadAllPages() {
  const container = document.getElementById('allPagesList');
  if (!container) return;
  container.innerHTML = `<p class="text-gray-400 text-sm">Loading...</p>`;

  try {
    const data = await getAllPages();
    
    // Yalnızca üst sayfaları (parent_id'si olmayanları) listeliyoruz
    const rootPages = data.filter(p => !p.parent_id);
    // İsme göre A-Z sırala
    rootPages.sort((a, b) => a.title.localeCompare(b.title, 'tr'));

    if (!rootPages.length) {
      container.innerHTML = `<p class="text-gray-400 text-sm">Hiç ana sayfa bulunamadı.</p>`;
      return;
    }

    container.innerHTML = '';
    rootPages.forEach(p => {
      const a = document.createElement('a');
      a.href = `page.html?slug=${p.slug}`;
      a.className = 'border border-white/30 text-white/80 py-1 px-3 text-sm hover:bg-white/20 transition';
      a.textContent = p.title;
      container.appendChild(a);
    });
  } catch (error) {
    container.innerHTML = `<p class="text-red-400">Hata: ${error.message}</p>`;
  }
}

loadAllPages();

// Admin Button behavior - directly open Notion if they want, but let's hide or remove it.
const openLoginBtn = document.getElementById('openLogin');
if(openLoginBtn) openLoginBtn.style.display = 'none';
