function highlightActiveTag() {
  document.querySelectorAll('.tag-block').forEach(el => {
    el.classList.remove('active');
  });

  const hash = window.location.hash.substring(1);
  if (!hash) return;

  const active = document.getElementById(hash);
  if (active) {
    active.classList.add('active');
  }
}

function scrollToHash() {
  if (window.location.hash) {
    const target = document.querySelector(window.location.hash);
    if (target) {
      target.scrollIntoView({ behavior: "smooth" });
    }
  }
}

highlightActiveTag();
window.addEventListener('hashchange', highlightActiveTag);

// Scroll after content is visible
window.addEventListener('load', function() {
  setTimeout(() => {
    scrollToHash();
  }, 400); // Wait for skeleton to hide (350ms) + small buffer
});
