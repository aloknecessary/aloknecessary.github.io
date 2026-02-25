# External Content

This folder contains versions of blog posts prepared for external publishing platforms (Dev.to, Medium, Hashnode, etc.).

## Purpose

- **Syndication** - Summary versions with canonical links back to main blog
- **SEO-safe** - Excluded from Jekyll build to avoid duplicate content
- **Organization** - Keep external versions separate from main blog content

## Files

- `devto-ai-force-multiplier-summary.md` - Dev.to version of AI Force Multiplier post

## Publishing Workflow

1. Write full article in `_blogs/`
2. Create summary version in `external/`
3. Include canonical URL pointing to main blog
4. Publish on external platform
5. Drive traffic back to main blog

## Note

This folder is excluded from Jekyll build via `_config.yml`:

```yaml
exclude:
  - external/
```

Content here will NOT be published to GitHub Pages.
