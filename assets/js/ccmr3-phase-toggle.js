(function () {
  const buttons = document.querySelectorAll('.phase-order-btn');
  if (!buttons.length) return;

  const phases = Array.from(document.querySelectorAll('.ccmr3-phase'));
  if (!phases.length) return;

  const parent = phases[0].parentNode;
  const anchor = phases[phases.length - 1].nextSibling;

  function applyOrder(order) {
    const ordered = order === 'chrono' ? [...phases].reverse() : [...phases];
    ordered.forEach(el => parent.insertBefore(el, anchor));
    buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.order === order));
    sessionStorage.setItem('ccmr3-phase-order', order);
  }

  buttons.forEach(btn => btn.addEventListener('click', () => applyOrder(btn.dataset.order)));

  const saved = sessionStorage.getItem('ccmr3-phase-order') || 'latest';
  applyOrder(saved);
})();
