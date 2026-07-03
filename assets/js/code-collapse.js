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
        btn.innerHTML = "<span></span>";
        wrapper.appendChild(btn);

        btn.addEventListener("click", () => {
          wrapper.classList.toggle("expanded");
          btn.setAttribute("aria-label",
            wrapper.classList.contains("expanded") ? "Collapse code block" : "Expand code block"
          );
        });
      });
    }, 50);
  });
})();
