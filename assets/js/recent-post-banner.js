(function () {
  const banner = document.getElementById('recent-post-banner');
  if (!banner) return;

  const slug = banner.dataset.slug;
  const modified = banner.dataset.modified;

  const STORAGE_KEY = 'rpb_dismissed_slug';
  if (localStorage.getItem(STORAGE_KEY) === slug) return;

  const postUrl = banner.dataset.url;
  if (window.location.pathname === postUrl || window.location.pathname.replace(/\/$/, '') === postUrl.replace(/\/$/, '')) return;

  const publishedAt = new Date(modified).getTime();
  if (isNaN(publishedAt) || (Date.now() - publishedAt) >= 24 * 60 * 60 * 1000) return;

  const timeEl = banner.querySelector('.rpb-time');
  if (timeEl) {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
      timeEl.textContent = new Intl.DateTimeFormat('en', {
        timeZone: tz,
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true
      }).format(new Date(modified));
    } catch (_) {
      timeEl.textContent = new Intl.DateTimeFormat('en', {
        timeZone: 'Asia/Kolkata',
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true
      }).format(new Date(modified));
    }
  }

  banner.classList.remove('hidden');

  banner.querySelector('.rpb-close').addEventListener('click', function () {
    localStorage.setItem(STORAGE_KEY, slug);
    banner.classList.add('hidden');
  });
})();
