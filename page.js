// Per-session in-memory cache for pages by slug
const pageCache = Object.create(null);

async function fetchAllPages() {
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

// Breadcrumb için zincirleme ID taraması
async function fetchParentChain(start) {
  const allPages = await fetchAllPages();
  const chain = [];
  let curId = start && start.parent_id ? start.parent_id : null;
  let guard = 0;
  
  while (curId && guard++ < 12) {
    const parentPage = allPages.find(p => p.id === curId);
    if (!parentPage) break;
      
    chain.push(parentPage);
    curId = parentPage.parent_id || null;
  }
  return chain.reverse();
}

async function renderBreadcrumbs(page) {
  const header = document.querySelector('.page-header');
  if (!header) return;
  let bc = document.getElementById('breadcrumbs');
  if (!bc) {
    bc = document.createElement('nav');
    bc.id = 'breadcrumbs';
    bc.setAttribute('aria-label', 'Breadcrumb');
    bc.style.marginBottom = '0.5rem';
    bc.style.fontSize = '0.85rem';
    header.parentElement.insertBefore(bc, header);
  }
  const parents = await fetchParentChain(page);
  const parts = [];
  parts.push(`<a href="index.html" class="text-gold" style="text-decoration:none;">Anasayfa</a>`);
  parents.forEach(p => {
    parts.push(`<a href="page.html?slug=${encodeURIComponent(p.slug)}" class="text-gold" style="text-decoration:none;">${p.title || '(sayfa)'}</a>`);
  });
  parts.push(`<span aria-current="page" class="text-gray-300">${page.title || '(bu sayfa)'}</span>`);
  bc.innerHTML = parts.join(' <span class="text-gray-500">›</span> ');
}

// --- OTOMATİK WIKI LİNKLERİ (AUTO-LINKING) FONKSİYONU ---
function autoLinkWikiTerms(rootElement, allPages, currentTitle) {
  if (!allPages || allPages.length === 0) return;
  
  // Başlıkları filtrelenmiş ve zengileştirilmiş bir diziye alıyoruz
  const terms = allPages
    .filter(p => p.title && p.title.toLowerCase() !== (currentTitle || "").toLowerCase())
    .map(p => {
      const lower = String(p.title || "").toLowerCase();
      const normLower = lower.replace(/\s+/g, ' ').trim();
      return { title: p.title, lower, normLower, slug: p.slug };
    })
    // Uzun başlıklı sayfaların ("Kutsal Savaş" gibi) kısa başlıklar ("Savaş") ile karışmaması için terimleri uzundan kısaya sırala
    .sort((a, b) => b.title.length - a.title.length);

  if (!terms.length) return;

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Sadece Saf Metinleri (Text Nodes) Yürüteç İle Tara
  const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT, {
    acceptNode: function(node) {
      let p = node.parentNode;
      while (p && p !== rootElement) {
        const tag = p.tagName.toLowerCase();
        // Asla link eklenmemesi gereken taglar:
        if (['a', 'script', 'style', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'img'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        // Özel modüllere veya 'no-autolink' class'ına sahip elemanlara karışma:
        if (p.id === 'child-section' || p.id === 'page-image' || p.classList.contains('no-autolink')) {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodesToProcess = [];
  let currentNode;
  while ((currentNode = walker.nextNode())) {
    nodesToProcess.push(currentNode);
  }

  // Her metin düğümünü terim-terim (uzundan kısaya) işle.
  // Her eşleşme önce bir sentinel placeholder ile işaretlenir;
  // bu sayede kısa terimler uzun terimlerin içini asla linkleyemez.
  // Sentinel: \x00 (null byte) içerir, hiçbir terim regex'i bununla eşleşemez.
  nodesToProcess.forEach(textNode => {
    const text = textNode.nodeValue;
    if (!text.trim()) return;

    const sentinels = []; // { termObj, matchedText }
    let workingText = text;

    for (const termObj of terms) {
      const pattern = escapeRegExp(termObj.title).replace(/\s+/g, '\\s+');
      let termRegex;
      try {
        termRegex = new RegExp(
          '(?<=^|[^a-zA-Z0-9\u00c7\u00e7\u011e\u011f\u0130\u0131\u0049\u0069\u00d6\u00f6\u015e\u015f\u00dc\u00fc])(' + pattern + ')(?=$|[^a-zA-Z0-9\u00c7\u00e7\u011e\u011f\u0130\u0131\u0049\u0069\u00d6\u00f6\u015e\u015f\u00dc\u00fc])',
          'gi'
        );
      } catch (e) {
        termRegex = new RegExp('\\b(' + pattern + ')\\b', 'gi');
      }

      // \x00 karakterleri hiçbir terim regex'iyle eşleşmez,
      // dolayısıyla daha önce işlenmiş sentinel bölgeleri korunur.
      workingText = workingText.replace(termRegex, (match, p1) => {
        const matchedText = p1 || match;
        sentinels.push({ termObj, matchedText });
        return '\x00' + (sentinels.length - 1) + '\x00';
      });
    }

    if (!sentinels.length) return;

    // Sentinel'leri gerçek anchor tag'lerine dönüştür
    const newHtml = workingText.replace(/\x00(\d+)\x00/g, (_, idx) => {
      const { termObj, matchedText } = sentinels[parseInt(idx, 10)];
      return '<a href="page.html?slug=' + termObj.slug + '" class="text-gold font-medium hover:underline focus:outline-none" title="' + termObj.title + '">' + matchedText + '</a>';
    });

    // Güvence için parçacığı DOM'a ekle
    const span = document.createElement('span');
    span.innerHTML = newHtml;

    const frag = document.createDocumentFragment();
    while (span.firstChild) {
      frag.appendChild(span.firstChild);
    }
    textNode.parentNode.replaceChild(frag, textNode);
  });
}

const params = new URLSearchParams(window.location.search);
const slug = params.get("slug");

if (!slug) {
  document.querySelector("main").innerHTML = "<p>Sayfa bulunamadı (Slug eksik).</p>";
  throw new Error("Slug yok");
}

async function loadPage() {
  let data = pageCache[slug] || null;
  let error = null;
  
  if (!data) {
    // Ana sayfa için yükleniyor bildirimi
    const titleEl = document.getElementById("title");
    const contentEl = document.getElementById("content");
    if (titleEl) titleEl.innerHTML = `<span class="animate-pulse text-gray-400">Yükleniyor...</span>`;
    if (contentEl) contentEl.innerHTML = `<p class="text-gray-400 italic animate-pulse">Sayfa içeriği getiriliyor, lütfen bekleyin...</p>`;

    try {
      const resp = await fetch(`/api/notion?slug=${slug}`);
      if (!resp.ok) throw new Error("Sayfa yüklenemedi veya yayında değil.");
      const json = await resp.json();
      data = json.data;
      if (data) pageCache[slug] = data;
    } catch (err) {
      error = err;
    }
  }

  if (error || !data) {
    document.querySelector("main").innerHTML = "<p>Sayfa bulunamadı veya yayında değil.</p>";
    return;
  }

  // Yükleme animasyonu devam ederken alt sayfaları yerel önbellekten (tek seferde ve 0 milisaniyede) çözelim
  let childPages = [];
  try {
    const allPages = await fetchAllPages();
    childPages = allPages.filter(p => p.parent_id === data.id);
  } catch (_) { /* noop */ }

  // Ana içerik
  document.getElementById("title").textContent = data.title;
  let dateText = data.updated_at ? new Date(data.updated_at).toLocaleString("tr-TR") : "";
  document.getElementById("meta").textContent = `Son güncelleme: ${dateText}`;
  try { document.title = `Velmor Wiki - ${data.title || 'Sayfa'}`; } catch (_) {}
  
  // Sunucuda DM notları temizlendiği için burada ek bir DOM filtresine gerek yok.
  const parser = new DOMParser();
  const doc = parser.parseFromString(data.content, "text/html");

  doc.querySelectorAll('hr').forEach(el => {
    el.classList.add('border-border-dark', 'my-2');
  });


  const contentEl = document.getElementById('content');
  // Sanitization (defense-in-depth): DOMPurify is loaded in page.html
  let safeHtml = doc.body.innerHTML;
  try {
    if (window.DOMPurify && typeof window.DOMPurify.sanitize === "function") {
      safeHtml = window.DOMPurify.sanitize(safeHtml, {
        ADD_ATTR: ["class", "id", "style"],
        ADD_TAGS: ["details", "summary"],
      });
    }
  } catch (_) { /* noop */ }
  contentEl.innerHTML = safeHtml;

  // TABLE ENHANCEMENTS: responsive scroll + themed styling + optional sorting
  try {
    enhanceTables(contentEl);
  } catch (e) {
    console.error("Table enhance error:", e);
  }

  // TABLE OF CONTENTS (TOC) + heading anchors
  try {
    buildTableOfContents(contentEl);
  } catch (e) {
    console.error("TOC error:", e);
  }
  
  // Otomatik Wiki Linkleme (Tüm sayfalara veritabanından bağ kur, sıfır gecikmeli cache desteği ile)
  try {
    const allPages = await fetchAllPages();
    autoLinkWikiTerms(contentEl, allPages, data.title);
  } catch(e) {
    console.error("AutoLink error:", e);
  }

  try {
    await renderBreadcrumbs(data);
  } catch(_) { /* noop */ }

  // Resim lightbox ayarları
  try {
    const imageModal = document.getElementById('imageModal');
    const imageBackdrop = document.getElementById('imageBackdrop');
    const closeImageModal = document.getElementById('closeImageModal');
    const lightboxImage = document.getElementById('lightboxImage');

    function openLightbox(src) {
      if (!imageModal || !imageBackdrop || !lightboxImage) return;
      lightboxImage.src = src;
      imageModal.style.display = 'flex';
      imageBackdrop.style.display = 'block';
    }

    function hideLightbox() {
      if (!imageModal || !imageBackdrop || !lightboxImage) return;
      imageModal.style.display = 'none';
      imageBackdrop.style.display = 'none';
      lightboxImage.src = '';
    }

    contentEl?.addEventListener('click', (e) => {
      const target = e.target;
      if (target && target.tagName === 'IMG') {
        e.preventDefault();
        openLightbox(target.src);
      }
    });

    document.getElementById('page-sidebar')?.addEventListener('click', (e) => {
      const target = e.target;
      if (target && target.tagName === 'IMG') {
        e.preventDefault();
        openLightbox(target.src);
      }
    });

    closeImageModal?.addEventListener('click', hideLightbox);
    imageBackdrop?.addEventListener('click', hideLightbox);
    imageModal?.addEventListener('click', (e) => {
      if (e.target === imageModal) hideLightbox();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideLightbox();
    });
  } catch (e) { }

  // Görsel (Sidebar'da gösterilecekse burada sadece div'i sıfırlıyoruz, yönetimi sidebar kodunda yapacağız)
  let imageUsedInSidebar = false;
  const imgContainer = document.getElementById('page-image');

  // Sidebar info
  const sidebarEl = document.getElementById('page-sidebar');
  if (data.sidebar_info && sidebarEl) {
    try {
      // JSON formatında destekliyoruz. Notion'dan JSON ya da text gelebilir.
      const parsed = typeof data.sidebar_info === 'object' ? data.sidebar_info : JSON.parse(data.sidebar_info);
      const rows = [];
      if (parsed.image) {
        rows.push(`<tr><td colspan="2" class="text-center"><img src="${parsed.image}" alt="" class="mx-auto mb-2"/></td></tr>`);
      }
      if (parsed.title) {
        rows.push(`<tr><td colspan="2" class="text-center font-bold pb-2 no-autolink">${parsed.title}</td></tr>`);
      }
      if (parsed.fields) {
         if (Array.isArray(parsed.fields)) {
            parsed.fields.forEach(({ key, value }) => {
              if (key) rows.push(`<tr><td class="font-semibold pr-2 text-sm text-gray-300 no-autolink">${key}</td><td class="text-sm text-white">${value ?? ''}</td></tr>`);
            });
         } else {
            for (const [k, v] of Object.entries(parsed.fields)) {
              rows.push(`<tr><td class="font-semibold pr-2 text-sm text-gray-300 no-autolink">${k}</td><td class="text-sm text-white">${v}</td></tr>`);
            }
         }
      }
      sidebarEl.style.display = 'block';
      sidebarEl.innerHTML = `<table class="w-full text-sm">${rows.join('')}</table>`;
    } catch (e) {
      // JSON değilse otomatik olarak alt alta yazılan "Anahtar: Değer" yapısını Tablo (Infobox) gibi oluştur:
      const lines = data.sidebar_info.split('\n').filter(l => l.trim().length > 0);
      const rows = [];
      
      // Resim varsa en üste koy (infobox görseli olarak)
      if (data.image_url) {
        rows.push(`<tr><td colspan="2" class="text-center pb-2"><img src="${data.image_url}" alt="${data.title}" class="w-full h-auto object-cover rounded cursor-pointer"/></td></tr>`);
        imageUsedInSidebar = true;
      }
      
      // Sayfa başlığını resmin hemen altına tablo başlığı gibi koy
      rows.push(`<tr><td colspan="2" class="text-center font-bold text-white pb-3 uppercase tracking-wider border-b border-white/40 infobox-title align-middle no-autolink">${data.title}</td></tr>`);

      // İçeriği satır satır tara
      lines.forEach(line => {
        // İlk iki nokta üst üsteye(:) kadar olanı başlık(key), ondan sonrasını değer(val) al
        const colonIndex = line.indexOf(':');
        if (colonIndex > -1) {
          const key = line.substring(0, colonIndex).trim();
          let val = line.substring(colonIndex + 1).trim();
          
          rows.push(`<tr><td class="font-bold pr-2 text-gray-300 py-2 border-b border-border-dark uppercase tracking-wider infobox-key align-middle no-autolink">${key}</td><td class="text-white py-2 border-b border-border-dark infobox-val align-middle">${val}</td></tr>`);
        } else {
          // İki nokta yoksa "GENEL BİLGİLER" tarzında bir alt/ara başlık olarak, ortalı şekilde koy
          rows.push(`<tr><td colspan="2" class="text-white font-bold py-2.5 border-b border-border-dark text-center uppercase tracking-wider infobox-header align-middle no-autolink">${line}</td></tr>`);
        }
      });
      sidebarEl.style.display = 'block';
      sidebarEl.innerHTML = `<table class="w-full text-sm text-left border-collapse">${rows.join('')}</table>`;
    }
  } else if (sidebarEl) {
    sidebarEl.style.display = 'none';
    sidebarEl.innerHTML = '';
  }

  // Sidebar için de otomatik linkleme
  if (sidebarEl && sidebarEl.style.display !== 'none') {
    try {
      const allPages = await fetchAllPages();
      autoLinkWikiTerms(sidebarEl, allPages, data.title);
    } catch(e) {
      console.error("Sidebar AutoLink error:", e);
    }
  }

  // Sidebar'da görsel KULLANILMADIYSA, ana içeriğin yukarısında kocaman göster
  if (data.image_url && !imageUsedInSidebar && imgContainer) {
    imgContainer.innerHTML = `<img src="${data.image_url}" alt="${data.title}" class="w-full max-h-96 object-cover rounded" />`;
  } else if (imgContainer && !imageUsedInSidebar) {
    imgContainer.innerHTML = '';
  }

  // ALT SAYFALAR (Child pages)
  try {
    const childSection = document.getElementById("child-section");
    const childList = document.getElementById("child-pages");
    
    if (childPages.length && childSection && childList) {
      childSection.style.display = "block";
      childPages.sort((a, b) => (a.title || "").localeCompare(b.title || "", 'tr'));
      
      childList.innerHTML = childPages
        .map(p => `<li><a class="block border border-border-dark p-3 hover:bg-white/10 transition text-white" href="page.html?slug=${p.slug}">${p.title}</a></li>`)
        .join("");
        
      const childHeader = document.getElementById("child-header");
      const childContent = document.getElementById("child-content");
      const childIcon = document.getElementById("child-toggle-icon");
      
      if (childHeader && childContent && childIcon) {
        childContent.style.display = "block";
        childHeader.setAttribute('aria-expanded', 'true');
        childIcon.classList.remove('rotate-90');

        const toggleChild = () => {
          const isOpen = childContent.style.display !== "none";
          const willOpen = !isOpen;
          childContent.style.display = willOpen ? "block" : "none";
          childHeader.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
          if (!willOpen) {
            childIcon.classList.add('rotate-90');
          } else {
            childIcon.classList.remove('rotate-90');
          }
        };

        childHeader.onclick = toggleChild;
      }
    } else {
      const section = document.getElementById("child-section");
      if(section) section.style.display = "none";
    }
  } catch (e) {
    document.getElementById("child-section").style.display = "none";
  }

  // ETİKETLER
  if (data.tags?.length) {
    const tagsBar = document.getElementById('tags-bar');
    if (tagsBar) {
      tagsBar.innerHTML = '';
      const tagContainer = document.createElement('p');
      tagContainer.className = 'text-sm text-text-dark';
      const sortedTags = [...data.tags].sort((a, b) => (a || '').localeCompare(b || '', 'tr'));
      tagContainer.innerHTML = 'Etiketler: ' + sortedTags
        .map(t => `<a class="text-text-dark hover:text-gold" href="tag.html?name=${encodeURIComponent(t)}">${t}</a>`)
        .join(', ');
      tagsBar.appendChild(tagContainer);
    }
  }

  // Geçmiş (Recently visited)
  try {
    const rec = { slug: data.slug, title: data.title, visited_at: new Date().toISOString() };
    let arr = JSON.parse(localStorage.getItem('recentVisited') || '[]');
    arr = Array.isArray(arr) ? arr.filter(it => it && it.slug !== rec.slug) : [];
    arr.unshift(rec);
    if (arr.length > 20) arr = arr.slice(0, 20);
    localStorage.setItem('recentVisited', JSON.stringify(arr));
  } catch (_) { }
}

loadPage();

function enhanceTables(root) {
  if (!root) return;
  const tables = Array.from(root.querySelectorAll("table"));
  if (!tables.length) return;

  tables.forEach((table) => {
    // Ignore sidebar/infobox tables (they live outside #content anyway, but be defensive)
    if (table.closest("#page-sidebar")) return;

    table.classList.add("wiki-table");

    // Wrap for horizontal scrolling on narrow screens
    const parent = table.parentElement;
    if (!parent) return;
    if (!parent.classList.contains("table-scroll")) {
      const wrap = document.createElement("div");
      wrap.className = "table-scroll";
      parent.insertBefore(wrap, table);
      wrap.appendChild(table);
    }

    // Enable sorting only for simple header tables
    enableTableSorting(table);
  });
}

function enableTableSorting(table) {
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  if (!thead || !tbody) return;

  const headerRows = Array.from(thead.querySelectorAll("tr"));
  if (headerRows.length !== 1) return;

  const ths = Array.from(headerRows[0].querySelectorAll("th"));
  if (ths.length < 1) return;

  const rows = Array.from(tbody.querySelectorAll("tr"));
  if (rows.length < 2) return;

  ths.forEach((th, index) => {
    th.classList.add("is-sortable");
    th.setAttribute("role", "button");
    th.setAttribute("tabindex", "0");
    if (!th.hasAttribute("aria-sort")) th.setAttribute("aria-sort", "none");

    const onActivate = () => sortByColumn(table, index, th);
    th.addEventListener("click", onActivate);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    });
  });
}

function sortByColumn(table, colIndex, activeTh) {
  const tbody = table.querySelector("tbody");
  if (!tbody) return;

  const ths = Array.from(table.querySelectorAll("thead th"));
  ths.forEach((th) => {
    if (th !== activeTh) th.setAttribute("aria-sort", "none");
  });

  const current = activeTh.getAttribute("aria-sort") || "none";
  const next = current === "ascending" ? "descending" : "ascending";
  activeTh.setAttribute("aria-sort", next);

  const direction = next === "ascending" ? 1 : -1;
  const rows = Array.from(tbody.querySelectorAll("tr"));

  const getCellText = (row) => {
    const cell = row.children[colIndex];
    return cell ? (cell.textContent || "").trim() : "";
  };

  const parseMaybeNumber = (s) => {
    // Accept "1.234", "1,234", "12,5" variants; fall back to string compare
    const normalized = s
      .replace(/\s+/g, "")
      .replace(/\./g, "")
      .replace(/,/g, ".");
    const num = Number(normalized);
    return Number.isFinite(num) ? num : null;
  };

  rows.sort((a, b) => {
    const av = getCellText(a);
    const bv = getCellText(b);

    const an = parseMaybeNumber(av);
    const bn = parseMaybeNumber(bv);
    if (an !== null && bn !== null) return (an - bn) * direction;

    return av.localeCompare(bv, "tr", { numeric: true, sensitivity: "base" }) * direction;
  });

  const frag = document.createDocumentFragment();
  rows.forEach((r) => frag.appendChild(r));
  tbody.appendChild(frag);
}

function buildTableOfContents(contentRoot) {
  if (!contentRoot) return;

  const headings = Array.from(contentRoot.querySelectorAll("h2, h3"))
    .filter((h) => (h.textContent || "").trim().length > 0);

  // Hide TOC for very short pages
  if (headings.length < 2) {
    const existing = document.getElementById("toc");
    if (existing) existing.remove();
    return;
  }

  const slugify = (s) => {
    const raw = String(s || "").trim().toLocaleLowerCase("tr-TR");
    // Keep latin + common TR chars; turn the rest into hyphens
    const cleaned = raw
      .replace(/ı/g, "i")
      .replace(/[^\w\s\-çğıöşü]/g, " ")
      .replace(/\s+/g, "-")
      .replace(/\-+/g, "-")
      .replace(/^\-|\-$/g, "");
    return cleaned || "baslik";
  };

  const usedIds = new Map();
  const ensureId = (h) => {
    let id = (h.getAttribute("id") || "").trim();
    if (!id) id = slugify(h.textContent || "");

    const base = id;
    const count = usedIds.get(base) || 0;
    usedIds.set(base, count + 1);
    if (count > 0) id = `${base}-${count + 1}`;

    h.setAttribute("id", id);
    return id;
  };

  // Add anchor links to headings
  headings.forEach((h) => {
    const id = ensureId(h);
    // Ensure id for TOC navigation, but do not add visible anchors next to headings.
  });

  // Create/replace TOC container
  let toc = document.getElementById("toc");
  if (!toc) {
    toc = document.createElement("details");
    toc.id = "toc";
    toc.open = false;
    toc.setAttribute("aria-label", "İçindekiler");

    // Place TOC after the first paragraph if possible, otherwise before content.
    let insertAfter = null;
    try {
      insertAfter = contentRoot.querySelector(":scope > p") || contentRoot.querySelector("p");
    } catch (_) {
      insertAfter = contentRoot.querySelector("p");
    }

    if (insertAfter && insertAfter.parentElement) {
      insertAfter.insertAdjacentElement("afterend", toc);
    } else {
      contentRoot.parentElement?.insertBefore(toc, contentRoot);
    }
  } else {
    toc.innerHTML = "";
  }

  const summary = document.createElement("summary");
  summary.className = "toc-title";
  summary.innerHTML = `<span>İçindekiler</span><span class="toc-caret" aria-hidden="true">▾</span>`;
  toc.appendChild(summary);

  const ul = document.createElement("ul");
  ul.className = "toc-list";

  headings.forEach((h) => {
    const level = h.tagName === "H3" ? 3 : 2;
    const id = h.getAttribute("id") || ensureId(h);
    // If anchor marker is present, ignore its text. (We used "#" char.)
    const text = (h.cloneNode(true).textContent || "").replace(/\s*#\s*$/, "").trim();

    const li = document.createElement("li");
    li.className = level === 3 ? "toc-item toc-h3" : "toc-item toc-h2";

    const a = document.createElement("a");
    a.href = `#${encodeURIComponent(id)}`;
    a.textContent = text;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.getElementById(id);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      try { history.replaceState(null, "", `#${id}`); } catch (_) {}
    });

    li.appendChild(a);
    ul.appendChild(li);
  });

  toc.appendChild(ul);

  // Fix width so it doesn't change between open/closed states.
  // Measure an "open" clone offscreen and lock to a reasonable max width.
  try {
    const MAX_W = 360;
    const clone = toc.cloneNode(true);
    clone.open = true;
    clone.style.position = "absolute";
    clone.style.left = "-10000px";
    clone.style.top = "0";
    clone.style.visibility = "hidden";
    clone.style.pointerEvents = "none";
    document.body.appendChild(clone);

    const w = Math.ceil(clone.getBoundingClientRect().width || 0);
    clone.remove();

    const locked = Math.max(220, Math.min(MAX_W, w || MAX_W));
    toc.style.setProperty("--toc-width", `${locked}px`);
    toc.dataset.fixedWidth = "1";
  } catch (_) { /* noop */ }
}
