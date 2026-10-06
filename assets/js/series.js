(function () {

  // --- Skeleton reveal ---
  window.addEventListener('load', function () {
    setTimeout(() => {
      document.getElementById('series-loader').style.display = 'none';
      document.getElementById('series-content').classList.remove('hidden');
    }, 350);
  });

  // --- Legend domain filter ---
  function applyDomainFilter(domain) {
    const blocks = document.querySelectorAll('.series-block');
    const pills = document.querySelectorAll('.legend-item--link');
    if (!domain) {
      blocks.forEach(b => b.classList.remove('filtered-out'));
      pills.forEach(p => p.classList.remove('active'));
      return;
    }
    blocks.forEach(b => b.classList.toggle('filtered-out', b.dataset.domain !== domain));
    pills.forEach(p => p.classList.toggle('active', p.dataset.domain === domain));
  }

  document.querySelectorAll('.legend-item--link').forEach(function (pill) {
    pill.addEventListener('click', function () {
      const domain = this.dataset.domain;
      const isActive = this.classList.contains('active');
      const next = isActive ? '' : domain;
      history.replaceState(null, '', next ? '#domain-' + next.replace(/\s+/g, '-') : window.location.pathname);
      applyDomainFilter(next);
    });
  });

  // Restore filter from URL hash on load
  (function () {
    const hash = window.location.hash;
    if (!hash.startsWith('#domain-')) return;
    const domain = hash.slice('#domain-'.length).replace(/-/g, ' ');
    applyDomainFilter(domain);
  })();

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
