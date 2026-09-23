import ipaddress
import logging
import socket
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional, Tuple

from bs4 import BeautifulSoup

logger = logging.getLogger("web_scraper")


class WebScraperEngine:
    """Bounded public-web research engine with SSRF-resistant HTTP retrieval."""

    MAX_PAGE_CHARS = 5_000
    MAX_SEARCH_RESULTS = 3
    MAX_RESPONSE_BYTES = 2 * 1024 * 1024

    @staticmethod
    def _clean_html(html: str, max_chars: int) -> str:
        soup = BeautifulSoup(html, "html.parser")
        for element in soup(["script", "style", "nav", "footer", "header", "noscript"]):
            element.extract()
        lines = (line.strip() for line in soup.get_text("\n").splitlines())
        return "\n".join(line for line in lines if line)[:max_chars]

    @staticmethod
    def _validate_public_url(url: str) -> Optional[str]:
        """Reject non-web and local/private targets to avoid SSRF from agent prompts."""
        normalized = url if url.startswith(("http://", "https://")) else f"https://{url}"
        parsed = urllib.parse.urlparse(normalized)
        host = parsed.hostname
        if parsed.scheme not in {"http", "https"} or not host:
            return None
        try:
            port = parsed.port
        except ValueError:
            return None
        if parsed.username or parsed.password or (port and port not in {80, 443}):
            return None
        if host.lower() in {"localhost", "localhost.localdomain"} or host.lower().endswith((".local", ".internal")):
            return None
        try:
            addresses = {item[4][0] for item in socket.getaddrinfo(host, None)}
            for address in addresses:
                ip = ipaddress.ip_address(address)
                if not ip.is_global:
                    return None
        except (OSError, ValueError):
            return None
        return normalized

    def fetch_url_content(self, url: str, max_chars: int = MAX_PAGE_CHARS) -> str:
        """Retrieve a bounded public page while revalidating every redirect."""
        normalized_url = self._validate_public_url(url)
        if not normalized_url:
            return "Blocked unsafe or invalid URL. Only public HTTP(S) pages may be researched."

        engine = self

        class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
                validated = engine._validate_public_url(newurl)
                if not validated:
                    raise urllib.error.HTTPError(newurl, 403, "Blocked unsafe redirect", headers, fp)
                return super().redirect_request(req, fp, code, msg, headers, validated)

        headers = {"User-Agent": "Mozilla/5.0 (compatible; AI-OS-Research/1.0)"}
        try:
            request = urllib.request.Request(normalized_url, headers=headers)
            opener = urllib.request.build_opener(SafeRedirectHandler())
            with opener.open(request, timeout=12) as response:
                final_url = response.geturl()
                if not self._validate_public_url(final_url):
                    return "Blocked unsafe redirect target."
                payload = response.read(self.MAX_RESPONSE_BYTES + 1)
                if len(payload) > self.MAX_RESPONSE_BYTES:
                    return "Web page exceeded the safe response-size limit."
                return self._clean_html(payload.decode("utf-8", errors="ignore"), max_chars)
        except Exception as exc:
            logger.error("Could not retrieve %s: %s", normalized_url, exc)
            return f"Failed to retrieve web page: {exc}"

    @staticmethod
    def _unwrap_search_link(link: str) -> str:
        parsed = urllib.parse.urlparse(link)
        query = urllib.parse.parse_qs(parsed.query)
        return query.get("uddg", [link])[0]

    def _search_duckduckgo(self, query: str, max_results: Optional[int] = None) -> List[Tuple[str, str, str]]:
        """Returns public result titles, URLs, and snippets without trusting page content as instructions."""
        request = urllib.request.Request(
            "https://lite.duckduckgo.com/lite/",
            data=urllib.parse.urlencode({"q": query}).encode("utf-8"),
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; AI-OS-Research/1.0)",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        with urllib.request.urlopen(request, timeout=12) as response:
            payload = response.read(self.MAX_RESPONSE_BYTES + 1)
            if len(payload) > self.MAX_RESPONSE_BYTES:
                return []
            soup = BeautifulSoup(payload.decode("utf-8", errors="ignore"), "html.parser")

        result_limit = max(1, min(max_results or self.MAX_SEARCH_RESULTS, self.MAX_SEARCH_RESULTS))
        results: List[Tuple[str, str, str]] = []
        seen_urls = set()
        for link in soup.select("a.result__a, a.result-link"):
            title = link.get_text(" ", strip=True)
            url = self._unwrap_search_link(link.get("href", ""))
            if not title or not url or url in seen_urls or not self._validate_public_url(url):
                continue
            container = link.find_parent(class_="result") or link.parent
            snippet_element = container.select_one(".result__snippet, .result-snippet") if container else None
            snippet = snippet_element.get_text(" ", strip=True) if snippet_element else ""
            results.append((title, url, snippet))
            seen_urls.add(url)
            if len(results) >= result_limit:
                break
        return results

    def live_search_web(self, query: str, max_results: Optional[int] = None) -> str:
        """Searches the web and extracts cited content from the strongest public results."""
        try:
            results = self._search_duckduckgo(query, max_results=max_results)
            if not results:
                return f"No live web search results found for query: '{query}'."

            # Fetch independent sources concurrently so one slow page does not
            # multiply the research latency by the result count.
            with ThreadPoolExecutor(max_workers=len(results)) as executor:
                page_texts = list(executor.map(
                    lambda item: self.fetch_url_content(item[1], max_chars=2_000),
                    results,
                ))
            source_blocks = []
            for (title, url, snippet), page_text in zip(results, page_texts):
                source_blocks.append(
                    f"[Web Source: {title}]\nURL: {url}\n"
                    f"Search snippet: {snippet}\nExtracted content:\n{page_text}"
                )
            return "\n\n---\n\n".join(source_blocks)
        except Exception as exc:
            logger.error("Live web search error for '%s': %s", query, exc)
            return f"Web search service unavailable: {exc}"


web_scraper = WebScraperEngine()
