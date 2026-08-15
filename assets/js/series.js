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

  // --- Global block sort (Latest / A-Z) handled by tag-sort.js via shared partial ---

  // --- Per-series article sort ---
  function getSeriesOrder(li) {
    const indicator = li.querySelector('.step-indicator');
    return parseInt(indicator ? indicator.textContent.trim() : '0', 10) || 0;
  }

  function sortSeriesPosts(ol, mode) {
    const items = Array.from(ol.querySelectorAll('li'));
    items.sort((a, b) =>
      mode === 'asc'
        ? getSeriesOrder(a) - getSeriesOrder(b)
        : getSeriesOrder(b) - getSeriesOrder(a)
    );
    items.forEach(item => ol.appendChild(item));
  }

  document.querySelectorAll('.series-post-sort-btn').forEach(btn => {
    btn.setAttribute('title', 'Newest first — click to sort oldest first');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const block = this.closest('.series-block');
      const ol = block.querySelector('.series-posts');
      const isAsc = this.classList.toggle('asc');
      this.setAttribute('aria-label', isAsc ? 'Oldest first' : 'Newest first');
      this.setAttribute('title', isAsc ? 'Oldest first — click to sort newest first' : 'Newest first — click to sort oldest first');
      sortSeriesPosts(ol, isAsc ? 'asc' : 'desc');
    });
  });

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
