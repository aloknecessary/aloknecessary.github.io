[![pages-build-deployment](https://github.com/aloknecessary/aloknecessary.github.io/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/aloknecessary/aloknecessary.github.io/actions/workflows/pages/pages-build-deployment)

# Personal Website & Technical Blog

This repository contains the source code and content for my personal website and technical blog, built using **Jekyll** and hosted on **GitHub Pages**.

The site serves as a central place for:

- Professional background and architectural experience
- In-depth technical writing and engineering insights
- Reference implementations and supporting code for blog posts

The repository follows a content-first structure with a strong focus on clarity, maintainability, and long-term evolution.

# [About Me](https://aloknecessary.in/)

# [My Blog](https://aloknecessary.in/blogs)

## Development

**Install dependencies**
```bash
bundle install
```

**Local dev server** (live reload at `http://localhost:4000`)
```bash
bundle exec jekyll serve
```

**With custom local domain** (add `127.0.0.1 dev.aloknecessary.in` to hosts file first)
```bash
bundle exec jekyll serve --host 0.0.0.0 --port 4000
```

**Include future-dated posts**
```bash
bundle exec jekyll serve --future
```

**Include drafts**
```bash
bundle exec jekyll serve --drafts
```

**Incremental build** (faster rebuilds — only regenerates changed files)
```bash
bundle exec jekyll serve --incremental
```

**Watch for changes without serving** (build only)
```bash
bundle exec jekyll build --watch
```

**Clean build cache**
```bash
bundle exec jekyll clean
```

**Production build**
```bash
JEKYLL_ENV=production bundle exec jekyll build
```

**Override config for local dev** (e.g. to test with local URL)
```bash
bundle exec jekyll serve --config _config.yml,_config.dev.yml
```

**Check for BOM in a blog post**
```powershell
$bytes = [System.IO.File]::ReadAllBytes('_blogs\your-post.md')
$bytes[0..2] | ForEach-Object { $_.ToString('X2') }
# Must be: 2D 2D 2D  (i.e. ---)
```

**Run markdownlint on a post**
```bash
npx markdownlint-cli _blogs/your-post.md
```
