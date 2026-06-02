// Glimmer site — small progressive enhancements (no framework).
(function () {
  // Mobile nav toggle
  const toggle = document.querySelector(".nav-toggle");
  const links = document.querySelector(".nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", () => links.classList.toggle("open"));
    links.addEventListener("click", (e) => {
      if (e.target.tagName === "A") links.classList.remove("open");
    });
  }

  // Docs sidebar scroll-spy
  const sideLinks = Array.from(document.querySelectorAll(".docs-side a[href^='#']"));
  const sections = sideLinks
    .map((a) => document.getElementById(a.getAttribute("href").slice(1)))
    .filter(Boolean);
  if (sections.length) {
    const byId = new Map(sideLinks.map((a) => [a.getAttribute("href").slice(1), a]));
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            sideLinks.forEach((a) => a.classList.remove("active"));
            const link = byId.get(en.target.id);
            if (link) link.classList.add("active");
          }
        });
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 },
    );
    sections.forEach((s) => obs.observe(s));
  }

  // Footer year
  const y = document.getElementById("year");
  if (y) y.textContent = new Date().getFullYear();
})();
