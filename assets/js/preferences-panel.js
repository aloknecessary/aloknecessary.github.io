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

    function openPanel() {
      panel.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      panel.setAttribute('aria-hidden', 'false');
      syncAll();
      window.addEventListener('scroll', closePanel, { passive: true, once: true });
    }

    function closePanel() {
      panel.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      panel.setAttribute('aria-hidden', 'true');
    }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.classList.contains('open') ? closePanel() : openPanel();
    });

    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) closePanel();
    });

    panel.querySelectorAll('[data-pref-theme]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (typeof window.setTheme === 'function') window.setTheme(btn.dataset.prefTheme);
        syncTheme();
      });
    });

    panel.querySelectorAll('[data-pref-posts]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        localStorage.setItem(PREF_POSTS_KEY, btn.dataset.prefPosts);
        sessionStorage.removeItem('blogsVisibleLimit');
        sessionStorage.removeItem('blogsScrollY');
        syncPosts();
      });
    });

    panel.querySelectorAll('[data-pref-banner]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        localStorage.setItem(PREF_BANNER_KEY, btn.dataset.prefBanner);
        syncBanner();
      });
    });

    panel.querySelectorAll('[data-pref-suppress]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        localStorage.setItem(PREF_SUPPRESS_KEY, btn.dataset.prefSuppress);
        syncSuppress();
      });
    });

    function syncTheme() {
      var current = localStorage.getItem('theme') || 'system';
      panel.querySelectorAll('[data-pref-theme]').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.prefTheme === current);
      });
    }

    function syncPosts() {
      var current = String(window.getPostsPerPage());
      panel.querySelectorAll('[data-pref-posts]').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.prefPosts === current);
      });
    }

    function syncBanner() {
      var current = String(window.getBannerWindowHours());
      panel.querySelectorAll('[data-pref-banner]').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.prefBanner === current);
      });
    }

    function syncSuppress() {
      var current = localStorage.getItem(PREF_SUPPRESS_KEY) || DEFAULT_SUPPRESS;
      panel.querySelectorAll('[data-pref-suppress]').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.prefSuppress === current);
      });
    }

    function syncAll() {
      syncTheme();
      syncPosts();
      syncBanner();
      syncSuppress();
    }

    window.addEventListener('themechange', syncTheme);
  };
})();
