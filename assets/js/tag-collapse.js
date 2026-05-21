(function() {
  const LIMIT = 5;
  const ARROW_DOWN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  const ARROW_UP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>';

  document.querySelectorAll('.tag-posts').forEach(ul => {
    if (ul.querySelectorAll('li').length <= LIMIT) return;

    ul.classList.add('collapsed');

    const bar = document.createElement('div');
    bar.className = 'show-more-bar';

    const btn = document.createElement('button');
    btn.className = 'show-more-btn';
    btn.innerHTML = 'Show more ' + ARROW_DOWN;

    btn.addEventListener('click', function() {
      const isCollapsed = ul.classList.toggle('collapsed');
      btn.innerHTML = isCollapsed ? 'Show more ' + ARROW_DOWN : 'Show less ' + ARROW_UP;
    });

    bar.appendChild(btn);
    ul.parentNode.insertBefore(bar, ul.nextSibling);
  });
})();
