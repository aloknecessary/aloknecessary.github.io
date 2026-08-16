(function () {

  // --- Skeleton reveal ---
  window.addEventListener('load', function () {
    setTimeout(() => {
      document.getElementById('series-loader').style.display = 'none';
      document.getElementById('series-content').classList.remove('hidden');
    }, 350);
  });

  // --- Legend smooth scroll ---
  document.querySelectorAll('.legend-item--link').forEach(function (link) {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      const slug = this.getAttribute('href').substring(1);
      const target = document.getElementById(slug);
      if (!target) return;
      const nav = document.querySelector('.nav-bar');
      const offset = nav ? nav.offsetHeight : 60;
      const top = target.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top, behavior: 'smooth' });
      history.pushState(null, '', '#' + slug);
    });
  });

  // --- Per-series article sort handled by tag-sort.js ---

  // --- Split-button dropdown ---
  document.addEventListener('click', function (e) {
    const chevron = e.target.closest('.series-start-chevron');
    if (chevron) {
      e.stopPropagation();
      const dropdown = chevron.nextElementSibling;
      const isOpen = dropdown.classList.contains('open');
      document.querySelectorAll('.series-start-dropdown.open').forEach(d => d.classList.remove('open'));
      if (!isOpen) dropdown.classList.add('open');
      chevron.setAttribute('aria-expanded', !isOpen);
      return;
    }

    if (!e.target.closest('.series-start-split') || e.target.closest('.series-start-dropdown a')) {
      document.querySelectorAll('.series-start-dropdown.open').forEach(d => d.classList.remove('open'));
    }

    // Collapsible — bail if click is on any interactive child
    const header = e.target.closest('[data-collapsible]');
    if (!header) return;
    if (e.target.closest('.series-start-split')) return;
    if (e.target.closest('[data-no-collapse]')) return;
    header.closest('.series-block').classList.toggle('collapsed');
  });

  // --- New badge ---
  (function () {
    const banner = document.getElementById('recent-post-banner');
    const latestUrl = banner ? banner.dataset.url : null;
    const modified = banner ? new Date(banner.dataset.modified).getTime() : NaN;
    const isRecent = !isNaN(modified) && (Date.now() - modified) < 24 * 60 * 60 * 1000;
    document.querySelectorAll('.post-new-badge[data-url]').forEach(function (badge) {
      if (!isRecent || badge.dataset.url !== latestUrl) badge.style.display = 'none';
    });
  })();

})();
