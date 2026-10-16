(function () {
  const PREF_POSTS_KEY    = 'prefPostsPerPage';
  const PREF_BANNER_KEY   = 'prefBannerWindowHours';
  const PREF_SUPPRESS_KEY = 'prefBannerSuppressOnVisit';
  const DEFAULT_POSTS     = 10;
  const DEFAULT_BANNER    = 24;
  const DEFAULT_SUPPRESS  = 'yes';

  // Expose getters once
  if (!window.getPostsPerPage) {
    window.getPostsPerPage = function () {
      return parseInt(localStorage.getItem(PREF_POSTS_KEY)) || DEFAULT_POSTS;
    };
    window.getBannerWindowHours = function () {
      var v = localStorage.getItem(PREF_BANNER_KEY);
      return v === null ? DEFAULT_BANNER : parseInt(v);
    };
    window.getBannerSuppressOnVisit = function () {
      return (localStorage.getItem(PREF_SUPPRESS_KEY) || DEFAULT_SUPPRESS) === 'yes';
    };
  }

  window.initPrefPanel = function (wrap) {
    if (!wrap) return;
    var trigger  = wrap.querySelector('.pref-trigger');
    var panel    = wrap.querySelector('.pref-panel');
    var closeBtn = wrap.querySelector('.pref-panel-close');
    if (!trigger || !panel) return;

    var backdrop = document.createElement('div');
    backdrop.className = 'pref-backdrop';
    backdrop.addEventListener('click', closePanel);
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);

    function positionPanel() {
      var rect = trigger.getBoundingClientRect();
      panel.style.top  = (rect.bottom + 10) + 'px';
      panel.style.right = (document.documentElement.clientWidth - rect.right) + 'px';
    }

    function openPanel() {
      positionPanel();
      panel.classList.add('open');
      backdrop.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      panel.setAttribute('aria-hidden', 'false');
      syncPrefButtons(panel);
      window.addEventListener('scroll', closePanel, { passive: true, once: true });
    }

    function closePanel() {
      panel.classList.remove('open');
      backdrop.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      panel.setAttribute('aria-hidden', 'true');
    }

    var mobileTrigger = wrap.querySelector('.pref-mobile-trigger');
    if (mobileTrigger) {
      mobileTrigger.addEventListener('click', function () {
        var overlay = document.getElementById('navDrawerOverlay') || document.getElementById('anMobileOverlay');
        if (overlay) {
          overlay.classList.add('open');
          overlay.setAttribute('aria-hidden', 'false');
          document.body.style.overflow = 'hidden';
          document.dispatchEvent(new Event('draweropen'));
        }
      });
    }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.classList.contains('open') ? closePanel() : openPanel();
    });

    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) closePanel();
    });

    bindPrefButtons(panel);
    window.addEventListener('themechange', function () { syncPrefButtons(panel); });
  };

  // Shared: wire up click handlers on any container using data-pref-* buttons
  function bindPrefButtons(container) {
    container.querySelectorAll('[data-pref-theme]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (typeof window.setTheme === 'function') window.setTheme(btn.dataset.prefTheme);
        syncPrefButtons(container);
      });
    });
    container.querySelectorAll('[data-pref-posts]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        localStorage.setItem(PREF_POSTS_KEY, btn.dataset.prefPosts);
        sessionStorage.removeItem('blogsVisibleLimit');
        sessionStorage.removeItem('blogsScrollY');
        syncPrefButtons(container);
      });
    });
    container.querySelectorAll('[data-pref-banner]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        localStorage.setItem(PREF_BANNER_KEY, btn.dataset.prefBanner);
        syncPrefButtons(container);
      });
    });
    container.querySelectorAll('[data-pref-suppress]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        localStorage.setItem(PREF_SUPPRESS_KEY, btn.dataset.prefSuppress);
        syncPrefButtons(container);
      });
    });
  }

  // Shared: sync active state on any container using data-pref-* buttons
  window.syncPrefButtons = function (container) {
    var theme    = localStorage.getItem('theme') || 'system';
    var posts    = String(window.getPostsPerPage());
    var banner   = String(window.getBannerWindowHours());
    var suppress = localStorage.getItem(PREF_SUPPRESS_KEY) || DEFAULT_SUPPRESS;
    container.querySelectorAll('[data-pref-theme]').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.prefTheme === theme);
    });
    container.querySelectorAll('[data-pref-posts]').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.prefPosts === posts);
    });
    container.querySelectorAll('[data-pref-banner]').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.prefBanner === banner);
    });
    container.querySelectorAll('[data-pref-suppress]').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.prefSuppress === suppress);
    });
  };

  // Drawer init — called from drawer-theme.html
  window.initPrefDrawer = function (container) {
    if (!container) return;
    bindPrefButtons(container);
    // Theme closes the drawer; others just sync
    container.querySelectorAll('[data-pref-theme]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var closeBtn = document.getElementById('navDrawerClose') || document.getElementById('anDrawerClose');
        if (closeBtn) closeBtn.click();
      });
    });
    document.addEventListener('draweropen', function () { syncPrefButtons(container); });
    window.addEventListener('themechange', function () { syncPrefButtons(container); });
  };
})();
