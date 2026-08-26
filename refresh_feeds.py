#!/usr/bin/env python3
"""Refresh bundled podcast data for Caster.

Fetches each show's RSS feed, parses the essentials (title, artwork, and per
episode: guid, title, audio URL, duration, publish date), and writes
`feeds.json`. The app loads this static file — no CORS, no proxy, no runtime
fetching of feeds. Playback uses the audio URLs directly, which works
cross-origin without any special headers.

Usage:
    python3 refresh_feeds.py

Then commit + push feeds.json; GitHub Pages rebuilds and the app picks up new
episodes on next load.

Add or remove shows by editing the FEEDS list below (RSS URL is enough; title
is optional and just for readability).
"""
import email.utils
import json
import sys
import urllib.request
import xml.etree.ElementTree as ET

MAX_EPS_PER_SHOW = 1000          # cap to keep feeds.json lean (1000 eps ≈ ~350KB)
TIMEOUT = 30

# --- your shows: paste any podcast RSS URL ---------------------------------
FEEDS = [
    # "The Flop House" — the sleep-time staple
    "https://feeds.simplecast.com/EOAFriME",
]
# ---------------------------------------------------------------------------

UA = "CasterRefresh/1.0 (+https://github.com/jalamb5/caster)"


def localname(tag):
    """Strip XML namespace: '{http://...}duration' -> 'duration'."""
    return tag.rsplit('}', 1)[-1] if tag.startswith('{') else tag


def find_child(el, name):
    for child in el:
        if localname(child.tag) == name:
            return child
    return None


def find_all(el, name):
    return [c for c in el if localname(c.tag) == name]


def text(el):
    return (el.text or '').strip() if el is not None else ''


def parse_duration(s):
    s = s.strip()
    if not s:
        return 0
    if s.isdigit():
        return int(s)
    parts = [int(p) for p in s.split(':')]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return 0


def parse_pubdate(s):
    try:
        dt = email.utils.parsedate_to_datetime(s.strip())
        return int(dt.timestamp() * 1000)
    except Exception:
        return 0


def fetch_feed(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def parse_feed(url, raw):
    root = ET.fromstring(raw)
    channel = find_child(root, 'channel') or root

    title = text(find_child(channel, 'title')) or url
    author = text(find_child(channel, 'author'))
    if not author:
        author = text(find_child(channel, 'creator'))

    artwork = ''
    iimg = find_child(channel, 'image')          # itunes:image has href attr
    if iimg is not None:
        artwork = iimg.get('href') or ''
    if not artwork:
        img = find_child(channel, 'image')       # plain <image><url>...
        if img is not None:
            artwork = text(find_child(img, 'url'))

    episodes = []
    seen = set()
    for item in find_all(channel, 'item'):
        enc = find_child(item, 'enclosure')
        if enc is None:
            enc = find_child(item, 'content')    # media:content fallback
        if enc is None:
            continue
        url_ = enc.get('url', '')
        if not url_:
            continue
        guid = text(find_child(item, 'guid')) or url_
        guid = guid.strip()
        if guid in seen:
            continue
        seen.add(guid)
        episodes.append({
            'guid': guid,
            'title': text(find_child(item, 'title')),
            'url': url_,
            'duration': parse_duration(text(find_child(item, 'duration'))),
            'pubDate': parse_pubdate(text(find_child(item, 'pubDate'))),
        })

    episodes.sort(key=lambda e: e['pubDate'], reverse=True)
    episodes = episodes[:MAX_EPS_PER_SHOW]
    return {'feedUrl': url, 'title': title, 'author': author,
            'artwork': artwork, 'episodes': episodes}


def main():
    shows = []
    total = 0
    for url in FEEDS:
        print(f"fetching {url} ...", end=' ', flush=True)
        try:
            show = parse_feed(url, fetch_feed(url))
            shows.append(show)
            total += len(show['episodes'])
            print(f"OK — {show['title']} ({len(show['episodes'])} eps)")
        except Exception as e:
            print(f"FAILED: {e}")
            sys.exit(1)

    import datetime
    data = {'updated': datetime.datetime.now(datetime.timezone.utc)
            .strftime('%Y-%m-%dT%H:%M:%SZ'),
            'shows': shows}
    with open('feeds.json', 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

    size = __import__('os').path.getsize('feeds.json')
    print(f"\nwrote feeds.json: {len(shows)} show(s), {total} episodes, "
          f"{size/1024:.0f} KB")
    print("Commit and push feeds.json to update the hosted app.")


if __name__ == '__main__':
    main()
