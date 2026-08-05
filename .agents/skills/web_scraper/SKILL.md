---
name: web_scraper
description: Stealth web scraping and Cloudflare bypass capability powered by Scrapling engine.
agent: WebScraperAgent
---

# Web Scraper Skill

This skill provides advanced web scraping capabilities for extracting data from websites, including JavaScript-heavy dynamic pages and Cloudflare-protected sites.

## Capabilities
- Stealth browsing and bypass of anti-bot solutions (Cloudflare, Akamai).
- Dynamic page content extraction via Scrapling Adaptor/Fetcher.
- Structured Markdown/Text content conversion for LLM consumption.
- Fallback to standard Python HTTP/urllib request engines.

## Usage
The `WebScraperAgent` executes tasks with type `web_scrape` or `live_search`.
