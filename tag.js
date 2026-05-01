// URL'den etiket ismini al
const tagName = new URLSearchParams(window.location.search).get("name");

if (!tagName) {
  document.querySelector("main").innerHTML = "<p>Etiket belirtilmemiş.</p>";
  throw new Error("Etiket yok");
}

document.getElementById("tag-title").textContent = `Etiket: ${tagName}`;
document.title = `Velmor Wiki - Etiket: ${tagName}`;

const tagDescEl = document.getElementById("tag-desc");
if (tagDescEl) {
  tagDescEl.textContent = "Seçtiğiniz etikete sahip bütün sayfalar listeleniyor.";
}

async function loadTaggedPages() {
  const list = document.getElementById("tag-pages");
  list.innerHTML = `<p class="text-gray-400">Yükleniyor...</p>`;
  
  try {
    let data = [];
    const cached = sessionStorage.getItem('notion_pages_cache');
    if (cached) {
      data = JSON.parse(cached);
    } else {
      const res = await fetch('/api/notion?list=true');
      if (!res.ok) throw new Error('Sunucu hatası');
      const json = await res.json();
      data = json.data || [];
      sessionStorage.setItem('notion_pages_cache', JSON.stringify(data));
    }
    
    // Etikete göre filtrele (büyük küçük harf duyarsız)
    const lowerTag = tagName.toLowerCase();
    const filtered = data.filter(p => p.tags && p.tags.some(t => t.toLowerCase() === lowerTag));
    
    if (!filtered.length) {
      list.innerHTML = "<li>Bu etikete sahip sayfa bulunamadı.</li>";
      return;
    }

    list.innerHTML = "";
    filtered.forEach((p) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `page.html?slug=${encodeURIComponent(p.slug || "")}`;
      a.className = "block border border-border-dark p-3 hover:bg-white/10 transition text-white";

      const h3 = document.createElement("h3");
      h3.className = "text-lg font-semibold";
      h3.textContent = p.title || "";

      a.appendChild(h3);
      li.appendChild(a);
      list.appendChild(li);
    });
  } catch (error) {
    console.error("Etiketli sayfalar alınamadı:", error);
    document.querySelector("main").innerHTML = "<p>Etiketli sayfalar yüklenemedi.</p>";
  }
}

loadTaggedPages();
