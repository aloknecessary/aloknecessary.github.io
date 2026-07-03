(function() {
  const COLLAPSE_THRESHOLD = 260;

  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => {
      const wrappers = document.querySelectorAll(".code-block-wrapper");
      if (!wrappers.length) return;

      wrappers.forEach((wrapper) => {
        const pre = wrapper.querySelector("pre");
        if (!pre || pre.scrollHeight <= COLLAPSE_THRESHOLD) return;

        wrapper.classList.add("collapsible");

        const btn = document.createElement("button");
        btn.className = "code-expand-btn";
        btn.type = "button";
        btn.setAttribute("aria-label", "Expand code block");
        const downArrow = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><path d="M6 9l6 6 6-6"></path></svg>`;
        const upArrow = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><path d="M18 15l-6-6-6 6"></path></svg>`;
        btn.innerHTML = `<span>Expand</span>${downArrow}`;
        wrapper.appendChild(btn);

        btn.addEventListener("click", () => {
          wrapper.classList.toggle("expanded");
          const expanded = wrapper.classList.contains("expanded");
          btn.innerHTML = expanded ? `<span>Collapse</span>${upArrow}` : `<span>Expand</span>${downArrow}`;
          btn.setAttribute("aria-label", expanded ? "Collapse code block" : "Expand code block");
        });
      });
    }, 50);
  });
})();
