"""Secure, dependency-free RSS and Atom retrieval and normalisation."""

from __future__ import annotations

import datetime
import email.utils
import ipaddress
import socket
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from typing import Any, Dict, List


MAX_FEED_BYTES = 2 * 1024 * 1024


class FeedValidationError(ValueError):
    pass


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: List[str] = []

    def handle_data(self, data: str) -> None:
        value = " ".join(data.split())
        if value:
            self.parts.append(value)


def strip_html(value: str) -> str:
    parser = _TextExtractor()
    try:
        parser.feed(value or "")
        parser.close()
    except Exception:
        return " ".join((value or "").split())
    return " ".join(parser.parts)


def validate_public_feed_url(url: str, *, resolve: bool = True) -> str:
    candidate = (url or "").strip()
    parsed = urllib.parse.urlparse(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise FeedValidationError("Feed URL must use http or https and include a host")
    if parsed.username or parsed.password:
        raise FeedValidationError("Credentials are not allowed in feed URLs")
    try:
        port = parsed.port
    except ValueError as exc:
        raise FeedValidationError("Feed URL contains an invalid port") from exc
    if port and port not in {80, 443}:
        raise FeedValidationError("Feed URLs may only use ports 80 or 443")
    try:
        literal_ip = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        literal_ip = None
    if literal_ip is not None and not literal_ip.is_global:
        raise FeedValidationError("Feed host is a private or non-public network address")
    if not resolve:
        return candidate
    try:
        addresses = socket.getaddrinfo(parsed.hostname, port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise FeedValidationError("Feed host could not be resolved") from exc
    for address in {entry[4][0] for entry in addresses}:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise FeedValidationError("Feed host resolves to a private or non-public network address")
    return candidate


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        validate_public_feed_url(newurl, resolve=True)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _child_text(element: ET.Element, names: set[str]) -> str:
    for child in list(element):
        if _local_name(child.tag) in names:
            return "".join(child.itertext()).strip()
    return ""


def _entry_link(element: ET.Element) -> str:
    for child in list(element):
        if _local_name(child.tag) != "link":
            continue
        href = (child.attrib.get("href") or "").strip()
        rel = (child.attrib.get("rel") or "alternate").lower()
        if href and rel in {"alternate", ""}:
            return href
        text = (child.text or "").strip()
        if text:
            return text
    return ""


def _normalise_date(value: str) -> str | None:
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        parsed = email.utils.parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        try:
            parsed = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def parse_feed(payload: bytes, feed_url: str) -> Dict[str, Any]:
    upper = payload[:4096].upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        raise FeedValidationError("Feed XML declarations with entities are not supported")
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as exc:
        raise FeedValidationError("The response is not valid RSS or Atom XML") from exc

    root_name = _local_name(root.tag)
    if root_name == "rss" or root_name == "rdf":
        channel = next((node for node in root.iter() if _local_name(node.tag) == "channel"), root)
        feed_title = strip_html(_child_text(channel, {"title"})) or urllib.parse.urlparse(feed_url).hostname or "RSS feed"
        entries = [node for node in root.iter() if _local_name(node.tag) == "item"]
    elif root_name == "feed":
        channel = root
        feed_title = strip_html(_child_text(root, {"title"})) or urllib.parse.urlparse(feed_url).hostname or "Atom feed"
        entries = [node for node in list(root) if _local_name(node.tag) == "entry"]
    else:
        raise FeedValidationError("The response is not an RSS or Atom feed")

    items: List[Dict[str, Any]] = []
    for entry in entries[:500]:
        title = strip_html(_child_text(entry, {"title"}))[:1000]
        summary_raw = _child_text(entry, {"summary", "description"})
        content_raw = _child_text(entry, {"content", "encoded"}) or summary_raw
        link = urllib.parse.urljoin(feed_url, _entry_link(entry))
        external_id = _child_text(entry, {"guid", "id"}) or link or f"{title}:{_child_text(entry, {'pubdate', 'published', 'updated'})}"
        published = _normalise_date(_child_text(entry, {"pubdate", "published", "updated", "date"}))
        if not title and not summary_raw and not content_raw:
            continue
        items.append({
            "external_id": external_id[:2000],
            "title": title or "Untitled feed item",
            "summary": strip_html(summary_raw)[:5000],
            "content": strip_html(content_raw)[:30000],
            "source_url": link[:4000],
            "published_at": published,
        })
    return {"title": feed_title[:300], "url": feed_url, "items": items}


def fetch_feed(url: str, timeout_seconds: int = 15) -> Dict[str, Any]:
    safe_url = validate_public_feed_url(url, resolve=True)
    request = urllib.request.Request(
        safe_url,
        headers={"User-Agent": "AI-OS/1.0 RSS Connector", "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml"},
    )
    opener = urllib.request.build_opener(_SafeRedirectHandler())
    bounded_timeout = min(max(5, timeout_seconds), 15)
    try:
        with opener.open(request, timeout=bounded_timeout) as response:
            final_url = validate_public_feed_url(response.geturl(), resolve=True)
            payload = response.read(MAX_FEED_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise FeedValidationError(f"Feed could not be fetched: {exc}") from exc
    if len(payload) > MAX_FEED_BYTES:
        raise FeedValidationError("Feed response exceeds the 2 MB safety limit")
    return parse_feed(payload, final_url)
