(function () {
  const banner = document.getElementById('recent-post-banner');
  if (!banner) return;

  const slug = banner.dataset.slug;
  const modified = banner.dataset.modified;

 const DISMISS_KEY = 'rpb_dismissed_slug';
  const VISITED_KEY = 'rpb_visited_slug';
  if (localStorage.getItem(DISMISS_KEY) === slug) return;
  if (localStorage.getItem(VISITED_KEY) === slug) return;

  const postUrl = banner.dataset.url;
  if (window.location.pathname === postUrl || window.location.pathname.replace(/\/$/, '') === postUrl.replace(/\/$/, '')) {
    localStorage.setItem(VISITED_KEY, slug);
    return;
  }

  const publishedAt = new Date(modified).getTime();
  if (isNaN(publishedAt) || (Date.now() - publishedAt) >= 24 * 60 * 60 * 1000) return;

  const timeEl = banner.querySelector('.rpb-time');
  if (timeEl) {
    try {
      timeEl.textContent = new Intl.DateTimeFormat('en', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZoneName: 'short'
      }).format(new Date(modified));
    } catch (_) {
      try {
        timeEl.textContent = new Intl.DateTimeFormat('en', {
          month: 'short', day: 'numeric', year: 'numeric',
          hour: 'numeric', minute: '2-digit', hour12: true
        }).format(new Date(modified));
      } catch (_) {
        timeEl.textContent = modified;
      }
    }
  }

  banner.classList.remove('hidden');

  banner.querySelector('.rpb-close').addEventListener('click', function () {
    localStorage.setItem(DISMISS_KEY, slug);
    banner.classList.add('hidden');
  });
})();
