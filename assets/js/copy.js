document.addEventListener("DOMContentLoaded", () => {
  const blocks = document.querySelectorAll("pre > code");

  blocks.forEach((codeBlock) => {
    const pre = codeBlock.parentElement;

    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    const button = document.createElement("button");
    button.className = "copy-btn";
    button.type = "button";
    button.setAttribute("aria-label", "Copy code");

    button.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
    `;

    wrapper.appendChild(button);

    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(codeBlock.innerText);
      button.classList.add("copied");

      setTimeout(() => {
        button.classList.remove("copied");
      }, 1500);
    });
  });
});
